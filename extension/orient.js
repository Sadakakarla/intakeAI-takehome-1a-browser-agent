// Step 0 of the agent's loop. Runs before any real build work begins: confirms the current screen
// is, or leads to, a place where a study's visit schedule can be built. A platform that happens to
// start on a usable screen (as the reference mock does) passes this trivially in one call; the
// real purpose of this step is a platform that does not, where the alternative would be silently
// assuming the starting point generalizes.
//
// Assumes the debugger session for the given tab is already attached — this module does not
// manage its own attach/detach lifecycle, since the agent attaches once per run, not once per
// step.

import { getAxCandidates, getFallbackCandidates, mergeCandidates, perceiveCandidates } from "./perception.js";
import { clickCandidate, screenChangedMaterially } from "./actions.js";
import { visionCallWithRetry, VisionParseError } from "./vision-call.js";
import { sendCommand } from "./debugger-session.js";
import { writeRecord } from "./record.js";

const MAX_HOPS = 4;
const ESCALATION_STORAGE_KEY = "escalationLog";

import { SAFE_VISION_MAX_TOKENS } from "./groq-client.js";
// The model this step calls. qwen/qwen3.6-27b is requested directly, not qwen/qwen3.8-27b, to
// avoid paying for a guaranteed automatic failover hop — both models share the same real
// ~1,000-token-per-minute output ceiling on this account (see CLASSIFICATION_CALL_OPTIONS below
// for how this call now stays under it). An earlier version of this comment claimed only 3.8 had
// this constraint; a live failure on 3.6 itself proved that assumption wrong.
const CLASSIFICATION_MODEL = "qwen/qwen3.6-27b";

const CLASSIFICATION_CALL_OPTIONS = {
  response_format: { type: "json_object" },
  reasoning_format: "hidden",
  // Disables qwen3.6-27b's internal reasoning phase entirely — the same fix locateElement.js's
  // Tier 2 already found and proved live, applied here after this call hit the identical failure
  // it was designed to prevent: reasoning_format: "hidden" only hides reasoning from the parsed
  // response, it does not stop the model from generating it, and Groq's real per-request output-
  // token ceiling on this account (~1000 tokens for this model) is budgeted against that
  // generation regardless of whether it's ever shown. A real run hit exactly this — a
  // "Request too large... on output tokens per minute (OTPM)" rejection — before this fix landed.
  // Real, disclosed tradeoff (same one locateElement.js already accepted, not new to this call):
  // the model loses a deliberation step that could, in principle, correct an initial wrong
  // instinct. Not yet separately accuracy-verified for this specific call — worth watching for a
  // classification that looks confidently wrong, not just "stopped crashing," on early runs.
  reasoning_effort: "none",
  // See groq-client.js's SAFE_VISION_MAX_TOKENS for the full reasoning behind this number — it
  // was first proven here, then confirmed by a second independent failure in locateElement.js at
  // a much higher declared ceiling (4500), which is what showed the real mechanism: Groq's OTPM
  // admission estimate reflects the model's own generation tendency for a given prompt, not the
  // declared max_tokens, unless max_tokens itself is set low enough to become the binding
  // constraint. Every vision call to a Qwen model on this account now shares this one value.
  max_tokens: SAFE_VISION_MAX_TOKENS,
};

const VALID_CLASSIFICATIONS = new Set(["USABLE", "NAVIGABLE", "UNKNOWN"]);

// Thrown when Orient cannot find or reach a usable screen and must hand control to a human. The
// caller (the run's top-level driver) is expected to catch this, treat it the same way as any
// other mid-run graceful stop, and leave the run in a safe, resumable state rather than treating
// it as a crash.
export class OrientEscalatedError extends Error {
  constructor(reason, details = {}) {
    super(`Orient escalated: ${reason}`);
    this.name = "OrientEscalatedError";
    this.reason = reason;
    this.details = details;
  }
}

function formatCandidateManifest(candidates) {
  return candidates
    .map((c) => `#${c.markNumber}: role="${c.role}", label="${c.name || "(no label)"}"`)
    .join("\n");
}

// Builds the classification prompt. correctionNote, when present, is prepended so a retry after a
// parse failure tells the model plainly what was wrong with its previous answer rather than
// silently repeating the identical question.
function buildClassificationMessages(imageBase64, candidates, avoidMarks, correctionNote) {
  const avoidText =
    avoidMarks.length > 0
      ? `\nThe following mark numbers were already tried on this screen and did not lead ` +
        `anywhere new — do not suggest them again: ${avoidMarks.join(", ")}.`
      : "";

  const promptText =
    "You are looking at a screenshot of a web application screen, with numbered red boxes " +
    "marking every interactive element currently visible. Decide whether this screen is, or " +
    "leads toward, a place where a user could create and manage a schedule of clinical trial " +
    "visits (each visit later containing its own set of source documents/forms).\n\n" +
    'Classify the screen as exactly one of "USABLE", "NAVIGABLE", or "UNKNOWN":\n' +
    "- USABLE: this screen already shows, or effectively is, a visit/study-schedule " +
    "management view — for example a table or list of visits, with some way to add a new one.\n" +
    "- NAVIGABLE: not that view yet, but one specific marked element plausibly leads toward " +
    "one (e.g. a navigation link or button related to studies, protocols, visits, or " +
    "scheduling).\n" +
    "- UNKNOWN: neither — nothing on this screen plausibly leads toward visit/study " +
    "management (e.g. a login screen, or an unrelated page).\n\n" +
    `Marked elements on this screen:\n${formatCandidateManifest(candidates)}${avoidText}\n\n` +
    'Reply with a JSON object with exactly these keys: "classification" (one of the three ' +
    'values above), "mark_number" (the integer mark number to click next, required only when ' +
    'classification is "NAVIGABLE", otherwise null), "confidence" (a number from 0 to 1), and ' +
    '"reasoning" (one or two sentences explaining the classification). Reply with JSON only.';

  const content = [
    { type: "text", text: correctionNote ? `${correctionNote}\n\n${promptText}` : promptText },
    { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
  ];

  return [{ role: "user", content }];
}

// Validates a parsed classification response against the required shape. Groq's JSON mode
// guarantees syntactically valid JSON, not that it contains our specific keys — every field is
// checked explicitly rather than trusted, and a NAVIGABLE mark_number is checked against the
// real candidate list, not just checked for being a number.
function parseClassificationResponse(rawContent, candidates) {
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new VisionParseError(`response was not valid JSON: ${error.message}`);
  }

  if (!VALID_CLASSIFICATIONS.has(parsed.classification)) {
    throw new VisionParseError(
      '"classification" was missing or not one of USABLE/NAVIGABLE/UNKNOWN ' +
        `(got: ${JSON.stringify(parsed.classification)})`
    );
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
  if (parsed.classification === "NAVIGABLE") {
    markNumber = parsed.mark_number;
    const matchesRealCandidate = candidates.some((c) => c.markNumber === markNumber);
    if (typeof markNumber !== "number" || !matchesRealCandidate) {
      throw new VisionParseError(
        `classification was NAVIGABLE but "mark_number" (${JSON.stringify(parsed.mark_number)}) ` +
          "did not match any real candidate on this screen"
      );
    }
  }

  return {
    classification: parsed.classification,
    markNumber,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
  };
}

// Runs one classification call against the current screen via the shared vision-call helper,
// which handles screenshot capture and the one-informed-retry-on-parse-failure logic generically.
function classifyScreen(tabId, candidates, avoidMarks) {
  return visionCallWithRetry(tabId, candidates, avoidMarks, {
    model: CLASSIFICATION_MODEL,
    callOptions: CLASSIFICATION_CALL_OPTIONS,
    buildMessages: buildClassificationMessages,
    parseResponse: parseClassificationResponse,
  });
}

// Writes one Orient Record entry (ir_path is null — Orient's outcome doesn't correspond to any
// real input-file entry) and, when the outcome is an escalation, also appends a plain-text line
// to the escalation log the side panel renders, then throws so the caller halts the run cleanly.
// This is a deliberately minimal, temporary escalation surface; a real interactive queue is later
// work — this exists so Orient's escalation path has somewhere concrete to surface to now.
async function recordAndMaybeEscalate({
  actionTaken,
  reasoning,
  confidence,
  gateOutcome,
  confirmResult,
  escalationReason,
  escalationDetails,
}) {
  await writeRecord({
    ir_path: null,
    step: "orient",
    action_taken: actionTaken,
    decide_reasoning: reasoning,
    confidence,
    gate_outcome: gateOutcome,
    confirm_result: confirmResult,
  });

  if (gateOutcome !== "escalated") return;

  const { [ESCALATION_STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(ESCALATION_STORAGE_KEY);
  existing.push(`[Orient] ${escalationReason}: ${reasoning}`);
  await chrome.storage.local.set({ [ESCALATION_STORAGE_KEY]: existing });

  throw new OrientEscalatedError(escalationReason, escalationDetails);
}

// Step 0 of the agent's loop. Confirms the current screen is, or leads to, a usable starting
// point for building the study's visit schedule, navigating a bounded number of hops if needed,
// and escalating to a human rather than guessing when it cannot find one.
export async function runOrient(tabId) {
  let candidates = await perceiveCandidates(tabId);

  if (candidates.length === 0) {
    await recordAndMaybeEscalate({
      actionTaken: "orient_structural_precheck",
      reasoning:
        "The initial perception pass found zero interactive candidates on the page — it may " +
        "not have finished loading, or this platform's entry point isn't a normal page.",
      confidence: 1,
      gateOutcome: "escalated",
      confirmResult: "no_candidates_found",
      escalationReason: "orient_blank_page",
      escalationDetails: {},
    });
  }

  const avoidMarks = [];

  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    let result;
    try {
      result = await classifyScreen(tabId, candidates, avoidMarks);
    } catch (error) {
      if (error instanceof VisionParseError) {
        await recordAndMaybeEscalate({
          actionTaken: `orient_classify_hop_${hop}`,
          reasoning: `The classification response could not be parsed even after one retry: ${error.message}`,
          confidence: 0,
          gateOutcome: "escalated",
          confirmResult: "unparseable_response",
          escalationReason: "orient_classification_parse_failure",
          escalationDetails: { hop },
        });
      }
      throw error; // A real Groq/network failure is not Orient's to interpret.
    }

    const { classification: verdict, markNumber, confidence, reasoning, servedByModel } = result;

    if (verdict === "USABLE") {
      await recordAndMaybeEscalate({
        actionTaken: `orient_classify_hop_${hop}`,
        reasoning,
        confidence,
        gateOutcome: "auto",
        confirmResult: `usable_screen_found (model: ${servedByModel})`,
      });
      return;
    }

    if (verdict === "UNKNOWN") {
      await recordAndMaybeEscalate({
        actionTaken: `orient_classify_hop_${hop}`,
        reasoning,
        confidence,
        gateOutcome: "escalated",
        confirmResult: "no_plausible_path_found",
        escalationReason: "orient_dead_end",
        escalationDetails: { hop },
      });
    }

    // verdict === "NAVIGABLE"
    if (hop === MAX_HOPS) {
      await recordAndMaybeEscalate({
        actionTaken: `orient_classify_hop_${hop}`,
        reasoning: `Hop limit (${MAX_HOPS}) reached without finding a usable screen. Last suggestion: ${reasoning}`,
        confidence,
        gateOutcome: "escalated",
        confirmResult: "hop_limit_reached",
        escalationReason: "orient_hop_limit_reached",
        escalationDetails: { hop, lastSuggestedMark: markNumber },
      });
    }

    const candidate = candidates.find((c) => c.markNumber === markNumber);
    const beforeClick = candidates;

    await clickCandidate(tabId, candidate);
    const afterClick = await perceiveCandidates(tabId);

    if (!screenChangedMaterially(beforeClick, afterClick)) {
      avoidMarks.push(markNumber);
      await recordAndMaybeEscalate({
        actionTaken: `orient_click_hop_${hop}`,
        reasoning:
          `Clicked mark #${markNumber} (${reasoning}) but the screen did not change — ` +
          "treating this as a dead end and trying a different candidate.",
        confidence,
        gateOutcome: "auto",
        confirmResult: "dead_click_detected",
      });
      candidates = afterClick; // Same screen, but re-perceived fresh rather than reused stale.
      continue;
    }

    await recordAndMaybeEscalate({
      actionTaken: `orient_click_hop_${hop}`,
      reasoning,
      confidence,
      gateOutcome: "auto",
      confirmResult: "navigation_succeeded",
    });
    candidates = afterClick;
    // Mark numbers are re-assigned per screen (AXTree traversal order restarts on every new
    // page), so a mark avoided on the screen just left has no meaning on the new one — carrying
    // it forward could wrongly exclude an unrelated, legitimate element that happens to land on
    // the same number here.
    avoidMarks.length = 0;
  }
}