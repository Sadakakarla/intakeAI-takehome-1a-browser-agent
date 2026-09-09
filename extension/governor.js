// Groq rate-limit governor.
//
// Design summary:
//  - RPD (requests/day) and TPM (tokens/minute) are read authoritatively from Groq's response
//    headers after every call, rather than estimated locally.
//  - RPM (requests/minute) and TPD (tokens/day) are self-tracked, since Groq does not expose
//    a header for either.
//  - RPM uses exact sliding-window admission control, capped at 29 of the real 30/minute limit —
//    a 1-request margin to absorb clock/network latency between when we timestamp a call
//    locally and when Groq's server actually starts counting it.
//  - RPD and TPD are NOT treated as counters that fully reset to a fresh value once per day.
//    Empirically, Groq's "reset" timers behave like a continuously-refilling token bucket rather
//    than a hard daily wipe: a fresh API key's very first request already showed a reset time of
//    roughly (86,400 seconds / 1,000 daily requests), i.e. the time to regenerate ONE unit of
//    capacity, not the time to refill the whole quota. Both RPD and TPD are therefore handled the
//    same way as TPM: while known-remaining capacity is at or below zero and the last-known reset
//    time hasn't passed, hard-refuse; once it has passed, simply allow the next real call to go
//    through and let its response headers report the true, current state. Local counters are
//    never force-reset to a guessed value.
//  - totalCalls and tpdUsedEstimate are simple lifetime cumulative counters (since this extension
//    started tracking), not daily figures — there is no reliable signal for a true "day boundary"
//    given the above, so no such boundary is simulated.
//  - RPM/TPM/RPD breaches (while their reset timers haven't passed) delay and retry. TPD breaches
//    hard-refuse via BudgetExhaustedError, since it is a much larger cap and a breach is a
//    stronger signal of genuinely heavy usage.
//  - The TPM check is predictive, not reactive: a caller passes expectedTokensNeeded (its
//    max_tokens plus a fixed input-side buffer, computed in groq-client.js), and the governor
//    waits out the TPM window whenever remaining capacity is BELOW that amount — not just when
//    remaining has already hit zero. This closes a real gap found via live testing: remaining
//    capacity can be positive but still smaller than the specific call about to be sent, in
//    which case a purely reactive "wait only at zero" check lets the call through and Groq's own
//    limiter correctly rejects it.
//  - A per-model-bucket mutex serializes the "check budget, then reserve a slot" step, so two
//    concurrent calls to the same model bucket can't both read stale remaining-budget state and
//    both proceed.

const RPM_HARD_CAP = 30;
const RPM_ADMIT_CEILING = 29; // see file header: margin for clock/latency slop
console.assert(
  RPM_ADMIT_CEILING < RPM_HARD_CAP,
  "[Governor] RPM_ADMIT_CEILING must stay below RPM_HARD_CAP"
);

// Daily token caps for the models this extension uses. These are fixed, known properties of
// our own LLM provider account, not an assumption about the target platform being built.
const TPD_CAPS = {
  "openai/gpt-oss-120b": 200000,
  "qwen/qwen3.6-27b": 200000,
  "qwen/qwen3.8-27b": 200000,
};

// If a rate-limit reset duration from Groq can't be parsed, assume it is far away rather than
// zero. Treating an unparseable value as "already reset" would risk clearing a genuinely active
// exhaustion state early; treating it as far away only costs some throughput, never correctness.
const UNPARSEABLE_DURATION_FALLBACK_MS = 24 * 60 * 60 * 1000;

export class BudgetExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

function storageKey(model) {
  return `governor:${model}`;
}

function defaultState() {
  return {
    rpmTimestamps: [],
    rpdRemaining: null,
    rpdResetAt: null,
    tpmRemaining: null,
    tpmResetAt: null,
    tpdUsedEstimate: 0,
    tpdResetAt: null,
    totalCalls: 0,
    itpmCooldownUntil: null,
  };
}

async function getBucketState(model) {
  const key = storageKey(model);
  try {
    const result = await chrome.storage.local.get([key]);
    return result[key] ? result[key] : defaultState();
  } catch (error) {
    console.error(`[Governor] storage read failed for ${model}:`, error);
    throw new Error(`Governor storage read failed for ${model}: ${error.message}`);
  }
}

async function setBucketState(model, state) {
  try {
    await chrome.storage.local.set({ [storageKey(model)]: state });
  } catch (error) {
    console.error(`[Governor] storage write failed for ${model}:`, error);
    throw new Error(`Governor storage write failed for ${model}: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parses Groq's duration strings into milliseconds. Two formats have been observed:
//   - a plain millisecond value, e.g. "1ms"
//   - an h/m/s composite, e.g. "2m59.56s", "7.66s", "1h2m3s"
// Falls back conservatively and logs a warning if the string matches neither shape, rather
// than silently treating an unparseable value as "no wait needed."
function parseDurationToMs(str) {
  if (!str) return 0;
  const trimmed = str.trim();

  const msMatch = /^([\d.]+)ms$/.exec(trimmed);
  if (msMatch) {
    return Math.round(parseFloat(msMatch[1]));
  }

  const hmsMatch = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(trimmed);
  const matchedSomething = hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3]);
  if (!matchedSomething) {
    console.warn(
      `[Governor] could not parse duration string "${str}" — assuming ${UNPARSEABLE_DURATION_FALLBACK_MS}ms as a conservative fallback`
    );
    return UNPARSEABLE_DURATION_FALLBACK_MS;
  }
  const h = parseFloat(hmsMatch[1] || "0");
  const m = parseFloat(hmsMatch[2] || "0");
  const s = parseFloat(hmsMatch[3] || "0");
  return Math.round((h * 3600 + m * 60 + s) * 1000);
}

// Per-model mutex: chains async work so only one governor operation touches a given bucket's
// state at a time. In-memory only (resets if the service worker is evicted), but the durable
// counts always live in chrome.storage.local regardless.
const mutexChains = new Map();

function withBucketMutex(model, fn) {
  const previous = mutexChains.get(model) || Promise.resolve();
  const run = previous.then(fn, fn);
  mutexChains.set(
    model,
    run.catch(() => {}) // don't let one failure break the chain for subsequent calls
  );
  return run;
}

// Call before sending a request. Waits out RPM/TPM/RPD windows as needed, or throws
// BudgetExhaustedError if the token-per-day budget is exhausted. expectedTokensNeeded is the
// caller's best estimate of how many tokens the upcoming request will consume — the TPM check
// waits until at least this much capacity is available, not just until any capacity is available.
// Defaults to 1, which reproduces the previous "wait only once fully exhausted" behavior for any
// caller that doesn't supply a real estimate, rather than silently changing behavior for it.
export async function acquireSlot(model, expectedTokensNeeded = 1) {
  return withBucketMutex(model, async () => {
    let state = await getBucketState(model);
    let now = Date.now();

    // Hard refuse: TPD exhausted. This is the one case that still hard-refuses outright,
    // since it is a much larger cap (200,000) and breaching it is a strong signal of
    // genuinely heavy usage rather than a brief timing coincidence.
    const tpdCap = TPD_CAPS[model];
    if (
      tpdCap &&
      state.tpdUsedEstimate >= tpdCap &&
      state.tpdResetAt &&
      now < state.tpdResetAt
    ) {
      throw new BudgetExhaustedError(
        `${model}: token budget appears exhausted, next known capacity at ${new Date(state.tpdResetAt).toISOString()}`
      );
    }

    // RPD: wait out the window if the last known state says we're at zero. Once the reset
    // time passes, proceed and let the real call's response report the current truth —
    // never assume a specific replenished value locally.
    if (
      state.rpdRemaining !== null &&
      state.rpdRemaining <= 0 &&
      state.rpdResetAt &&
      now < state.rpdResetAt
    ) {
      const waitMs = state.rpdResetAt - now + 50;
      console.log(`[Governor] ${model}: RPD exhausted, waiting ${waitMs}ms`);
      await sleep(waitMs);
      now = Date.now();
    }

    // Explicit per-bucket cooldown, learned directly from a real, live ITPM (input-tokens-per-
    // minute) rejection — a narrower, separately-enforced ceiling Groq's general TPM header
    // (checked below) does not reliably reflect. Confirmed live: a call proceeded past the TPM
    // check above yet was still rejected specifically on ITPM grounds. Without this, every call
    // site that happens to land in a hot window pays its own full "get rejected, learn the reset
    // time, wait" cost independently, rather than the system remembering a cooldown it already
    // learned a moment earlier from a completely different call — this is why a burst of real
    // usage (e.g., several fields built right before a Stop) could previously cause several
    // consecutive rejections in a row rather than one clean wait.
    if (state.itpmCooldownUntil && now < state.itpmCooldownUntil) {
      const waitMs = state.itpmCooldownUntil - now + 50;
      console.log(`[Governor] ${model}: ITPM cooldown active (learned from a real rejection), waiting ${waitMs}ms`);
      await sleep(waitMs);
      now = Date.now();
    }
  
    // TPM: predictive, not just reactive — waits whenever remaining capacity is below what
    // this specific call is expected to need, not only once remaining has hit zero.
    if (
      state.tpmRemaining !== null &&
      state.tpmRemaining < expectedTokensNeeded &&
      state.tpmResetAt &&
      now < state.tpmResetAt
    ) {
      const waitMs = state.tpmResetAt - now + 50;
      console.log(
        `[Governor] ${model}: TPM insufficient for this call (remaining ${state.tpmRemaining}, ` +
          `needed ${expectedTokensNeeded}), waiting ${waitMs}ms`
      );
      await sleep(waitMs);
      now = Date.now();
    }

    // RPM: exact sliding-window admission control
    state.rpmTimestamps = (state.rpmTimestamps || []).filter((ts) => now - ts < 60000);
    if (state.rpmTimestamps.length >= RPM_ADMIT_CEILING) {
      const oldest = state.rpmTimestamps[0];
      const waitMs = 60000 - (now - oldest) + 50;
      console.log(`[Governor] ${model}: RPM window full, waiting ${waitMs}ms`);
      await sleep(waitMs);
      now = Date.now();
      state.rpmTimestamps = state.rpmTimestamps.filter((ts) => now - ts < 60000);
    }

    // Record this attempt (RPM counts attempts sent, not just successful responses)
    state.rpmTimestamps.push(Date.now());
    state.totalCalls = (state.totalCalls || 0) + 1;
    await setBucketState(model, state);
    return state;
  });
}

// Call after receiving a response. Updates RPD/TPM from Groq's authoritative headers, and adds
// this call's token usage to the local, lifetime TPD estimate.
export async function recordResponse(model, headers, usage) {
  return withBucketMutex(model, async () => {
    const state = await getBucketState(model);
    const now = Date.now();

    const remReq = headers.get("x-ratelimit-remaining-requests");
    const resetReq = headers.get("x-ratelimit-reset-requests");
    const remTok = headers.get("x-ratelimit-remaining-tokens");
    const resetTok = headers.get("x-ratelimit-reset-tokens");

    if (remReq !== null) state.rpdRemaining = parseInt(remReq, 10);
    if (resetReq !== null) {
      state.rpdResetAt = now + parseDurationToMs(resetReq);
      // Reused as a rough "worth rechecking" signal for TPD too, since Groq exposes no
      // dedicated TPD reset timer. See file header: this is a soft proxy, not a guarantee.
      state.tpdResetAt = state.rpdResetAt;
    }
    if (remTok !== null) state.tpmRemaining = parseInt(remTok, 10);
    if (resetTok !== null) state.tpmResetAt = now + parseDurationToMs(resetTok);

    if (usage && typeof usage.total_tokens === "number") {
      state.tpdUsedEstimate = (state.tpdUsedEstimate || 0) + usage.total_tokens;
    }

    await setBucketState(model, state);
    return state;
  });
}

// Exposed for the side panel's call counter and for debugging.
export async function getGovernorSnapshot(model) {
  return getBucketState(model);
}

// Records a real, live ITPM rejection's own reported reset time as an explicit per-model
// cooldown, checked by acquireSlot on every future call to this bucket — not just the one call
// that got rejected. Never shortens an existing, still-active cooldown, only extends or sets one
// fresh, since two rejections arriving close together should leave the LATER, longer wait in
// effect.
export async function recordExplicitCooldown(model, waitMs) {
  return withBucketMutex(model, async () => {
    const state = await getBucketState(model);
    const candidate = Date.now() + waitMs;
    if (!state.itpmCooldownUntil || candidate > state.itpmCooldownUntil) {
      state.itpmCooldownUntil = candidate;
      await setBucketState(model, state);
    }
    return state;
  });
}

// Clears all locally-remembered rate-limit state for every tracked model. Needed whenever the
// Groq API key changes — governor state is keyed by model name only (see storageKey above), with
// no awareness of which account it was learned against, so swapping keys without this leaves the
// extension trusting a previous account's exhaustion/remaining-capacity facts against a fresh
// one's real quota. Exported rather than folded into options.js's save handler directly, so it
// can also be called manually from the console the same way resetTypeMappingCache() already is.
export async function resetGovernorState(models) {
  await chrome.storage.local.remove(models.map(storageKey));
}