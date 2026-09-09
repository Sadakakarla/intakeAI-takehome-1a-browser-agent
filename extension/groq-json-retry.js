// Shared retry wrapper for the simple, non-vision-specific JSON classification calls used across
// confirmFormEditorScreen.js, confirmSourceDocumentsScreen.js, confirmVisitScheduleScreen.js, and
// confirmVisible.js — each asks the model a single yes/no-plus-confidence-plus-reasoning question
// and parses a small, fixed JSON shape, unlike vision-call.js's locate-specific,
// screenshot-annotated, mark-number-validating flow, so this is a separate, simpler helper rather
// than a forced reuse of that one.
//
// This closes a gap disclosed as an open item long before this session started ("confirmFormEditor
// Screen.js's JSON-mode calls don't yet have the same malformed-JSON retry protection vision-
// call.js has elsewhere") — never fixed, and it went on to propagate into three more new sibling
// files built this session, all sharing the identical unprotected pattern, before finally causing
// a real, run-ending crash: a live call had the model write `"confidence":0. nine,` instead of a
// numeric value, which Groq's own strict JSON validator rejected outright before this code ever
// received a response to parse.
//
// Handles two closely-related, already-proven-stochastic failure modes the same way, per this
// project's own established principle (see vision-call.js's own header for the original version of
// this argument): Groq rejecting the generation outright because it couldn't produce valid JSON at
// all (code "json_validate_failed" — this covers both a completely empty generation and a
// merely-malformed one like the live incident above, since both are the same underlying failure:
// the model failed to produce usable JSON), and a response that parses as JSON but fails the
// caller's own shape validation. Both retry with a corrective nudge appended to the prompt,
// bounded to a small number of attempts — "try again" is a reasonable response to proven
// randomness, never to a deterministic mistake, which is why this stays tightly bounded rather
// than looping indefinitely.

import { callGroq } from "./groq-client.js";

const MAX_RETRIES = 2;

function isJsonGenerationFailure(error) {
  return Boolean(
    error && error.data && error.data.error && error.data.error.code === "json_validate_failed"
  );
}

// buildMessages(correctionNote) must return a real messages array, with correctionNote (null on
// the first attempt) appended into the prompt however the caller's own prompt is structured.
// parseAndValidate(content) must return the parsed object, or throw with a message describing
// what was wrong — that message becomes the corrective nudge fed back to the model on retry.
// Returns { parsed, servedByModel }.
export async function callGroqJsonWithRetry(model, buildMessages, callOptions, parseAndValidate) {
  let correctionNote = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const messages = buildMessages(correctionNote);

    let response;
    try {
      response = await callGroq(model, messages, callOptions);
    } catch (error) {
      if (isJsonGenerationFailure(error) && attempt < MAX_RETRIES) {
        console.warn(
          `[callGroqJsonWithRetry] Groq rejected the generation as invalid JSON ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying with a corrective nudge: ${error.message}`
        );
        correctionNote =
          "Your previous response was not valid JSON (Groq rejected it outright). Numeric " +
          'fields must contain only digits (e.g. 0.9, never the word "nine"), and the entire ' +
          "output must be syntactically valid JSON with no extra text before or after it.";
        continue;
      }
      throw error;
    }

    const content = response.choices[0].message.content;
    try {
      const parsed = parseAndValidate(content);
      return { parsed, servedByModel: response.servedByModel };
    } catch (parseError) {
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[callGroqJsonWithRetry] response failed validation ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${parseError.message}`
        );
        correctionNote =
          `Your previous response could not be used: ${parseError.message}. Follow the ` +
          "required JSON schema exactly this time.";
        continue;
      }
      throw parseError;
    }
  }
}