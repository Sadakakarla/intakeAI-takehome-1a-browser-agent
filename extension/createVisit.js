// CREATE VISIT — Phase 4 scoped shape only: no reuse-probe caching, no reversibility-probe-driven
// gating, no multi-visit looping — those are Phase 6 additions to this same module, not built
// here. Creates exactly one visit, following the same Perceive → Locate → Gate → Act → Confirm →
// Record shape used elsewhere in the agent, adapted for a creation action.
//
// Interim Gate policy (until Phase 6's reversibility probe exists): this action always escalates
// for human approval immediately before Save, regardless of confidence — reversibility is
// unknown, and unknown defaults to "assume irreversible." Gating happens at Save, not at opening
// the creation card, since opening the card is non-destructive (an unsaved draft can simply be
// abandoned) and gating there would only let a human approve a vague intention rather than the
// actual values about to be committed.
//
// Known limitation, not solved here: Confirm verifies that the expected name and window values
// are present somewhere on the screen, not that each one ended up in the correct field. If the
// agent ever mislocates the Name and Window fields and types their values swapped, both strings
// would still be visible and Confirm would incorrectly report success. Closing this fully would
// require re-locating each field after Save and checking its individual value — real added
// complexity not undertaken in this phase.

import { perceiveCandidates } from "./perception.js";
import { clickCandidate, typeText, screenChangedMaterially } from "./actions.js";
import { locateElement } from "./locateElement.js";
import { confirmVisible } from "./confirmVisible.js";
import { confirmVisitScheduleScreen } from "./confirmVisitScheduleScreen.js";
import { requestHumanApproval } from "./gate.js";
import { writeRecord } from "./record.js";

const ESCALATION_STORAGE_KEY = "escalationLog";

// Below this confidence, a locateElement result is treated the same as "not found" — a model's
// own stated uncertainty means it shouldn't be trusted even when it technically returned an
// answer.
const LOCATE_CONFIDENCE_FLOOR = 0.6;

// Bounded navigate-up hop cap for ensureOnVisitScheduleOrEscalate, below — same
// generalize-over-efficiency philosophy already justified for Orient's own 4-hop cap (§13a), sized
// smaller here since this is a narrow, single-purpose recovery from a known screen hierarchy
// (Visit Schedule → a visit's Source Documents → a form's editor, at most two levels deep on Mock
// A) rather than open-ended exploration from an unknown starting point.
const MAX_NAVIGATE_UP_HOPS = 3;

// Thrown when this action cannot proceed and must hand control to a human — mirroring
// OrientEscalatedError's role for Step 0, but distinct: the caller should treat this as a
// graceful stop for this one action, not necessarily the whole run, unlike Orient.
export class CreateVisitEscalatedError extends Error {
  constructor(reason, details = {}) {
    super(`CREATE VISIT escalated: ${reason}`);
    this.name = "CreateVisitEscalatedError";
    this.reason = reason;
    this.details = details;
  }
}

async function logEscalation(prefix, reason, message) {
  const { [ESCALATION_STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(ESCALATION_STORAGE_KEY);
  existing.push(`[${prefix}] ${reason}: ${message}`);
  await chrome.storage.local.set({ [ESCALATION_STORAGE_KEY]: existing });
}

// Wraps a single locateElement call with the confidence-floor check and escalation-on-failure
// logic shared by every element this action needs to find.
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
    await logEscalation("CreateVisit", `${stepLabel}_locate_failed`, reasoning);
    throw new CreateVisitEscalatedError(`${stepLabel}_locate_failed`, { intentDescription });
  }

  return result;
}

// Ensures the current screen is the study's top-level Visit Schedule before CREATE VISIT looks
// for the "Add Visit" affordance — see confirmVisitScheduleScreen.js's own header for the real
// incident this exists to catch. Bounded navigate-up loop, same idiom as Orient's own hop loop
// (§13a): check first, escalate at the cap before attempting one more click, otherwise locate and
// click a generic "back/up" control and try again. Never assumes a specific number of levels or a
// specific platform label for that control — an unseen platform's hierarchy depth isn't known in
// advance, which is exactly why this is bounded exploration rather than a single hardcoded click.
export async function ensureOnVisitScheduleOrEscalate(tabId, irPath) {
  let avoidMarks = [];

  for (let hop = 0; hop <= MAX_NAVIGATE_UP_HOPS; hop += 1) {
    const screenCheck = await confirmVisitScheduleScreen(tabId);
    await writeRecord({
      ir_path: irPath,
      step: `create_visit_check_schedule_screen_hop_${hop}`,
      action_taken: screenCheck.isVisitSchedule ? "already_on_schedule" : "not_on_schedule",
      decide_reasoning: `[tier: ${screenCheck.tier}] ${screenCheck.reasoning}`,
      confidence: screenCheck.confidence,
      gate_outcome: "auto",
      confirm_result: screenCheck.isVisitSchedule ? "schedule_confirmed" : "schedule_not_present",
    });

    if (screenCheck.isVisitSchedule) return;

    if (hop === MAX_NAVIGATE_UP_HOPS) {
      const reasoning = `Could not reach the Visit Schedule screen after ${MAX_NAVIGATE_UP_HOPS} navigation hop(s) (marks tried: ${avoidMarks.join(", ")}).`;
      await logEscalation("CreateVisit", "create_visit_navigation_failed", reasoning);
      throw new CreateVisitEscalatedError("create_visit_navigation_failed", { hop, avoidMarks });
    }

    const beforeClick = await perceiveCandidates(tabId);
    const backControl = await locateOrEscalate(
      tabId,
      beforeClick,
      "the control that navigates back or up toward the study's top-level Visit Schedule (e.g. " +
        "a 'Back' link, a breadcrumb, or the study/visit name at the top of the page) — NOT any " +
        "control that creates, edits, or deletes something",
      irPath,
      `create_visit_navigate_up_hop_${hop}`,
      avoidMarks
    );
    await clickCandidate(tabId, beforeClick.find((c) => c.markNumber === backControl.markNumber));
    const afterClick = await perceiveCandidates(tabId);

    await writeRecord({
      ir_path: irPath,
      step: `create_visit_navigate_up_hop_${hop}`,
      action_taken: `clicked mark #${backControl.markNumber}`,
      decide_reasoning: backControl.reasoning,
      confidence: backControl.confidence,
      gate_outcome: "auto",
      confirm_result: "not_yet_confirmed",
    });

    // Mark numbers are re-assigned per screen (AXTree traversal order restarts on every new
    // page), so a mark avoided on the screen just left has no meaning on the new one — carrying
    // it forward could wrongly exclude an unrelated, legitimate element that happens to land on
    // the same number, exactly as happened on a real run: the one genuinely correct "back"
    // control got excluded on the very next hop because it shared a mark number with something
    // already tried on a screen that no longer existed. Only a genuine dead click (the screen
    // didn't change at all) is worth remembering, so the next attempt on that SAME screen doesn't
    // repeat the identical ineffective click. This is the same pattern Orient's own hop loop
    // already uses, applied here after this loop was first built without it.
    avoidMarks = screenChangedMaterially(beforeClick, afterClick) ? [] : [...avoidMarks, backControl.markNumber];
  }
}

// Creates one visit on the current screen. visitSpec is { name, windowStartDay, windowEndDay,
// irPath }. Returns { created: true } on success, or { created: false, reason: "rejected_by_human" }
// on a human rejection at the Gate — a rejection is a valid, expected outcome, not a crash. A
// failed locate, a failed Confirm, or a genuine Groq/network error all propagate as real
// escalations or real errors — this function never silently converts a real problem into a quiet
// "not created."
export async function createVisit(tabId, visitSpec) {
  const { name, windowStartDay, windowEndDay, irPath } = visitSpec;

  // Step 0: make sure we're actually on the Visit Schedule before looking for "Add Visit" — see
  // ensureOnVisitScheduleOrEscalate's own header for why this exists. Only ever a no-op wait for
  // the first visit of a run (Orient already lands there); genuinely needed from the second visit
  // onward, once the driver has navigated away to build a previous visit's forms and fields.
  await ensureOnVisitScheduleOrEscalate(tabId, irPath);

  // Step 1: find the affordance that opens visit creation.
  let candidates = await perceiveCandidates(tabId);
  const addVisit = await locateOrEscalate(
    tabId,
    candidates,
    "the control that lets a user create a new Visit in a study's visit schedule",
    irPath,
    "create_visit_find_affordance"
  );

  // Step 2: open it. Non-destructive — no gate here; the gate fires later, at Save.
  const addVisitCandidate = candidates.find((c) => c.markNumber === addVisit.markNumber);
  await clickCandidate(tabId, addVisitCandidate);
  await writeRecord({
    ir_path: irPath,
    step: "create_visit_open_form",
    action_taken: `clicked mark #${addVisit.markNumber}`,
    decide_reasoning: addVisit.reasoning,
    confidence: addVisit.confidence,
    gate_outcome: "auto",
    confirm_result: "not_yet_confirmed",
  });

  // Step 3: find and fill the Name and Window fields. Each field's wording on this platform is
  // unknown by design, so each is its own locate call, not a literal match.
  candidates = await perceiveCandidates(tabId);
  const nameField = await locateOrEscalate(
    tabId,
    candidates,
    "the input field for entering the visit's name",
    irPath,
    "create_visit_find_name_field"
  );
  await typeText(tabId, candidates.find((c) => c.markNumber === nameField.markNumber), name);

  candidates = await perceiveCandidates(tabId);
  const startField = await locateOrEscalate(
    tabId,
    candidates,
    "the input field for entering the visit window's start day (the earliest allowed day, as a number, possibly negative)",
    irPath,
    "create_visit_find_window_start_field"
  );
  await typeText(tabId, candidates.find((c) => c.markNumber === startField.markNumber), String(windowStartDay));

  candidates = await perceiveCandidates(tabId);
  const endField = await locateOrEscalate(
    tabId,
    candidates,
    "the input field for entering the visit window's end day (the latest allowed day, as a number)",
    irPath,
    "create_visit_find_window_end_field"
  );
  await typeText(tabId, candidates.find((c) => c.markNumber === endField.markNumber), String(windowEndDay));

  await writeRecord({
    ir_path: irPath,
    step: "create_visit_fill_fields",
    action_taken: `typed name="${name}", windowStartDay=${windowStartDay}, windowEndDay=${windowEndDay}`,
    decide_reasoning: `Name field: ${nameField.reasoning} | Start field: ${startField.reasoning} | End field: ${endField.reasoning}`,
    confidence: Math.min(nameField.confidence, startField.confidence, endField.confidence),
    gate_outcome: "auto",
    confirm_result: "not_yet_confirmed",
  });

  // Step 4: GATE. The human sees exactly what is about to become permanent. Always escalates
  // per the interim policy (reversibility unknown, until Phase 6's probe exists).
  const description = `Create visit "${name}" (window: day ${windowStartDay} to day ${windowEndDay})`;
  const approved = await requestHumanApproval(description, { name, windowStartDay, windowEndDay });

  await writeRecord({
    ir_path: irPath,
    step: "create_visit_gate",
    action_taken: "requested_human_approval",
    decide_reasoning: description,
    confidence: 1,
    gate_outcome: approved ? "approved" : "rejected",
    confirm_result: approved ? "pending_save" : "not_saved",
  });

  if (!approved) {
    console.warn(`[createVisit] rejected by human for visit "${name}" — leaving the draft unsaved`);
    return { created: false, reason: "rejected_by_human" };
  }

  // Step 5: find and click Save. Save-lookalikes are a known trap — locateElement's semantic
  // reasoning, not a label match, is what protects against clicking one here.
  candidates = await perceiveCandidates(tabId);
  const saveButton = await locateOrEscalate(
    tabId,
    candidates,
    "the button that actually saves and permanently creates this new visit (not a template, preview, or cancel action)",
    irPath,
    "create_visit_find_save_button"
  );
  await clickCandidate(tabId, candidates.find((c) => c.markNumber === saveButton.markNumber));

  // Step 6: CONFIRM. Independently re-check the visit is genuinely there, rather than trusting
  // the Save click's apparent success.
  const confirmResult = await confirmVisible(
    tabId,
    [name, String(windowStartDay), String(windowEndDay)],
    "This should be a Visit Schedule / study visit list."
  );

  await writeRecord({
    ir_path: irPath,
    step: "create_visit_confirm",
    action_taken: `clicked save (mark #${saveButton.markNumber})`,
    decide_reasoning: `${saveButton.reasoning} | Confirm: ${confirmResult.reasoning} (method: ${confirmResult.method})`,
    confidence: saveButton.confidence,
    gate_outcome: "auto",
    confirm_result: confirmResult.matches ? "confirmed_visible" : "confirm_failed",
  });

  if (!confirmResult.matches) {
    await logEscalation(
      "CreateVisit",
      "create_visit_confirm_failed",
      `After clicking Save, the visit "${name}" (window ${windowStartDay} to ${windowEndDay}) could not be confirmed visible (method: ${confirmResult.method}): ${confirmResult.reasoning}`
    );
    throw new CreateVisitEscalatedError("create_visit_confirm_failed", { name, windowStartDay, windowEndDay });
  }

  return { created: true };
}