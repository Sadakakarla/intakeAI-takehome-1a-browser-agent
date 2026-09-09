// Owns every call this extension makes to Groq's chat completions endpoint, going through the
// rate-limit governor on both ends. Extracted from background.js so it can be imported
// independently by any part of the agent that needs to call an LLM (Orient, and later Decide,
// Confirm, and Gate), without those modules needing to depend on background.js itself.
//
// This file, together with governor.js, is the ONLY place in this project that knows anything
// about Groq specifically (response header formats, error shapes, model IDs). Every other
// module calls only the provider-agnostic callGroq(model, messages, options) below and has no
// knowledge of which LLM backend serves it — the assignment's "no hardcoding" / generalize-to-
// unseen-platforms requirement is scoped to the eSource platform being built, not to the LLM
// provider (the assignment explicitly permits "any stack, any model, any API"), but this
// isolation is kept anyway as good architecture regardless.

import { acquireSlot, recordResponse, recordExplicitCooldown, getGovernorSnapshot, BudgetExhaustedError } from "./governor.js";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// Some Groq models enforce an output-tokens-per-minute sub-limit well below their advertised
// combined tokens-per-minute figure, and reject any call whose max_tokens alone would exceed it
// even before rate limiting is a factor. Always specify max_tokens explicitly rather than relying
// on the API's default, and keep it conservative by default; callers with different needs (e.g.
// a vision call that has to reason over a busy image) should override it explicitly per call
// rather than raising this shared default for every caller.
const DEFAULT_MAX_TOKENS = 512;

// Fixed buffer added on top of a call's own requested max_tokens to estimate its total token
// need for the governor's predictive TPM check (see governor.js). Covers the input side (prompt
// text + image), which isn't counted precisely — deliberately generous rather than tuned to any
// one screen's observed cost, since an unseen platform's busier screen is expected to cost more
// input tokens than anything measured against Mock A so far.
const INPUT_TOKEN_BUFFER = 1500;

// This account's real, empirically-confirmed ceiling for a single request's expected output
// tokens on the two Qwen vision models (qwen3.6-27b, qwen3.8-27b), enforced by Groq's own
// output-tokens-per-minute (OTPM) admission check. Confirmed live, twice, from two different call
// sites: declaring max_tokens as high as 1500 or 4500 was rejected at an estimated "Requested" of
// ~1071–1150 regardless of the declared ceiling — Groq's real per-request estimate reflects the
// model's own generation tendency for that prompt, not what we ask for, UNLESS max_tokens itself
// is set low enough to become the binding constraint instead. 700 leaves real margin below the
// ~1000 ceiling once that's the case. Every vision call to either Qwen model must use this, not
// its own independently-chosen number — that's exactly how this bug reached three separate files
// before being caught.
export const SAFE_VISION_MAX_TOKENS = 700;

// Maximum number of times a single rate-limit rejection is retried against the SAME model, using
// the real, authoritative reset time Groq's own rejecting response just reported — not another
// local estimate. This exists as a safety net for when the governor's own proactive TPM wait
// (see governor.js) turns out to have been insufficient, which can genuinely happen: Groq's
// rate-limit windows continuously refill rather than resetting to one fixed full value (see
// governor.js's file header), so the governor's computed wait duration is itself an estimate, not
// a guarantee. Bounded at 1 so a persistently rate-limited account still fails loudly rather than
// retrying forever.
const MAX_RATE_LIMIT_RETRIES = 1;

// Designates a fallback model to retry against, once, when the primary model is either
// temporarily unavailable (a capacity error from Groq's infrastructure) or has exhausted its
// own daily budget. Only vision-capable models have a fallback configured, since that is
// currently the only bucket with a genuine reserve model available.
const CAPACITY_FALLBACK = {
  "qwen/qwen3.8-27b": "qwen/qwen3.6-27b",
};

async function getGroqApiKey() {
  const result = await chrome.storage.local.get(["groqApiKey"]);
  if (!result.groqApiKey) {
    throw new Error(
      "No Groq API key found. Set one on the extension's Options page before running the agent."
    );
  }
  return result.groqApiKey;
}

// Thrown for any non-network failure returned by Groq itself (non-2xx response), carrying
// enough detail for the caller to decide whether it is a transient, fail-over-able condition.
export class GroqCallError extends Error {
  constructor(message, { status, data, retryAfterMs } = {}) {
    super(message);
    this.name = "GroqCallError";
    this.status = status;
    this.data = data;
    // The exact wait time Groq's own rejection just told us, when known (e.g. parsed from an
    // ITPM-specific message) — the single authoritative source for how long to actually wait,
    // rather than a different metric (the general TPM reset) that this project's own live
    // testing just proved can report an unrelated, wrong duration for this specific failure kind.
    this.retryAfterMs = retryAfterMs;
  }
}

// Makes one real attempt at a chat completion call against a specific model, going through the
// rate-limit governor on both ends. Throws BudgetExhaustedError (from the governor) if the
// model's daily budget is exhausted, or GroqCallError for any other non-2xx response.
async function attemptGroqCall(model, messages, options) {
  const apiKey = await getGroqApiKey();

  const requestedMaxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS;
  const expectedTokensNeeded = requestedMaxTokens + INPUT_TOKEN_BUFFER;

  // May throw BudgetExhaustedError if the model's daily request/token budget is exhausted.
  await acquireSlot(model, expectedTokensNeeded);

  const body = {
    model,
    messages,
    max_tokens: DEFAULT_MAX_TOKENS,
    ...options,
  };

  let response;
  try {
    response = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    console.error(`[callGroq] network error calling ${model}:`, networkError);
    throw networkError;
  }

  let data = null;
  try {
    data = await response.json();
  } catch (parseError) {
    console.error(`[callGroq] failed to parse response from ${model}:`, parseError);
  }

  // Groq includes rate-limit headers on both success and error responses, so record them
  // regardless of status code. This also means a rate-limit rejection's own fresh, authoritative
  // reset time is already captured into the governor's state by the time this function returns —
  // attemptGroqCallWithRateLimitRetry below relies on exactly that.
  await recordResponse(model, response.headers, data && data.usage);

  if (!response.ok) {
    const errorMessage = (data && data.error && data.error.message) || `HTTP ${response.status}`;
    console.error(`[callGroq] ${model} returned an error: ${errorMessage}`);

    let retryAfterMs;
    if (errorMessage.toLowerCase().includes("input tokens per minute (itpm)")) {
      const retryMatch = /please try again in ([\d.]+)s/i.exec(errorMessage);
      if (retryMatch) {
        retryAfterMs = Math.ceil(parseFloat(retryMatch[1]) * 1000);
        await recordExplicitCooldown(model, retryAfterMs);
        console.warn(`[callGroq] ${model} hit an ITPM ceiling — recorded a ${retryAfterMs}ms cooldown for future calls`);
      }
    }

    throw new GroqCallError(`Groq API error (${model}): ${errorMessage}`, {
      status: response.status,
      data,
      retryAfterMs,
    });
  }

  return data;
}

// True specifically for a live rate-limit rejection from Groq (as opposed to a capacity issue,
// a bad request, or an auth failure) — the one failure mode attemptGroqCallWithRateLimitRetry
// treats as retryable against the same model.
function isRateLimitError(error) {
  return (
    error instanceof GroqCallError &&
    error.data &&
    error.data.error &&
    error.data.error.code === "rate_limit_exceeded"
  );
}

// Wraps attemptGroqCall with the bounded rate-limit retry described above. Any failure other
// than a live rate-limit rejection, or a second rate-limit rejection after the retry, propagates
// to the caller unchanged.
async function attemptGroqCallWithRateLimitRetry(model, messages, options) {
  let attempt = 0;
  for (;;) {
    try {
      return await attemptGroqCall(model, messages, options);
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= MAX_RATE_LIMIT_RETRIES) throw error;
      attempt += 1;

      // Prefer the exact wait time THIS rejection just reported (error.retryAfterMs) over the
      // general TPM reset — a live run proved these can disagree substantially (a 23s real ITPM
      // reset vs. a 54s general-TPM-derived wait), and using the wrong, larger one only means
      // waiting longer than necessary while the account sits idle for no reason. Falls back to
      // the general TPM reset only when this specific rejection didn't report its own duration.
      let waitMs = error.retryAfterMs;
      if (waitMs === undefined) {
        const state = await getGovernorSnapshot(model);
        waitMs = state.tpmResetAt ? Math.max(0, state.tpmResetAt - Date.now()) + 50 : 5000;
      }
      console.warn(
        `[callGroq] ${model} rate-limited (retry ${attempt}/${MAX_RATE_LIMIT_RETRIES}) — ` +
          `waiting ${waitMs}ms using the reset time from this rejection's own response, then retrying`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// Returns true for failure conditions worth retrying against a fallback model: a genuine
// daily-budget exhaustion, a transient capacity issue on Groq's side, or a live rate-limit-exceeded
// response from Groq itself that has already exhausted its same-model retry above. Does not fail
// over for other errors (bad request shape, auth failure, etc.), since silently retrying those
// against a different model would mask a real bug rather than route around a real, transient
// condition.
function isFailoverEligible(error) {
  if (error instanceof BudgetExhaustedError) return true;
  if (error instanceof GroqCallError) {
    if (error.status === 503 || error.status === 429) return true;
    const message = error.data && error.data.error && error.data.error.message;
    if (typeof message === "string") {
      const lowerMessage = message.toLowerCase();
      if (lowerMessage.includes("over capacity") || lowerMessage.includes("rate limit reached")) {
        return true;
      }
    }
  }
  return false;
}

// Sends a chat completion request to Groq for the given model. Every Groq call in this
// extension must go through this function rather than calling fetch() directly, so the
// governor's counters stay accurate.
//
// A live rate-limit rejection against the requested model is retried once against that SAME
// model, using Groq's own real reset time (see attemptGroqCallWithRateLimitRetry). If that still
// fails, or the failure is a different kind (daily budget exhausted, transient capacity issue),
// and a fallback model is configured for it, this retries once against the fallback — which
// itself also gets the same same-model rate-limit-retry treatment. The returned data is tagged
// with servedByModel so callers and the traceability log can record which model actually
// produced the result.
export async function callGroq(model, messages, options = {}) {
  try {
    const data = await attemptGroqCallWithRateLimitRetry(model, messages, options);
    data.servedByModel = model;
    return data;
  } catch (error) {
    const fallbackModel = CAPACITY_FALLBACK[model];
    if (fallbackModel && isFailoverEligible(error)) {
      console.warn(
        `[callGroq] ${model} unavailable (${error.message}) — failing over to ${fallbackModel}`
      );
      const data = await attemptGroqCallWithRateLimitRetry(fallbackModel, messages, options);
      data.servedByModel = fallbackModel;
      return data;
    }
    throw error;
  }
}

export { BudgetExhaustedError };