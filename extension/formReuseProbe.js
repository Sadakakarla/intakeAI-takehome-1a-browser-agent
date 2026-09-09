// Phase 6.6 — the form reuse probe. Checks, once per distinct form DEFINITION (name + field
// signature — see formReuseCache.js), whether the current platform offers a genuine reuse/attach
// affordance instead of requiring every occurrence to be built from scratch. Every later
// occurrence of the same definition reuses the cached answer for free, never re-probing.
//
// Checks TWO locations, not one: (1) the visit's Source Documents list screen itself, beside the
// "add new" affordance, and (2) inside the form-creation card once it's opened. This two-location
// design is a direct, disclosed correction to this project's own earlier research: Mock A's own
// "Import From Library…" control, initially assumed to be the concrete answer to the form-reuse
// question, was live-confirmed by hand to actually be a FIELD-level palette entry (inside a
// form's own field-type "Elements" panel) — unrelated to whole-form reuse, and living nowhere
// near the Source Documents list. Mock A, checked directly across all three real screens (the
// documents list, the creation card, and the field palette), has NO whole-form reuse/attach
// affordance anywhere in its visible UI at all — a stronger, corrected finding than the original
// research concluded. Checking only the list screen would leave a plausible unseen-platform shape
// (a "Create New" vs. "Import Existing" toggle inside the creation flow itself) completely
// undetectable, directly contradicting the assignment's own recall-over-precision philosophy.
//
// This function NEVER gates whether a form gets built: regardless of what it concludes — reuse
// available, not available, or a candidate found but not confidently resolvable — the caller is
// expected to proceed and build the form fully from scratch afterward, unconditionally. A
// genuine, confirmed reuse affordance is disclosed as a non-blocking escalation (logged for a
// human to review) rather than acted on automatically: this project has never driven an
// unverified, never-tested UI flow autonomously, and an unknown platform's actual attach/reuse
// flow (a picker? a search field? a confirmation step?) has no prior art here to test against.
//
// If step 2 opens the form-creation card, this function ALWAYS attempts to close it again before
// returning — a card left open would corrupt the very next step (createForm()'s own navigation
// and card-opening), which expects to start from a clean documents list. If closing genuinely
// fails, this throws CreateFormEscalatedError (the same class createForm.js itself throws), since
// leaving the screen in that state is a real problem for the guaranteed from-scratch build that
// follows — not an ordinary "no reuse found" outcome.
//
// Never throws on an ordinary "no reuse affordance" outcome — that is the expected, common
// result, not a failure. A genuine provider/network error from an underlying locate call
// propagates to the caller unchanged, exactly like every other call in this project.

import { perceiveCandidates } from "./perception.js";
import { clickCandidate, screenChangedMaterially } from "./actions.js";
import { locateElement } from "./locateElement.js";
import { locateByLabel } from "./locateByLabel.js";
import { writeRecord } from "./record.js";
import { CreateFormEscalatedError } from "./createForm.js";
import {
  formDefinitionSignature,
  getFormReuseCacheEntry,
  setFormReuseCacheEntry,
} from "./formReuseCache.js";

const ESCALATION_STORAGE_KEY = "escalationLog";

async function logEscalation(prefix, reason, message) {
  const { [ESCALATION_STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(ESCALATION_STORAGE_KEY);
  existing.push(`[${prefix}] ${reason}: ${message}`);
  await chrome.storage.local.set({ [ESCALATION_STORAGE_KEY]: existing });
}

// Same 0.6 floor already used project-wide for an ordinary locate (see createForm.js's and
// createVisit.js's own LOCATE_CONFIDENCE_FLOOR) — every locate in this file is an ordinary
// detection/navigation step, not a higher-stakes commit, so no stricter bar is warranted here.
const REUSE_LOCATE_CONFIDENCE_FLOOR = 0.6;

const REUSE_INTENT_LIST_SCREEN =
  "a control on THIS LIST SCREEN (not inside any dialog) that lets the user reuse, attach, or " +
  "import an ALREADY-EXISTING form/source-document definition into this visit, instead of " +
  "building a brand new one from scratch — for example an 'Import From Library', 'Reuse Existing " +
  "Form', 'Attach Existing Document', or 'Copy From Another Visit' style control placed beside " +
  "the ordinary 'add new' control. Many platforms have no such affordance at all, and that is a " +
  "completely normal, expected answer — only report a match if a control genuinely appears to " +
  "offer this.";

const ADD_FORM_AFFORDANCE_INTENT =
  "the control that lets a user add a new source document or form to this visit";

const REUSE_INTENT_INSIDE_CARD =
  "a control INSIDE this form-creation card/dialog that lets the user import, attach, or reuse an " +
  "EXISTING form/source-document definition instead of filling in a brand-new one from scratch — " +
  "for example a toggle or tab between 'Create New' and 'Import Existing', a 'Choose From " +
  "Library' option, or a searchable picker of existing definitions. Many platforms have no such " +
  "option inside this card at all, and that is a completely normal, expected answer — only " +
  "report a match if a control genuinely appears to offer this.";

const CANCEL_INTENT =
  "the control that closes or cancels this form-creation card/dialog WITHOUT creating anything, " +
  "returning to the underlying list of source documents/forms";

const CANCEL_LABELS = ["Cancel"];

// Locates a candidate matching intentDescription, clicks it if found with real confidence, and
// checks whether the screen genuinely changed as a result — the same dead-click detector already
// proven in orient.js and the navigation loops. A click producing no material change IS the
// platform's own answer (a decoy/no-op control), not an inconclusive result. Writes exactly one
// Record per call, regardless of outcome.
async function attemptClickAndCheckChange(tabId, candidates, intentDescription, stepLabel, irPath) {
  const located = await locateElement(tabId, candidates, intentDescription);

  if (!located.found || located.confidence < REUSE_LOCATE_CONFIDENCE_FLOOR) {
    const reasoning = located.found
      ? `A candidate was found but confidence (${located.confidence}) was below the floor ` +
        `(${REUSE_LOCATE_CONFIDENCE_FLOOR}) — treated as no genuine affordance: ${located.reasoning}`
      : `No matching candidate was found: ${located.reasoning}`;
    await writeRecord({
      ir_path: irPath,
      step: stepLabel,
      action_taken: "locate_no_affordance",
      decide_reasoning: reasoning,
      confidence: located.confidence,
      gate_outcome: "auto",
      confirm_result: "no_affordance_found",
    });
    return { positive: false, reasoning };
  }

  const targetCandidate = candidates.find((c) => c.markNumber === located.markNumber);
  await clickCandidate(tabId, targetCandidate);
  const afterCandidates = await perceiveCandidates(tabId);
  const materiallyChanged = screenChangedMaterially(candidates, afterCandidates);

  if (!materiallyChanged) {
    const reasoning =
      `A candidate ("${targetCandidate.name || "unlabeled"}") was found and clicked, but produced ` +
      `no material change to the screen — a dead-click/decoy control, not a genuine mechanism ` +
      `(${located.reasoning})`;
    await writeRecord({
      ir_path: irPath,
      step: stepLabel,
      action_taken: `clicked mark #${located.markNumber}`,
      decide_reasoning: reasoning,
      confidence: located.confidence,
      gate_outcome: "auto",
      confirm_result: "dead_click_no_reuse",
    });
    return { positive: false, reasoning };
  }

  const reasoning =
    `A candidate ("${targetCandidate.name || "unlabeled"}") was found, clicked, and produced a ` +
    `genuine, material change to the screen (${located.reasoning})`;
  await writeRecord({
    ir_path: irPath,
    step: stepLabel,
    action_taken: `clicked mark #${located.markNumber}`,
    decide_reasoning: reasoning,
    confidence: located.confidence,
    gate_outcome: "auto",
    confirm_result: "material_change_detected",
  });
  return { positive: true, reasoning };
}

// Closes an open form-creation card. Tries a free, $0 literal match on "Cancel" first (a
// near-universal term, same cheap-before-expensive discipline used project-wide), falling back to
// a semantic locate only if that fails. Throws CreateFormEscalatedError if neither works.
async function closeCreationCardOrEscalate(tabId, irPath) {
  const candidates = await perceiveCandidates(tabId);

  const cheapMatch = locateByLabel(candidates, CANCEL_LABELS, null);
  if (cheapMatch) {
    await clickCandidate(tabId, cheapMatch);
    await writeRecord({
      ir_path: irPath,
      step: "probe_form_reuse_close_card",
      action_taken: `clicked mark #${cheapMatch.markNumber}`,
      decide_reasoning: `Matched literally by accessible name (free, no LLM call): "${cheapMatch.name}"`,
      confidence: 1,
      gate_outcome: "auto",
      confirm_result: "card_closed",
    });
    return;
  }

  const located = await locateElement(tabId, candidates, CANCEL_INTENT);
  if (located.found && located.confidence >= REUSE_LOCATE_CONFIDENCE_FLOOR) {
    const target = candidates.find((c) => c.markNumber === located.markNumber);
    await clickCandidate(tabId, target);
    await writeRecord({
      ir_path: irPath,
      step: "probe_form_reuse_close_card",
      action_taken: `clicked mark #${located.markNumber}`,
      decide_reasoning: located.reasoning,
      confidence: located.confidence,
      gate_outcome: "auto",
      confirm_result: "card_closed",
    });
    return;
  }

  const reasoning =
    "Opened the form-creation card to probe it for an internal reuse option, but could not find " +
    `a way to close it again afterward (${located.reasoning}) — leaving it open risks corrupting ` +
    "the next step, which expects a clean documents list.";
  await writeRecord({
    ir_path: irPath,
    step: "probe_form_reuse_close_card",
    action_taken: "locate_failed",
    decide_reasoning: reasoning,
    confidence: located.confidence,
    gate_outcome: "escalated",
    confirm_result: "could_not_close_card",
  });
  await logEscalation("Driver", "probe_form_reuse_could_not_close_card", reasoning);
  throw new CreateFormEscalatedError("probe_form_reuse_could_not_close_card", {});
}

async function finalizeResult(formName, signature, reuseAvailable, reasoning, irPath) {
  const result = { reuseAvailable, reasoning };
  setFormReuseCacheEntry(formName, signature, result);

  await writeRecord({
    ir_path: irPath,
    step: "probe_form_reuse",
    action_taken: "probe_complete",
    decide_reasoning: reasoning,
    confidence: 1,
    gate_outcome: reuseAvailable ? "escalated" : "auto",
    confirm_result: reuseAvailable ? "reuse_affordance_detected_not_used" : "no_reuse_affordance_found",
  });

  if (reuseAvailable) {
    await logEscalation("Driver", "probe_form_reuse_affordance_detected", reasoning);
  }

  return result;
}

export async function probeFormReuseOnce(tabId, formName, formFields, irPath) {
  const signature = formDefinitionSignature(formFields);
  const cached = getFormReuseCacheEntry(formName, signature);

  if (cached) {
    await writeRecord({
      ir_path: irPath,
      step: "probe_form_reuse",
      action_taken: "cache_hit",
      decide_reasoning: `Definition "${formName}" already probed this run: ${cached.reasoning}`,
      confidence: 1,
      gate_outcome: "auto",
      confirm_result: cached.reuseAvailable ? "reuse_available_cached" : "no_reuse_cached",
    });
    return cached;
  }

  // Step 1: check the documents list screen itself.
  const listCandidates = await perceiveCandidates(tabId);
  const listCheck = await attemptClickAndCheckChange(
    tabId,
    listCandidates,
    REUSE_INTENT_LIST_SCREEN,
    "probe_form_reuse_list_screen",
    irPath
  );

  if (listCheck.positive) {
    return finalizeResult(formName, signature, true, listCheck.reasoning, irPath);
  }

  // Step 2: open the form-creation card and check INSIDE it too — see this file's header for why.
  const openCandidates = await perceiveCandidates(tabId);
  const addAffordance = await locateElement(tabId, openCandidates, ADD_FORM_AFFORDANCE_INTENT);

  if (!addAffordance.found || addAffordance.confidence < REUSE_LOCATE_CONFIDENCE_FLOOR) {
    const reasoning =
      `${listCheck.reasoning} Additionally, could not open the form-creation card to check for an ` +
      `internal reuse option (${addAffordance.reasoning}) — the ordinary create-form step ` +
      "immediately following this will attempt the identical control itself and escalate through " +
      "its own established path if it genuinely cannot be found there either.";
    return finalizeResult(formName, signature, false, reasoning, irPath);
  }

  const addTarget = openCandidates.find((c) => c.markNumber === addAffordance.markNumber);
  await clickCandidate(tabId, addTarget);

  let insideCheck;
  try {
    const insideCandidates = await perceiveCandidates(tabId);
    insideCheck = await attemptClickAndCheckChange(
      tabId,
      insideCandidates,
      REUSE_INTENT_INSIDE_CARD,
      "probe_form_reuse_inside_card",
      irPath
    );
  } finally {
    // Always attempted, whether the inside-card check found something, found nothing, or threw a
    // genuine error — see this file's header for why leaving the card open is not acceptable.
    await closeCreationCardOrEscalate(tabId, irPath);
  }

  const combinedReasoning = `${listCheck.reasoning} Also checked inside the form-creation card: ${insideCheck.reasoning}`;
  return finalizeResult(formName, signature, insideCheck.positive, combinedReasoning, irPath);
}