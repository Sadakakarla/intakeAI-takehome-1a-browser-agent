// Decides whether the current screen already looks like the target form's own editor — a field
// palette, a canvas of already-added fields, and a properties panel — as opposed to a list/table
// screen (e.g. a form's row in a Source Documents table) that merely mentions the form's name.
//
// This exists because "find and click the control that opens the editor" only makes sense the
// first time a form is entered. Once already inside its editor — the normal case once several
// fields are built back to back without navigating away in between — there is no correct target
// for that click at all, and forcing one produces a wrong, sometimes destructive guess: on this
// project's own real runs, a misfired version of that click has landed on a back-navigation
// control and, separately, on an unrelated page tab. A wrong click of that kind risks triggering
// the platform's navigate-away-wipes-drafts behavior for no reason, and — worse — lets whatever
// runs next answer a real question (does a "radio" element exist here?) about the wrong screen,
// which can silently poison a cached fact that was otherwise correct.
//
// Deliberately framed around the STRUCTURAL PATTERN of a form editor (a type palette, a canvas,
// a properties panel) rather than any specific label a platform happens to use for these — Mock
// A calls its properties panel "Options"; a different platform might not — so this holds up on
// an unseen platform rather than encoding this one's vocabulary.
//
// Two-tier, same cost discipline already used elsewhere in this project for LOCATE: a free,
// text-only reasoning call over the perceived candidates' roles and labels is tried first; only
// when that is genuinely inconclusive does a vision call fire. A form/field editor's role
// composition (palette entries, canvas fields, a properties panel's inputs) looks structurally
// different from a list/table screen's role composition even without seeing a rendered image, so
// most screens are expected to resolve from the text tier alone.

import { perceiveCandidates } from "./perception.js";
import { captureFullPageScreenshot } from "./capturePageScreenshot.js";
import { SAFE_VISION_MAX_TOKENS } from "./groq-client.js";
import { callGroqJsonWithRetry } from "./groq-json-retry.js";

const TEXT_MODEL = "openai/gpt-oss-120b";
const VISION_FALLBACK_MODEL = "qwen/qwen3.6-27b";

// Stricter than an ordinary LOCATE confidence floor (0.6) — skipping the vision fallback
// entirely is a stronger claim than an ordinary locate result being trusted, so it's held to a
// higher bar before that safety net is skipped.
const TEXT_CONFIDENCE_FLOOR = 0.75;

function buildManifest(candidates) {
  return candidates
    .map((c) => `#${c.markNumber}: role="${c.role}", label="${c.name || "(no label)"}"`)
    .join("\n");
}

function buildPromptText(formName, manifest) {
  return (
    "You are looking at a description of a web application screen's interactive elements, for " +
    "a study-builder / eSource platform.\n\n" +
    `Decide whether this screen IS ALREADY the field/form EDITOR for the form named "${formName}" ` +
    "— meaning it shows a palette of field/element types that can be added, a canvas or list of " +
    "the form's own already-added fields, and a properties panel for editing a selected field's " +
    "settings (label, type, required, etc.) — as opposed to a LIST or TABLE screen that merely " +
    `shows "${formName}" as a row or item among other forms, with no field-type palette or ` +
    "field-properties panel visible.\n\n" +
    `Elements currently on this screen:\n${manifest}\n\n` +
    'Reply with a JSON object with exactly these keys: "is_editor" (true or false), "confidence" ' +
    '(a number from 0 to 1), and "reasoning" (one or two sentences). Reply with JSON only.'
  );
}

function parseAndValidate(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`response was not valid JSON: ${error.message}`);
  }
  if (typeof parsed.is_editor !== "boolean") {
    throw new Error('"is_editor" was missing or not a boolean');
  }
  if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error('"confidence" was missing or not a number between 0 and 1');
  }
  return parsed;
}

// Returns { isEditor, confidence, reasoning, tier } — tier is "text" or "vision", kept purely
// for traceability so a Record entry can show which evidence actually decided this.
export async function confirmFormEditorScreen(tabId, formName) {
  const candidates = await perceiveCandidates(tabId);
  const manifest = buildManifest(candidates);
  const promptText = buildPromptText(formName, manifest);

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
      isEditor: textParsed.is_editor,
      confidence: textParsed.confidence,
      reasoning: textParsed.reasoning || "(no reasoning given)",
      tier: "text",
    };
  }

  // Tier 1 was inconclusive — fall back to a real screenshot, same fallback shape already used
  // by confirmVisible.js.
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
    isEditor: visionParsed.is_editor,
    confidence: visionParsed.confidence,
    reasoning: visionParsed.reasoning || "(no reasoning given)",
    tier: "vision",
    servedByModel,
  };
}