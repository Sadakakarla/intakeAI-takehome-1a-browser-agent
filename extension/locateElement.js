// The generic single-element locator. Used whenever the agent needs to find a UI element on an
// unknown platform by what it's for, not by a literal label string — e.g. "the control that
// creates a new Visit," which might be labeled "Add Visit," "New Visit," "+," or a bare icon on
// an unseen platform.
//
// Two-tier design, added after an audit found this was the one place in the project NOT already
// following its own cheap-before-expensive principle (already used elsewhere: orient.js's
// dead-click check, confirmVisible.js's structural-scan-first design). Tier 1 asks a free
// text-only model (gpt-oss-120b) to resolve the match from the candidate label manifest alone —
// no image, no vision-quota cost. Tier 2, the original vision call against qwen, only fires when
// tier 1 isn't confidently resolvable (an icon-only control, ambiguous duplicate labels, etc.).
// Both tiers share the same response schema, so a caller of locateElement() sees no difference
// in shape regardless of which tier actually answered — only an added `tier` field for
// traceability.

import { visionCallWithRetry, VisionParseError } from "./vision-call.js";
import { SAFE_VISION_MAX_TOKENS } from "./groq-client.js";

// Tier 1: free, text-only. Deliberately the strongest text-reasoning model in the free catalog
// (see the project's model-assignment table, §9) — this is exactly the kind of "text-only
// judgment, not a new page read" role that model was originally intended for.
const TEXT_TIER_MODEL = "openai/gpt-oss-120b";
const TEXT_TIER_CALL_OPTIONS = {
  response_format: { type: "json_object" },
  reasoning_format: "hidden",
  // Reasoning over a short label manifest is far cheaper than reasoning over an image, so this
  // is set well below the vision tier's 1500 — not yet separately load-tested against this
  // account's real ceiling for gpt-oss-120b specifically, flagged as an assumption to verify on
  // first live run, the same way qwen's budgets were confirmed live rather than assumed.
  max_tokens: 800,
};

// Stricter than the 0.6 floor callers of locateElement() apply afterward (see createVisit.js) —
// skipping the vision safety net entirely on label text alone is a stronger claim than an
// ordinary locate result, so a higher bar is required before trusting it without ever looking at
// the actual screen.
const TEXT_TIER_CONFIDENCE_THRESHOLD = 0.75;

// Tier 2: vision fallback, unchanged from the original single-tier design.
const LOCATE_MODEL = "qwen/qwen3.6-27b";
const LOCATE_CALL_OPTIONS = {
  response_format: { type: "json_object" },
  reasoning_format: "parsed",
  // Disables qwen3.6-27b's internal "thinking" phase entirely — confirmed supported via Groq's
  // current API docs. Real, acknowledged tradeoff: the one captured reasoning trace showed the
  // model needed deliberation to correct an initial wrong instinct. Needs real accuracy
  // verification, not just "stopped erroring," before being trusted.
  reasoning_effort: "none",
  // Corrected after a live failure: this used to be 4500, on the theory that more headroom was
  // safer. A real run proved the opposite — Groq's own OTPM admission estimate for this exact
  // call landed at ~1116 regardless of a 4500 ceiling, meaning the high number never protected
  // anything and only masked how close every call already ran to the real limit. See
  // groq-client.js's SAFE_VISION_MAX_TOKENS for the full reasoning; every vision call to a Qwen
  // model on this account now shares this one value rather than choosing its own.
  max_tokens: SAFE_VISION_MAX_TOKENS,
};

function formatCandidateManifest(candidates) {
  return candidates
    .map((c) => `#${c.markNumber}: role="${c.role}", label="${c.name || "(no label)"}"`)
    .join("\n");
}

function buildSchemaInstructions(intentDescription, avoidMarks) {
  const avoidText =
    avoidMarks.length > 0
      ? `\nThe following mark numbers were already tried and are known not to be it — do not ` +
        `suggest them again: ${avoidMarks.join(", ")}.`
      : "";
  return (
    `Find the element that best matches this description: ${intentDescription}\n\n` +
    `${avoidText}\n\n` +
    'Reply with a JSON object with exactly these keys: "found" (true or false), "mark_number" ' +
    '(the integer mark number of the best match, required only when "found" is true, otherwise ' +
    'null), "confidence" (a number from 0 to 1), and "reasoning" (one or two sentences ' +
    'explaining the choice). Reply with JSON only.'
  );
}

// Tier 1's prompt: text manifest only, no image. Explicitly tells the model it has no visual
// information, so it can honestly report low confidence for an icon-only or visually-ambiguous
// case rather than guessing — the confidence floor above is what actually protects against a
// wrong guess being trusted, but an honest model saying "I don't know" gets there faster.
function buildTextOnlyLocateMessages(_imageBase64, candidates, avoidMarks, correctionNote, intentDescription) {
  const promptText =
    "You are given a list of interactive elements on a web application screen, described only " +
    "by their role and accessible label — you do NOT have an image of the screen. Judge purely " +
    "from the roles and labels below. If the correct match depends on something only visible in " +
    "an image (an icon with no label, visual position, styling), respond with low confidence " +
    "rather than guessing.\n\n" +
    `${buildSchemaInstructions(intentDescription, avoidMarks)}\n\n` +
    `Elements on this screen:\n${formatCandidateManifest(candidates)}`;

  return [{ role: "user", content: [{ type: "text", text: correctionNote ? `${correctionNote}\n\n${promptText}` : promptText }] }];
}

// Tier 2's prompt: the original image + manifest combination, unchanged from the single-tier
// design.
function buildLocateMessages(imageBase64, candidates, avoidMarks, correctionNote, intentDescription) {
  const promptText =
    "You are looking at a screenshot of a web application screen, with numbered red boxes " +
    "marking every interactive element currently visible.\n\n" +
    `${buildSchemaInstructions(intentDescription, avoidMarks)}\n\n` +
    "Judge by what an element plausibly does (its role, its position, its icon, any visible " +
    "text), not by requiring an exact label match — the platform may use different wording " +
    "than the description above.\n\n" +
    "Decide quickly and directly. Do not exhaustively deliberate between similar-looking " +
    "options — form an initial judgment and confirm it briefly, rather than repeatedly " +
    "reconsidering the same candidates.\n\n" +
    `Marked elements on this screen:\n${formatCandidateManifest(candidates)}`;

  const content = [
    { type: "text", text: correctionNote ? `${correctionNote}\n\n${promptText}` : promptText },
    { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
  ];
  return [{ role: "user", content }];
}

// Shared by both tiers — the response schema is identical regardless of which one answered.
function parseLocateResponse(rawContent, candidates) {
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new VisionParseError(`response was not valid JSON: ${error.message}`);
  }

  if (typeof parsed.found !== "boolean") {
    throw new VisionParseError(`"found" was missing or not a boolean (got: ${JSON.stringify(parsed.found)})`);
  }
  if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new VisionParseError(
      `"confidence" was missing or not a number between 0 and 1 (got: ${JSON.stringify(parsed.confidence)})`
    );
  }
  if (typeof parsed.reasoning !== "string" || parsed.reasoning.trim().length === 0) {
    throw new VisionParseError('"reasoning" was missing or empty');
  }

  let markNumber = null;
  if (parsed.found) {
    markNumber = parsed.mark_number;
    const matchesRealCandidate = candidates.some((c) => c.markNumber === markNumber);
    if (typeof markNumber !== "number" || !matchesRealCandidate) {
      throw new VisionParseError(
        `"found" was true but "mark_number" (${JSON.stringify(parsed.mark_number)}) did not ` +
          "match any real candidate on this screen"
      );
    }
  }

  return { found: parsed.found, markNumber, confidence: parsed.confidence, reasoning: parsed.reasoning };
}

// Finds one UI element on the current screen matching a plain-language description. Tries the
// free text-only tier first; only escalates to the vision tier when text alone isn't confidently
// resolvable. Returns { found, markNumber, confidence, reasoning, servedByModel, tier } — tier is
// "text" or "vision", added purely for traceability, not something callers need to branch on. A
// genuine provider/network failure, or a response that fails to parse even after retry, on
// EITHER tier propagates to the caller unchanged.
export async function locateElement(tabId, candidates, intentDescription, avoidMarks = []) {
  const textResult = await visionCallWithRetry(tabId, candidates, avoidMarks, {
    model: TEXT_TIER_MODEL,
    callOptions: TEXT_TIER_CALL_OPTIONS,
    buildMessages: (imageBase64, cands, marks, correctionNote) =>
      buildTextOnlyLocateMessages(imageBase64, cands, marks, correctionNote, intentDescription),
    parseResponse: parseLocateResponse,
  });

  if (textResult.found && textResult.confidence >= TEXT_TIER_CONFIDENCE_THRESHOLD) {
    return { ...textResult, tier: "text" };
  }

  const visionResult = await visionCallWithRetry(tabId, candidates, avoidMarks, {
    model: LOCATE_MODEL,
    callOptions: LOCATE_CALL_OPTIONS,
    buildMessages: (imageBase64, cands, marks, correctionNote) =>
      buildLocateMessages(imageBase64, cands, marks, correctionNote, intentDescription),
    parseResponse: parseLocateResponse,
  });
  return { ...visionResult, tier: "vision" };
}