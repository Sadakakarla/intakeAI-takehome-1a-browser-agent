// Shared control flow for every vision-based JSON call in this project. Two distinct failure
// types get separately-bounded retries, not one shared budget: a schema-parse failure
// (VisionParseError) is likely a deterministic prompt/schema issue, so one informed correction is
// the standing principle; an empty-generation failure (the model exhausted its reasoning budget
// and produced nothing) has been directly proven stochastic across three independent occurrences
// (§15w, §15x, and a live run where the identical prompt succeeded once, then failed twice in
// the same run) — the same call can succeed or fail on functionally identical attempts, so it
// gets more chances, since "try again" is a genuinely reasonable response to proven randomness in
// a way it would not be for a deterministic mistake.

import { captureAnnotatedScreenshot } from "./som-overlay.js";
import { callGroq } from "./groq-client.js";

export class VisionParseError extends Error {}

function isEmptyGenerationError(error) {
  return Boolean(
    error &&
      error.data &&
      error.data.error &&
      error.data.error.code === "json_validate_failed" &&
      error.data.error.failed_generation === ""
  );
}

const MAX_EMPTY_GENERATION_RETRIES = 2;
const MAX_PARSE_RETRIES = 1;

export async function visionCallWithRetry(
  tabId,
  candidates,
  avoidMarks,
  { model, callOptions, buildMessages, parseResponse }
) {
  const { imageBase64 } = await captureAnnotatedScreenshot(tabId, candidates);

  let correctionNote = null;
  let emptyGenerationRetries = 0;
  let parseRetries = 0;

  for (;;) {
    const messages = buildMessages(imageBase64, candidates, avoidMarks, correctionNote);

    let response;
    try {
      response = await callGroq(model, messages, callOptions);
    } catch (error) {
      if (isEmptyGenerationError(error) && emptyGenerationRetries < MAX_EMPTY_GENERATION_RETRIES) {
        emptyGenerationRetries += 1;
        console.warn(
          `[vision-call] model exhausted its token budget on reasoning and produced no output ` +
            `(retry ${emptyGenerationRetries}/${MAX_EMPTY_GENERATION_RETRIES}) — retrying with a ` +
            `concision nudge: ${error.message}`
        );
        correctionNote =
          "Your previous attempt used its entire token budget deliberating and produced no " +
          "answer. This time, decide more quickly and directly — do not go back and forth at " +
          "length between similar options; make your best judgment promptly.";
        continue;
      }
      throw error; // a genuine, non-retryable provider/network failure, or retries exhausted
    }

    const content = response.choices[0].message.content;
    try {
      const parsed = parseResponse(content, candidates);
      return { ...parsed, servedByModel: response.servedByModel };
    } catch (parseError) {
      if (parseError instanceof VisionParseError && parseRetries < MAX_PARSE_RETRIES) {
        parseRetries += 1;
        console.warn(
          `[vision-call] response failed to parse, retrying (${parseRetries}/${MAX_PARSE_RETRIES}): ${parseError.message}`
        );
        correctionNote =
          `Your previous response could not be used: ${parseError.message}. ` +
          "Follow the required JSON schema exactly this time.";
        continue;
      }
      throw parseError;
    }
  }
}