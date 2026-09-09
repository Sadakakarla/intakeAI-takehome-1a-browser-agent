// Phase 6.2 — existence checks used by the reconciliation walk to decide whether a visit, form,
// or field already exists before building it. Each function assumes the caller has already
// navigated to the right screen (via createVisit.js's ensureOnVisitScheduleOrEscalate,
// createForm.js's navigateToVisitDocumentsOrEscalate, or createField.js's
// ensureOnFormEditorOrEscalate) — these functions only read what's currently on screen, they
// never navigate themselves. Uses confirmVisible's existing free structural scan (the same tool
// already proven for Confirm steps elsewhere in this project) rather than a new perception
// primitive, since "is this text visible" is exactly what an existence check needs.
//
// Field-level existence is deliberately NOT a per-field confirmVisible call — reading every
// currently-present field label in ONE perception pass and checking against that in-memory set
// is both cheaper (one perception call per form instead of one per field) and, since it reads
// real, current on-screen state after a real navigation, at least as reliable.

import { getAllAccessibleText } from "./perception.js";
import { confirmVisible } from "./confirmVisible.js";
import { writeRecord } from "./record.js";

// Checks whether a visit with this exact name already appears on the current screen. Call only
// after navigating to the Visit Schedule (createVisit.js's ensureOnVisitScheduleOrEscalate) —
// this function does no navigation of its own.
export async function visitExists(tabId, visitName, irPath) {
  const result = await confirmVisible(
    tabId,
    [visitName],
    "This should be the study's top-level Visit Schedule."
  );
  await writeRecord({
    ir_path: irPath,
    step: "reconcile_check_visit_exists",
    action_taken: "confirm_visible_scan",
    decide_reasoning: `[method: ${result.method}] ${result.reasoning}`,
    confidence: result.matches ? 1 : 0,
    gate_outcome: "auto",
    confirm_result: result.matches ? "already_exists" : "not_found",
  });
  return result.matches;
}

// Checks whether a form with this exact name already appears on the current screen. Call only
// after navigating to the visit's Source Documents list (createForm.js's
// navigateToVisitDocumentsOrEscalate) — this function does no navigation of its own.
export async function formExists(tabId, formName, irPath) {
  const result = await confirmVisible(
    tabId,
    [formName],
    "This should be a visit's Source Documents / forms list."
  );
  await writeRecord({
    ir_path: irPath,
    step: "reconcile_check_form_exists",
    action_taken: "confirm_visible_scan",
    decide_reasoning: `[method: ${result.method}] ${result.reasoning}`,
    confidence: result.matches ? 1 : 0,
    gate_outcome: "auto",
    confirm_result: result.matches ? "already_exists" : "not_found",
  });
  return result.matches;
}

export async function scanExistingFieldLabels(tabId, formName, formFieldLabels, irPath) {
  const allText = await getAllAccessibleText(tabId);
  const sortedLabels = [...formFieldLabels].sort((a, b) => b.length - a.length);

  const found = new Set();
  for (const text of allText) {
    const lowerText = text.trim().toLowerCase();
    const match = sortedLabels.find((label) => lowerText.includes(label.trim().toLowerCase()));
    if (match) found.add(match);
  }

  await writeRecord({
    ir_path: irPath,
    step: "reconcile_scan_existing_fields",
    action_taken: "single_perception_pass",
    decide_reasoning: `Scanned form "${formName}"'s editor once against ${formFieldLabels.length} known field label(s) from the IR; matched ${found.size} as already present.`,
    confidence: 1,
    gate_outcome: "auto",
    confirm_result: "scan_complete",
  });
  return found;
}