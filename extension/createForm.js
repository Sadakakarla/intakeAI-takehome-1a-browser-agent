// CREATE FORM — Phase 4 scoped shape only (see §15i): no reuse-probe caching, no reversibility-
// probe-driven gating, no multi-form looping — those are Phase 6 additions to this same module.
// Creates exactly one form under an existing visit, following the same Perceive → Locate → Gate
// → Act → Confirm → Record shape as createVisit.js, extended with two new things CREATE VISIT
// never needed: setting a checkbox correctly (idempotent, state-aware — see actions.js's
// setCheckedState) and a real Save-lookalike retry rule, since this card's Create/Cancel buttons
// sit directly next to each other.
//
// Interim Gate policy (until Phase 6's reversibility probe exists): always escalates for human
// approval immediately before Create, regardless of confidence — same reasoning as CREATE VISIT.

import { perceiveCandidates, getAllAccessibleText } from "./perception.js";
import { clickCandidate, typeText, setCheckedState, screenChangedMaterially } from "./actions.js";
import { locateElement } from "./locateElement.js";
import { locateByLabel } from "./locateByLabel.js";
import { confirmVisible } from "./confirmVisible.js";
import { confirmSourceDocumentsScreen } from "./confirmSourceDocumentsScreen.js";
import { requestHumanApproval } from "./gate.js";
import { writeRecord } from "./record.js";
import { callGroqJsonWithRetry } from "./groq-json-retry.js";

const ESCALATION_STORAGE_KEY = "escalationLog";
const LOCATE_CONFIDENCE_FLOOR = 0.6;

// How many total attempts the Save-lookalike retry rule allows: one initial guess, plus exactly
// one informed retry if the first guess didn't actually commit. Never a third blind attempt —
// two failures in a row escalates, per the project's no-blind-retry principle.
const MAX_SAVE_ATTEMPTS = 2;

// Same shape and same reasoning as MAX_SAVE_ATTEMPTS above, applied to a different failure class:
// one initial navigation guess, plus exactly one informed retry if it didn't land on the right
// screen. Never a third blind attempt.
const MAX_NAVIGATION_ATTEMPTS = 2;

export class CreateFormEscalatedError extends Error {
  constructor(reason, details = {}) {
    super(`CREATE FORM escalated: ${reason}`);
    this.name = "CreateFormEscalatedError";
    this.reason = reason;
    this.details = details;
  }
}

async function logEscalation(prefix, reason, message) {
  const { [ESCALATION_STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(ESCALATION_STORAGE_KEY);
  existing.push(`[${prefix}] ${reason}: ${message}`);
  await chrome.storage.local.set({ [ESCALATION_STORAGE_KEY]: existing });
}

// avoidMarks defaults to [] for a normal locate; the Save-lookalike retry loop below passes a
// non-empty list on its second attempt, so the retry is genuinely informed rather than identical
// to the first guess.
async function locateOrEscalate(tabId, candidates, intentDescription, irPath, stepLabel, avoidMarks = []) {
  const result = await locateElement(tabId, candidates, intentDescription, avoidMarks);

  if (!result.found || result.confidence < LOCATE_CONFIDENCE_FLOOR) {
    const reasoning = result.found
      ? `Found a candidate but confidence (${result.confidence}) was below the required floor (${LOCATE_CONFIDENCE_FLOOR}): ${result.reasoning}`
      : `No matching element found: ${result.reasoning}`;

    await writeRecord({
      ir_path: irPath,
      step: stepLabel,
      action_taken: "locate_element",
      decide_reasoning: reasoning,
      confidence: result.confidence,
      gate_outcome: "escalated",
      confirm_result: "not_found_or_low_confidence",
    });
    await logEscalation("CreateForm", `${stepLabel}_locate_failed`, reasoning);
    throw new CreateFormEscalatedError(`${stepLabel}_locate_failed`, { intentDescription });
  }

  return result;
}

// The Save-lookalike retry rule. Locates and clicks the intended commit control, then
// independently CONFIRMS the commit actually happened via confirmFn — never trusts the click
// itself. If Confirm fails, this does NOT blindly re-click the same element: it re-runs LOCATE
// with the wrong mark added to avoidMarks, so the second attempt is genuinely informed by the
// failure, not a repeat of the identical guess. Two failures in a row escalates.
async function clickCommitWithRetry(tabId, intentDescription, confirmFn, irPath, stepLabel) {
  let avoidMarks = [];

  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
    const candidates = await perceiveCandidates(tabId);
    const target = await locateOrEscalate(
      tabId,
      candidates,
      intentDescription,
      irPath,
      `${stepLabel}_attempt_${attempt}`,
      avoidMarks
    );
    const targetCandidate = candidates.find((c) => c.markNumber === target.markNumber);
    await clickCandidate(tabId, targetCandidate);

    const confirmResult = await confirmFn();
    await writeRecord({
      ir_path: irPath,
      step: `${stepLabel}_attempt_${attempt}`,
      action_taken: `clicked mark #${target.markNumber}`,
      decide_reasoning: `${target.reasoning} | Confirm: ${confirmResult.reasoning} (method: ${confirmResult.method})`,
      confidence: target.confidence,
      gate_outcome: "auto",
      confirm_result: confirmResult.matches ? "confirmed_visible" : "commit_not_detected",
    });

    if (confirmResult.matches) {
      return { success: true, target, confirmResult, attempts: attempt };
    }

    console.warn(
      `[createForm] attempt ${attempt} (mark #${target.markNumber}) did not result in a confirmed ` +
        `commit — ${attempt < MAX_SAVE_ATTEMPTS ? "retrying with that mark excluded" : "giving up"}`
    );
    avoidMarks = [...avoidMarks, target.markNumber];
  }

  const reasoning = `Failed to commit after ${MAX_SAVE_ATTEMPTS} attempts (marks tried: ${avoidMarks.join(", ")})`;
  await logEscalation("CreateForm", `${stepLabel}_commit_failed`, reasoning);
  throw new CreateFormEscalatedError(`${stepLabel}_commit_failed`, { avoidMarks });
}

// Best-effort, defensive-only: looks for a control that would dismiss a currently-open preview,
// modal, or dialog overlay, and clicks it if found with real confidence. Never escalates on its
// own — a genuine "nothing to dismiss" is the expected common case, not a failure. Exists because
// a wrong navigation click (unlike a Save-lookalike click, which leaves the surrounding screen
// unchanged) can open something that physically blocks every subsequent click attempt underneath
// it — a real incident: a first wrong click opened a Preview modal, and a second, differently-
// targeted attempt still failed, because nothing had closed the modal still sitting on top.
// Held to a stricter confidence floor than an ordinary locate (0.8, not 0.6) — acting on a wrong
// guess here risks clicking something real and destructive on a legitimate, non-modal screen
// (e.g. a Delete control), which is worse than simply doing nothing when unsure.
const RECOVERY_CONFIDENCE_FLOOR = 0.8;

async function attemptToRecoverFromWrongScreen(tabId, irPath, attemptLabel) {
  const candidates = await perceiveCandidates(tabId);
  const result = await locateElement(
    tabId,
    candidates,
    "the control that closes or dismisses a currently-open preview, modal, or dialog overlay and " +
      "returns to the underlying screen (e.g. 'Close', 'Close Preview', 'Cancel', an 'X' icon) — " +
      "only relevant if such an overlay is genuinely open right now; most screens have no such " +
      "overlay, and that is the expected, ordinary case"
  );
  if (result.found && result.confidence >= RECOVERY_CONFIDENCE_FLOOR) {
    await clickCandidate(tabId, candidates.find((c) => c.markNumber === result.markNumber));
    await writeRecord({
      ir_path: irPath,
      step: `create_form_recover_${attemptLabel}`,
      action_taken: `clicked mark #${result.markNumber} to dismiss a suspected blocking overlay`,
      decide_reasoning: result.reasoning,
      confidence: result.confidence,
      gate_outcome: "auto",
      confirm_result: "not_yet_confirmed",
    });
  }
}


export async function navigateToVisitDocumentsOrEscalate(tabId, visitName, irPath) {
  // Ask-first fast path: if the current screen is already this visit's documents list, skip
  // navigation entirely. Without this, every call assumed a "visit link" was reachable and
  // clickable — true right after Orient, or right after finishing a DIFFERENT visit, but false
  // for every form after the first under the SAME visit, where the browser is already sitting on
  // that visit's own documents list. A real run proved the cost: the agent would click whatever
  // looked closest to "a visit link" (often a breadcrumb), frequently overshooting all the way up
  // to the top-level Visit Schedule before its own retry brought it back down — and in one
  // observed case, produced an outright false escalation on a form that had nothing left to
  // click. Mirrors the same check-before-acting pattern createField.js's
  // ensureOnFormEditorOrEscalate already uses.
  const alreadyThere = await confirmSourceDocumentsScreen(tabId, visitName);
  if (alreadyThere.isDocumentsList) {
    await writeRecord({
      ir_path: irPath,
      step: "create_form_verify_navigation_already_there",
      action_taken: "no_navigation_needed",
      decide_reasoning: `[tier: ${alreadyThere.tier}] ${alreadyThere.reasoning}`,
      confidence: alreadyThere.confidence,
      gate_outcome: "auto",
      confirm_result: "confirmed_documents_list",
    });
    return;
  }

  let avoidMarks = [];

  for (let attempt = 1; attempt <= MAX_NAVIGATION_ATTEMPTS; attempt += 1) {
    // Only ever needed before a RETRY (attempt 2+), not the first attempt — a blocking overlay
    // can only exist as the result of a previous failed attempt within this same loop; a brand-new
    // form's very first attempt always follows either Orient (no modal possible yet) or the
    // previous form's successful Save (which closes any modal as part of committing). Skipping
    // this call on attempt 1 removes one real qwen call from every single form (28 per run) at
    // zero loss of safety — reasoned out, then confirmed worth doing by real run data showing
    // qwen become the measured bottleneck once this call was running unconditionally on every
    // attempt, including the (overwhelmingly common) case where nothing was ever blocking at all.
    if (attempt > 1) {
      await attemptToRecoverFromWrongScreen(tabId, irPath, `before_attempt_${attempt}`);
    }

    const candidates = await perceiveCandidates(tabId);

    // Free, $0 first pass: the visit's own real name is a known literal string from the IR, not
    // a category of possible synonymous terms — a Visit Schedule table is expected to render
    // exactly this text for its own row, on any realistic platform. Same cheap-before-expensive
    // principle already used for Label/Required in createField.js, applied here for the first
    // time to a navigation target. In the common case, this removes this call site's entire
    // semantic-locate/vision-fallback cost — and its exposure to rate limits and occasional model
    // misjudgment — a real, recurring cost given this function runs once per form, every form.
    const eligibleForCheapMatch = candidates.filter((c) => !avoidMarks.includes(c.markNumber));
    const cheapMatch = locateByLabel(eligibleForCheapMatch, [visitName], null);

    let visitLink;
    if (cheapMatch) {
      visitLink = {
        markNumber: cheapMatch.markNumber,
        confidence: 1,
        reasoning: `Matched literally by accessible name (free, no LLM call): "${cheapMatch.name}"`,
      };
    } else {
      visitLink = await locateOrEscalate(
        tabId,
        candidates,
        `the link or control that lets a user view or manage the source documents/forms for the visit named "${visitName}"`,
        irPath,
        `create_form_find_visit_link_attempt_${attempt}`,
        avoidMarks
      );
    }
    await clickCandidate(tabId, candidates.find((c) => c.markNumber === visitLink.markNumber));
    const afterClick = await perceiveCandidates(tabId);

    const screenCheck = await confirmSourceDocumentsScreen(tabId, visitName);
    await writeRecord({
      ir_path: irPath,
      step: `create_form_verify_navigation_attempt_${attempt}`,
      action_taken: `clicked mark #${visitLink.markNumber}`,
      decide_reasoning: `${visitLink.reasoning} | Screen check [tier: ${screenCheck.tier}]: ${screenCheck.reasoning}`,
      confidence: Math.min(visitLink.confidence, screenCheck.confidence),
      gate_outcome: "auto",
      confirm_result: screenCheck.isDocumentsList ? "confirmed_documents_list" : "wrong_screen",
    });

    if (screenCheck.isDocumentsList) {
      return; // Landed correctly — the rest of createForm can proceed.
    }

    console.warn(
      `[createForm] attempt ${attempt} (mark #${visitLink.markNumber}) did not land on visit ` +
        `"${visitName}"'s documents list — ${attempt < MAX_NAVIGATION_ATTEMPTS ? "retrying with that mark excluded" : "giving up"}`
    );
    // Mark numbers are re-assigned per screen — a mark avoided on the screen just left has no
    // meaning on a new one, and carrying it forward could wrongly exclude an unrelated, correct
    // element that happens to land on the same number. Only a genuine dead click (the screen
    // didn't change at all) is worth remembering for the next attempt. Same fix applied to
    // createVisit.js's analogous loop after a live run proved this exact failure mode there —
    // lower risk here (only one retry, versus that loop's several hops) but the same wrong
    // pattern, so fixed here too rather than left as a known-bad precedent.
    avoidMarks = screenChangedMaterially(candidates, afterClick) ? [] : [...avoidMarks, visitLink.markNumber];
  }

  // One last best-effort cleanup, so whatever comes next (the following form's own navigation
  // attempt, or a future resumed run) doesn't inherit a blocking overlay left by this function's
  // own final failed attempt — this is exactly what was missing when this escalation last fired.
  await attemptToRecoverFromWrongScreen(tabId, irPath, "final_cleanup");

  const reasoning =
    `Navigation to visit "${visitName}"'s documents list did not land on the right screen after ` +
    `${MAX_NAVIGATION_ATTEMPTS} attempt(s) (marks tried: ${avoidMarks.join(", ")})`;
  await logEscalation("CreateForm", "create_form_navigation_failed", reasoning);
  throw new CreateFormEscalatedError("create_form_navigation_failed", { avoidMarks });
}

// The semantic intent used to locate and click the Activate control itself. A genuinely ordinary
// LOCATE target — unlike the status-reading problem below, finding the button to click is not
// the hard part here.
const ACTIVATE_INTENT =
  "the control that activates or publishes this form, making it the live/current version " +
  "available for real use — as opposed to a Draft/unpublished working state";

function parseActivationStatus(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`response was not valid JSON: ${error.message}`);
  }
  if (typeof parsed.isActive !== "boolean") {
    throw new Error(`"isActive" was missing or not a boolean (got: ${JSON.stringify(parsed.isActive)})`);
  }
  return parsed;
}

// Determines whether THIS FORM is currently active/published, by reading the screen's own
// accessible text and asking a cheap, text-only, JSON-retry-protected model — never a literal
// string scan. Found necessary via real, live evidence, not designed defensively in the abstract:
// a first version assumed the Activate control itself would disappear once a form goes active
// (generalizing Mock A's own confirmed edit-pencil-disappearing behavior in the Source Documents
// table) — a real live test proved this WRONG specifically for the Activate button inside the
// form editor itself, which stays visible regardless of status on this platform, making its
// presence useless as a signal in either direction. The real, confirmed signals are a status
// badge near the form's own title (e.g. "v1 · Active") and a transient confirmation message
// (e.g. "Document activated.").
//
// A literal text scan for the word "Active" was deliberately rejected even before that discovery,
// for an unrelated but equally real reason: this project's own IR data contains coded-option
// labels like "Active Malignancy" and "Active Serious Infection" (Eligibility Criteria) that would
// false-positive on any naive whole-page scan. The prompt below explicitly tells the model to
// ignore exactly this class of unrelated text, since a semantic read can make that distinction
// where a substring match cannot.
async function confirmFormActivated(formName, allText) {
  const manifest = allText.join("\n");
  const promptText =
    `Here is all the text currently visible on a form-builder screen for a form named "${formName}":\n\n` +
    `${manifest}\n\n` +
    "Does this show that THIS FORM ITSELF is currently in an ACTIVE/PUBLISHED/LIVE state (e.g. a " +
    'status badge reading "Active" or "Published" next to the form\'s own name/version, or a ' +
    'confirmation message like "Document activated"), as opposed to a Draft/unpublished state? ' +
    'IMPORTANT: ignore any unrelated text that merely CONTAINS the word "Active" as part of a ' +
    'different label — e.g. a coded checklist option like "Active Malignancy" or "Active Serious ' +
    "Infection\" is NOT evidence of this form's own status. Only a genuine status indicator or " +
    "confirmation message for the form itself counts.\n\n" +
    'Reply with a JSON object with exactly these keys: "isActive" (true or false) and "reasoning" ' +
    "(one sentence). Reply with JSON only.";

  const { parsed } = await callGroqJsonWithRetry(
    "openai/gpt-oss-120b",
    (correctionNote) => [
      {
        role: "user",
        content: [{ type: "text", text: correctionNote ? `${correctionNote}\n\n${promptText}` : promptText }],
      },
    ],
    { response_format: { type: "json_object" }, reasoning_format: "hidden", max_tokens: 800 },
    parseActivationStatus
  );

  return parsed;
}

// Tiny local delay helper — governor.js already has an identical one for rate-limit waits, but
// it's module-private there and this is a conceptually different use (waiting for a UI
// transition to settle, not a rate-limit reset), so a small local copy is clearer than reaching
// across modules for one line.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded re-check budget for confirming Activate actually took effect, and the delay between
// checks. Kept even after the redesign above: activating still swaps this form's status badge and
// shows a transient confirmation message, a heavier UI transition than the simple value/row
// updates every other Confirm step in this project checks, and still plausibly slower to settle
// than an immediate re-check allows for. Bounded, informed re-checking — not a single-shot
// conclusion, and not an unbounded retry — is the same principle already used for Save commits
// and navigation elsewhere in this file.
const MAX_ACTIVATE_CONFIRM_CHECKS = 2;
const ACTIVATE_CONFIRM_RETRY_DELAY_MS = 1500;

// Activates a form, idempotently. Returns { activated: true, alreadyActive: boolean }. Throws
// CreateFormEscalatedError if the Activate control was found and clicked but the form's own
// status still doesn't read as active afterward — the platform likely refused silently (Mock A's
// own documented trap: Activate refuses via a toast while there are unsaved edits), and that is
// real, worth-surfacing information, never assumed to be success just because a click happened.
export async function activateForm(tabId, formName, irPath) {
  const beforeStatus = await confirmFormActivated(formName, await getAllAccessibleText(tabId));

  if (beforeStatus.isActive) {
    await writeRecord({
      ir_path: irPath,
      step: "create_form_activate",
      action_taken: "skipped_already_active",
      decide_reasoning: `This form's own status already reads as active (${beforeStatus.reasoning}) — nothing to do.`,
      confidence: 1,
      gate_outcome: "auto",
      confirm_result: "already_active",
    });
    return { activated: true, alreadyActive: true };
  }

  const candidates = await perceiveCandidates(tabId);
  const target = await locateOrEscalate(tabId, candidates, ACTIVATE_INTENT, irPath, "create_form_activate_click");
  await clickCandidate(tabId, candidates.find((c) => c.markNumber === target.markNumber));

  let afterStatus;
  for (let attempt = 1; attempt <= MAX_ACTIVATE_CONFIRM_CHECKS; attempt += 1) {
    afterStatus = await confirmFormActivated(formName, await getAllAccessibleText(tabId));
    if (afterStatus.isActive) break;
    if (attempt < MAX_ACTIVATE_CONFIRM_CHECKS) {
      console.warn(
        `[createForm] form status does not yet read as active on check ${attempt}/${MAX_ACTIVATE_CONFIRM_CHECKS} ` +
          `— waiting ${ACTIVATE_CONFIRM_RETRY_DELAY_MS}ms for the UI to settle before re-checking`
      );
      await sleep(ACTIVATE_CONFIRM_RETRY_DELAY_MS);
    }
  }

  await writeRecord({
    ir_path: irPath,
    step: "create_form_activate",
    action_taken: `clicked mark #${target.markNumber}`,
    decide_reasoning: afterStatus.isActive
      ? `This form's status now reads as active after the click (${afterStatus.reasoning}).`
      : `This form's status still does not read as active after ${MAX_ACTIVATE_CONFIRM_CHECKS} check(s), ` +
        `including a settling delay (${afterStatus.reasoning}) — the platform likely refused ` +
        "silently (Mock A's own documented trap: unsaved edits block Activate). Treated as a real " +
        "failure, not assumed success.",
    confidence: target.confidence,
    gate_outcome: "auto",
    confirm_result: afterStatus.isActive ? "activate_confirmed" : "activate_not_detected",
  });

  if (!afterStatus.isActive) {
    const reasoning =
      "Clicking the Activate control did not result in this form's own status reading as active — " +
      "the platform may have silently refused (e.g. unsaved edits).";
    await logEscalation("CreateForm", "create_form_activate_failed", reasoning);
    throw new CreateFormEscalatedError("create_form_activate_failed", {});
  }

  return { activated: true, alreadyActive: false };
}

// Creates one form under an existing visit. formSpec is { name, repeating, irPath }. Returns
// { created: true } on success, or { created: false, reason: "rejected_by_human" } on a human
// rejection at the Gate. A failed locate, a failed commit after retry, or a genuine
// provider/network error all propagate as real escalations or real errors.
export async function createForm(tabId, visitName, formSpec) {
  const { name, repeating, irPath } = formSpec;

  // Step 1: navigate into the visit's form-management area, independently verified — see
  // navigateToVisitDocumentsOrEscalate's own header for why this check exists.
  await navigateToVisitDocumentsOrEscalate(tabId, visitName, irPath);

  // Step 2: open the "add a form" affordance.
  let candidates = await perceiveCandidates(tabId);
  const addFormAffordance = await locateOrEscalate(
    tabId,
    candidates,
    "the control that lets a user add a new source document or form to this visit",
    irPath,
    "create_form_find_add_affordance"
  );
  await clickCandidate(tabId, candidates.find((c) => c.markNumber === addFormAffordance.markNumber));
  await writeRecord({
    ir_path: irPath,
    step: "create_form_open_add_form",
    action_taken: `clicked mark #${addFormAffordance.markNumber}`,
    decide_reasoning: addFormAffordance.reasoning,
    confidence: addFormAffordance.confidence,
    gate_outcome: "auto",
    confirm_result: "not_yet_confirmed",
  });

  // Step 3: fill in the Document Name field.
  candidates = await perceiveCandidates(tabId);
  const nameField = await locateOrEscalate(
    tabId,
    candidates,
    "the input field for entering the name of the new source document or form",
    irPath,
    "create_form_find_name_field"
  );
  await typeText(tabId, candidates.find((c) => c.markNumber === nameField.markNumber), name);

  // Step 4: set the "repeating" checkbox, idempotently — reads its real current state rather
  // than assuming or blindly toggling.
  candidates = await perceiveCandidates(tabId);
  const repeatingCheckbox = await locateOrEscalate(
    tabId,
    candidates,
    "the checkbox indicating whether this form is a repeating log with many records per visit",
    irPath,
    "create_form_find_repeating_checkbox"
  );
  const checkboxCandidate = candidates.find((c) => c.markNumber === repeatingCheckbox.markNumber);
  await setCheckedState(tabId, checkboxCandidate, repeating);

  await writeRecord({
    ir_path: irPath,
    step: "create_form_fill_fields",
    action_taken: `typed name="${name}", set repeating checkbox to ${repeating}`,
    decide_reasoning: `Name field: ${nameField.reasoning} | Repeating checkbox: ${repeatingCheckbox.reasoning}`,
    confidence: Math.min(nameField.confidence, repeatingCheckbox.confidence),
    gate_outcome: "auto",
    confirm_result: "not_yet_confirmed",
  });

  // Step 5: GATE. The human sees exactly what is about to become permanent.
  const description = `Create form "${name}" under visit "${visitName}" (repeating: ${repeating})`;
  const approved = await requestHumanApproval(description, { name, repeating, visitName });

  await writeRecord({
    ir_path: irPath,
    step: "create_form_gate",
    action_taken: "requested_human_approval",
    decide_reasoning: description,
    confidence: 1,
    gate_outcome: approved ? "approved" : "rejected",
    confirm_result: approved ? "pending_save" : "not_saved",
  });

  if (!approved) {
    console.warn(`[createForm] rejected by human for form "${name}" — leaving the draft unsaved`);
    return { created: false, reason: "rejected_by_human" };
  }

  // Step 6: commit, via the Save-lookalike retry rule — never trusts a click blindly, and never
  // blindly repeats an identical guess if the first one didn't actually commit.
  await clickCommitWithRetry(
    tabId,
    "the button that actually saves and permanently creates this new source document (not Cancel, not a preview)",
    () => confirmVisible(tabId, [name], "This should be a Source Documents / forms table for a visit."),
    irPath,
    "create_form_commit"
  );

  return { created: true };
}