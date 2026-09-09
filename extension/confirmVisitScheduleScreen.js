// Decides whether the current screen IS the study's top-level Visit Schedule — a table or list of
// the study's visits, with some way to add a new one — as opposed to anything else the agent might
// be sitting on instead: a single visit's own Source Documents/forms list, a form's own editor, or
// an unrelated screen.
//
// This exists because CREATE VISIT has never had a navigation step at all — it jumps straight to
// locating the "Add Visit" affordance, silently assuming it's already looking at the Visit
// Schedule. That assumption is only ever true for the very first visit of a run, because Orient
// happens to land there; a real run proved this wasn't hypothetical for any visit after the
// first — after the first visit's forms were built, the driver was left sitting on that visit's
// own Source Documents list, with no way back to the top level, and CREATE VISIT correctly (but
// unhelpfully) reported no "Add Visit" control on a screen that genuinely doesn't have one. This
// check, plus the bounded navigate-up loop in createVisit.js that uses it, closes that gap the
// same way confirmFormEditorScreen.js and confirmSourceDocumentsScreen.js already closed the
// analogous ones for CREATE FIELD and CREATE FORM.
//
// Deliberately framed around the STRUCTURAL PATTERN (a list of the study's visits, plus an
// add-new affordance) rather than any platform-specific label, so it generalizes. Same two-tier
// cost discipline as its two siblings: free text-only reasoning first, a vision call only when
// that's genuinely inconclusive.

import { perceiveCandidates } from "./perception.js";
import { captureFullPageScreenshot } from "./capturePageScreenshot.js";
import { SAFE_VISION_MAX_TOKENS } from "./groq-client.js";
import { callGroqJsonWithRetry } from "./groq-json-retry.js";

const TEXT_MODEL = "openai/gpt-oss-120b";
const VISION_FALLBACK_MODEL = "qwen/qwen3.6-27b";

// Same rationale as its two siblings: stricter than an ordinary LOCATE floor (0.6), since skipping
// the vision fallback is a stronger claim than an ordinary locate result.
const TEXT_CONFIDENCE_FLOOR = 0.75;

function buildManifest(candidates) {
  return candidates
    .map((c) => `#${c.markNumber}: role="${c.role}", label="${c.name || "(no label)"}"`)
    .join("\n");
}

function buildPromptText(manifest) {
  return (
    "You are looking at a description of a web application screen's interactive elements, for " +
    "a study-builder / eSource platform.\n\n" +
    "Decide whether this screen IS the study's top-level Visit Schedule — meaning it shows a " +
    'table or list of the study\'s clinical trial visits (by whatever name the platform uses — ' +
    '"visits," "schedule," "timeline"), together with some way to add a new one — as opposed to ' +
    "anything else the agent might be looking at instead: a single visit's own Source Documents " +
    "or forms list, a single form's own editor (a field-type palette and a canvas of fields), or " +
    "an unrelated screen.\n\n" +
    `Elements currently on this screen:\n${manifest}\n\n` +
    'Reply with a JSON object with exactly these keys: "is_visit_schedule" (true or false), ' +
    '"confidence" (a number from 0 to 1), and "reasoning" (one or two sentences). Reply with ' +
    "JSON only."
  );
}

function parseAndValidate(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`response was not valid JSON: ${error.message}`);
  }
  if (typeof parsed.is_visit_schedule !== "boolean") {
    throw new Error('"is_visit_schedule" was missing or not a boolean');
  }
  if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error('"confidence" was missing or not a number between 0 and 1');
  }
  return parsed;
}

// Returns { isVisitSchedule, confidence, reasoning, tier } — tier is "text" or "vision", kept
// purely for traceability.
export async function confirmVisitScheduleScreen(tabId) {
  const candidates = await perceiveCandidates(tabId);
  const manifest = buildManifest(candidates);
  const promptText = buildPromptText(manifest);

  const { parsed: textParsed } = await callGroqJsonWithRetry(
    TEXT_MODEL,
    (correctionNote) => [
      { role: "user", content: correctionNote ? `${correctionNote}\n\n${promptText}` : promptText },
    ],
    { response_format: { type: "json_object" }, reasoning_format: "hidden", max_tokens: 800 },
    parseAndValidate
  );

  if (textParsed.confidence >= TEXT_CONFIDENCE_FLOOR) {
    return {
      isVisitSchedule: textParsed.is_visit_schedule,
      confidence: textParsed.confidence,
      reasoning: textParsed.reasoning || "(no reasoning given)",
      tier: "text",
    };
  }

  const { imageBase64 } = await captureFullPageScreenshot(tabId);

  const { parsed: visionParsed, servedByModel } = await callGroqJsonWithRetry(
    VISION_FALLBACK_MODEL,
    (correctionNote) => [
      {
        role: "user",
        content: [
          { type: "text", text: correctionNote ? `${correctionNote}\n\n${promptText}` : promptText },
          { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      },
    ],
    { response_format: { type: "json_object" }, reasoning_format: "hidden", max_tokens: SAFE_VISION_MAX_TOKENS },
    parseAndValidate
  );

  return {
    isVisitSchedule: visionParsed.is_visit_schedule,
    confidence: visionParsed.confidence,
    reasoning: visionParsed.reasoning || "(no reasoning given)",
    tier: "vision",
    servedByModel,
  };
}