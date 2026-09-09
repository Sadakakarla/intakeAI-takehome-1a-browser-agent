// Decides whether the current screen looks like a visit's own Source Documents / forms list — a
// table or list of the forms already built under one specific visit, with some way to add a new
// one — as opposed to anything else the agent might have accidentally landed on instead: a
// single form's own editor, a Preview modal, the study's top-level visit list, or an unrelated
// screen.
//
// This exists because CREATE FORM's first step (navigate to the visit's documents area) had no
// way to verify its own click actually landed where it meant to. On a real run, that click
// matched "Preview Form" instead of the intended back-navigation control — a genuine near-miss,
// not a hypothetical one — and because nothing checked the result, every subsequent step kept
// operating against that wrong screen, each failing for what looked like unrelated reasons, until
// the circuit breaker caught the pattern five escalations later. This check closes that gap the
// same way confirmFormEditorScreen.js already closed the analogous one for CREATE FIELD.
//
// Deliberately framed around the STRUCTURAL PATTERN (a list of named forms scoped to one visit,
// plus an add-new affordance) rather than any platform-specific label, so it generalizes. Same
// two-tier cost discipline as confirmFormEditorScreen.js: free text-only reasoning first, a vision
// call only when that's genuinely inconclusive.

import { perceiveCandidates } from "./perception.js";
import { captureFullPageScreenshot } from "./capturePageScreenshot.js";
import { SAFE_VISION_MAX_TOKENS } from "./groq-client.js";
import { callGroqJsonWithRetry } from "./groq-json-retry.js";

const TEXT_MODEL = "openai/gpt-oss-120b";
const VISION_FALLBACK_MODEL = "qwen/qwen3.6-27b";

// Same rationale as confirmFormEditorScreen.js: stricter than an ordinary LOCATE floor (0.6),
// since skipping the vision fallback is a stronger claim than an ordinary locate result.
const TEXT_CONFIDENCE_FLOOR = 0.75;

function buildManifest(candidates) {
  return candidates
    .map((c) => `#${c.markNumber}: role="${c.role}", label="${c.name || "(no label)"}"`)
    .join("\n");
}

function buildPromptText(visitName, manifest) {
  return (
    "You are looking at a description of a web application screen's interactive elements, for " +
    "a study-builder / eSource platform.\n\n" +
    `Decide whether this screen IS the Source Documents / forms LIST for the visit named ` +
    `"${visitName}" — meaning it shows a table or list of the forms already built under this ` +
    'one specific visit (by whatever name the platform uses — "documents," "forms," "source ' +
    'documents"), together with some way to add a new one — as opposed to anything else the ' +
    "agent might have accidentally landed on instead: a single form's own editor (a field-type " +
    "palette and a canvas of fields), a preview or modal overlay of one form's content, the " +
    "study's top-level list of visits, or an unrelated screen.\n\n" +
    `Elements currently on this screen:\n${manifest}\n\n` +
    'Reply with a JSON object with exactly these keys: "is_documents_list" (true or false), ' +
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
  if (typeof parsed.is_documents_list !== "boolean") {
    throw new Error('"is_documents_list" was missing or not a boolean');
  }
  if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error('"confidence" was missing or not a number between 0 and 1');
  }
  return parsed;
}

// Returns { isDocumentsList, confidence, reasoning, tier } — tier is "text" or "vision", kept
// purely for traceability so a Record entry can show which evidence actually decided this.
export async function confirmSourceDocumentsScreen(tabId, visitName) {
  const candidates = await perceiveCandidates(tabId);
  const manifest = buildManifest(candidates);
  const promptText = buildPromptText(visitName, manifest);

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
      isDocumentsList: textParsed.is_documents_list,
      confidence: textParsed.confidence,
      reasoning: textParsed.reasoning || "(no reasoning given)",
      tier: "text",
    };
  }

  // Tier 1 was inconclusive — fall back to a real screenshot, same fallback shape already used
  // by confirmFormEditorScreen.js and confirmVisible.js.
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
    isDocumentsList: visionParsed.is_documents_list,
    confidence: visionParsed.confidence,
    reasoning: visionParsed.reasoning || "(no reasoning given)",
    tier: "vision",
    servedByModel,
  };
}