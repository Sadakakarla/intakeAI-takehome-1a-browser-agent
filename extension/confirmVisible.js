// Confirms whether specific text is actually present on the current screen, using a structural
// scan first and a vision-based fallback only when that scan is genuinely inconclusive. This is
// deliberately NOT vision-first: "is this exact string present anywhere" has a deterministic
// answer once all rendered text can be read, and defaulting to a vision call would add
// hallucination risk to a question that doesn't need it. Vision is reserved for the case a
// structural scan cannot resolve — mirroring the same escalate-on-ambiguity philosophy already
// used for GATE, applied here to a read-back rather than an action decision.

import { getAllAccessibleText } from "./perception.js";
import { captureFullPageScreenshot } from "./capturePageScreenshot.js";
import { SAFE_VISION_MAX_TOKENS } from "./groq-client.js";
import { callGroqJsonWithRetry } from "./groq-json-retry.js";

const VISION_FALLBACK_MODEL = "qwen/qwen3.6-27b";

// True if every fragment in expectedFragments appears, case-insensitively, as a substring of at
// least one accessible text node. Each fragment is matched independently rather than requiring
// them all on the same node, since a platform might render a visit's name and its window values
// in separate cells/nodes.
function structuralMatch(allText, expectedFragments) {
  const lowerAllText = allText.map((t) => t.toLowerCase());
  return expectedFragments.every((fragment) =>
    lowerAllText.some((text) => text.includes(fragment.toLowerCase()))
  );
}

function parseAndValidate(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`response was not valid JSON: ${error.message}`);
  }
  if (typeof parsed.matches !== "boolean") {
    throw new Error('"matches" was missing or not a boolean');
  }
  return parsed;
}

// Confirms that all of expectedFragments are visible somewhere on the current screen. Tries the
// $0 structural scan first; only falls back to a vision call if it finds no match at all, since
// that could mean either a genuine failure or a platform-specific rendering quirk the
// accessibility tree doesn't expose as plain text (e.g. content drawn into a canvas). Returns
// { matches, method, reasoning, servedByModel? } — method is "structural" or "vision_fallback",
// so a caller can tell which kind of evidence backed the result.
export async function confirmVisible(tabId, expectedFragments, contextDescription) {
  const allText = await getAllAccessibleText(tabId);

  if (structuralMatch(allText, expectedFragments)) {
    return {
      matches: true,
      method: "structural",
      reasoning: `All expected text fragments (${expectedFragments.join(", ")}) were found among the screen's accessible text nodes.`,
    };
  }

  const { imageBase64 } = await captureFullPageScreenshot(tabId);

  const promptText =
    `You are looking at a screenshot of a web application screen. ${contextDescription}\n\n` +
    `Does the screen visibly show all of the following: ${expectedFragments.join(", ")}?\n\n` +
    'Reply with a JSON object with exactly these keys: "matches" (true or false), and ' +
    '"reasoning" (one or two sentences explaining your answer). Reply with JSON only.';

  const { parsed, servedByModel } = await callGroqJsonWithRetry(
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
    matches: parsed.matches,
    method: "vision_fallback",
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "(no reasoning given)",
    servedByModel,
  };
} 