// Phase 6 — the real top-level driver: walks a full IR in a single fresh run, all visits →
// all forms → all fields, in IR order, calling the existing per-level builders (createVisit,
// createForm, createField). Includes the run-level escalation policy (Gap #12), live-perception
// reconciliation (6.2 — see reconciliation.js and the exists-before-create checks below),
// skip-logic wiring (6.3 — createField.js's own Stage 3e does the actual UI work; this file's job
// is only resolving each rule's controlling-field code/label before handing it off, see
// resolveSkipLogic below), Draft→Activate (6.4 — createForm.js's activateForm does the actual UI
// work; this file's job is deciding WHETHER a form is genuinely ready for it, see the strict
// pre-activate checks in buildOneForm below), and the form reuse-probe (6.6 — formReuseProbe.js
// does the actual probing/caching; this file's job is calling it once per distinct form
// definition and, regardless of its result, always building the form fresh afterward — see
// buildOneForm below). The reversibility probe (6.5) and cross-bucket concurrency (6.7) are
// deliberately out of scope for this submission — see §14's "Deferred to README" note in the
// progress log.
//
// Known, deliberate limitations of this step — disclosed here rather than hidden:
//  - Every occurrence of a recurring form definition (e.g. Vital Signs at all four visits) is
//    still rebuilt fully from scratch every time, even when 6.6's probe finds a genuine
//    reuse/attach mechanism — a positive result is disclosed as an escalation for a human to
//    review, never acted on automatically. See formReuseProbe.js for the full reasoning.
//  - Visit creation keeps its current interim policy (always escalate to the Gate, regardless of
//    confidence) unconditionally — deferred, see above.

import { runOrient, OrientEscalatedError } from "./orient.js";
import { createVisit, CreateVisitEscalatedError, ensureOnVisitScheduleOrEscalate } from "./createVisit.js";
import { createForm, CreateFormEscalatedError, activateForm, navigateToVisitDocumentsOrEscalate } from "./createForm.js";
import { createField, CreateFieldEscalatedError, ensureOnFormEditorOrEscalate } from "./createField.js";
import { visitExists, formExists, scanExistingFieldLabels } from "./reconciliation.js";
import { resetTypeMappingCache } from "./typeMappingCache.js";
import { resetSaveButtonCache } from "./saveButtonCache.js";
import { resetFormEditorStateCache } from "./formEditorStateCache.js";
import { resetSkipLogicPanelCache } from "./skipLogicPanelCache.js";
import { resetFormReuseCache } from "./formReuseCache.js";
import { probeFormReuseOnce } from "./formReuseProbe.js";
import { getLoadedIr } from "./ir-store.js";
import { BudgetExhaustedError } from "./governor.js";
import { writeRecord } from "./record.js";

const ESCALATION_STORAGE_KEY = "escalationLog";

// Same tiny shape already duplicated, deliberately, in createForm.js and createField.js — kept
// consistent with that established convention rather than introducing a shared import for one
// small utility.
async function logEscalation(prefix, reason, message) {
  const { [ESCALATION_STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(ESCALATION_STORAGE_KEY);
  existing.push(`[${prefix}] ${reason}: ${message}`);
  await chrome.storage.local.set({ [ESCALATION_STORAGE_KEY]: existing });
}

let stopRequested = false;

export function requestStop() {
  stopRequested = true;
}

export function clearStopRequest() {
  stopRequested = false;
}

export function isStopRequested() {
  return stopRequested;
}

const CIRCUIT_BREAKER_THRESHOLD = 5;

function makeRunId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `run-${Date.now()}`;
}

function attachPartialProgress(error, partial) {
  error.partialProgress = partial;
  return error;
}

function visitIrPath(visit) {
  return `visit[${visit.name}]`;
}
function formIrPath(visit, form) {
  return `${visitIrPath(visit)}.form[${form.name}]`;
}
function fieldIrPath(visit, form, field) {
  return `${formIrPath(visit, form)}.field[${field.label}]`;
}

// Resolves an IR field's skip_logic (if present) into the fully-resolved shape createField.js's
// Stage 3e expects: { whenFieldLabel, equalsCode, equalsLabel }. This resolution needs the WHOLE
// form's field list (to find the controlling field's own IR entry), which is why it lives here in
// the driver rather than inside createField itself — createField operates on one field's spec at
// a time, by design, and should never need to reach across to a sibling field's definition.
//
// equalsLabel is resolved only when the controlling field genuinely carries a coded options list
// (single_select/multi_select/radio/checkbox) — looked up by matching equals_value against each
// option's own code, per the IR schema's own note that equals_value IS a code for coded fields. A
// boolean controlling field has no options list at all; its equals_value is already the literal
// "Yes"/"No" string the schema promises, so that same string is used as both equalsCode and
// equalsLabel — there is nothing further to resolve. Any other controlling-field shape (not
// expected by the current IR, per that same schema note, but not assumed away either) falls back
// to equalsLabel: null, leaving Stage 3e's own code-first/label-fallback matching to work with
// whatever it can rather than this function guessing on its behalf.
function resolveSkipLogic(irField, formFields) {
  const { skip_logic } = irField;
  if (!skip_logic) return undefined;

  const { when_field_label: whenFieldLabel, equals_value: equalsCode } = skip_logic;
  const controllingField = formFields.find((f) => f.label === whenFieldLabel);

  if (controllingField && Array.isArray(controllingField.options)) {
    const matchedOption = controllingField.options.find((o) => o.code === equalsCode);
    return { whenFieldLabel, equalsCode, equalsLabel: matchedOption ? matchedOption.label : null };
  }

  if (controllingField && controllingField.type === "boolean") {
    return { whenFieldLabel, equalsCode, equalsLabel: equalsCode };
  }

  return { whenFieldLabel, equalsCode, equalsLabel: null };
}

function toFieldSpec(irField, irPath, formFields) {
  const spec = { label: irField.label, type: irField.type, required: irField.required, irPath };
  if (irField.options !== undefined) spec.options = irField.options;
  if (irField.min !== undefined) spec.min = irField.min;
  if (irField.max !== undefined) spec.max = irField.max;
  if (irField.units !== undefined) spec.units = irField.units;
  if (irField.formula !== undefined) spec.formula = irField.formula;
  const skipLogic = resolveSkipLogic(irField, formFields);
  if (skipLogic !== undefined) spec.skip_logic = skipLogic;
  return spec;
}

function fieldStub(visit, form, field, status, reason) {
  return { label: field.label, irPath: fieldIrPath(visit, form, field), status, reason };
}
function formStub(visit, form, status, reason) {
  return {
    name: form.name,
    irPath: formIrPath(visit, form),
    status,
    reason,
    fields: form.fields.map((field) => fieldStub(visit, form, field, status, reason)),
  };
}
function visitStub(visit, status, reason) {
  return {
    name: visit.name,
    irPath: visitIrPath(visit),
    status,
    reason,
    forms: visit.forms.map((form) => formStub(visit, form, status, reason)),
  };
}

function createRunTracker(runId) {
  const summary = { runId, startedAt: new Date().toISOString(), visits: [] };
  let consecutiveFailures = 0;
  let circuitTripped = false;
  let circuitTripReason = null;

  return {
    summary,
    // Stopping is either the circuit breaker tripping (a structural break, detected internally)
    // or a person clicking Stop Build (an external request, checked here). Both use the exact
    // same "stop cleanly at the next loop boundary" mechanism — this is the one place that
    // decides whether either condition currently holds.
    isTripped: () => circuitTripped || isStopRequested(),
    isCircuitBreakerTrip: () => circuitTripped,
    isUserStop: () => !circuitTripped && isStopRequested(),
    tripReason: () => {
      if (circuitTripped) return circuitTripReason;
      if (isStopRequested()) return "the run was stopped from the side panel";
      return null;
    },
    recordSuccess() {
      consecutiveFailures = 0;
    },
    recordHardFailure() {
      consecutiveFailures += 1;
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !circuitTripped) {
        circuitTripped = true;
        circuitTripReason = `${consecutiveFailures} consecutive hard escalations with no successful build in between`;
      }
    },
    recordRejection() {},
  };
}

async function buildOneField(tabId, formName, visit, form, field, tracker) {
  const irPath = fieldIrPath(visit, form, field);
  const fieldSpec = toFieldSpec(field, irPath, form.fields);

  try {
    const result = await createField(tabId, formName, fieldSpec);
    if (result.created) {
      tracker.recordSuccess();
      return { label: field.label, irPath, status: "created" };
    }
    tracker.recordRejection();
    return { label: field.label, irPath, status: "rejected" };
  } catch (error) {
    if (error instanceof CreateFieldEscalatedError) {
      tracker.recordHardFailure();
      return { label: field.label, irPath, status: "escalated", reason: error.reason };
    }
    throw error;
  }
}

// Builds one form: the form itself, then every field under it in IR order. Phase 6.2: before
// deciding to create anything, navigates to the visit's documents list and checks whether the
// form already exists — if so, skips CREATE FORM entirely but still descends into its fields,
// since a partially-built form needs finishing, not skipping outright. Once the form is known to
// exist (either just-created or found), navigates into its editor and reads every currently-
// present field label in ONE perception pass (scanExistingFieldLabels) — each field then checks
// against that in-memory set for free, rather than paying a per-field existence check. If the
// form itself fails or is rejected, every field under it is recorded as skipped due to that
// dependency. If the circuit breaker trips partway through this form's fields, every remaining
// field is recorded as not attempted rather than left out of the summary entirely.
//
// Known, disclosed inefficiency, not fixed here: when the form does NOT already exist,
// createForm() below performs its own internal navigation as its own first step, redoing the
// same navigateToVisitDocumentsOrEscalate call already made just above it. This is real,
// avoidable extra cost, but bounded (28 forms per run at most) and safe — accepted for now rather
// than restructuring createForm's public signature to accept a "skip navigation" flag, consistent
// with this project's practice of not adding complexity ahead of real evidence it's worth it.
async function buildOneForm(tabId, visit, form, tracker) {
  const irPath = formIrPath(visit, form);
  let formResult;

  try {
    await navigateToVisitDocumentsOrEscalate(tabId, visit.name, irPath);
    const alreadyExists = await formExists(tabId, form.name, irPath);

    if (alreadyExists) {
      tracker.recordSuccess();
      formResult = { name: form.name, irPath, status: "already_exists" };
    } else {
      // Phase 6.6: probe once per distinct form definition whether this platform supports
      // reusing/attaching an existing form instead of building from scratch. Never gates the
      // build that follows — regardless of what it finds, the form is always built fresh right
      // after, exactly as before. A genuine positive result is only ever disclosed as a
      // non-blocking escalation, never acted on automatically. See formReuseProbe.js.
      await probeFormReuseOnce(tabId, form.name, form.fields, irPath);

      const result = await createForm(tabId, visit.name, {
        name: form.name,
        repeating: form.repeating,
        irPath,
      });
      if (result.created) {
        tracker.recordSuccess();
        formResult = { name: form.name, irPath, status: "created" };
      } else {
        tracker.recordRejection();
        formResult = { name: form.name, irPath, status: "rejected" };
      }
    }
  } catch (error) {
    if (error instanceof CreateFormEscalatedError) {
      tracker.recordHardFailure();
      formResult = { name: form.name, irPath, status: "escalated", reason: error.reason };
    } else {
      throw error;
    }
  }

  if (formResult.status !== "created" && formResult.status !== "already_exists") {
    const reason = `skipped — form "${form.name}" was not created (${formResult.status})`;
    formResult.fields = form.fields.map((field) => fieldStub(visit, form, field, "skipped_dependency", reason));
    return formResult;
  }

  // Phase 6.2: one scan of this form's editor tells us which fields already exist. Called
  // explicitly here rather than assumed — neither "form just created" nor "form already existed"
  // guarantees the browser is currently sitting inside that form's editor.
  let existingLabels;
  try {
    await ensureOnFormEditorOrEscalate(tabId, form.name, irPath);
    existingLabels = await scanExistingFieldLabels(tabId, form.name, form.fields.map((f) => f.label), irPath);
  } catch (error) {
    if (error instanceof CreateFieldEscalatedError) {
      tracker.recordHardFailure();
      const reason = `could not scan form "${form.name}"'s existing fields before building: ${error.reason}`;
      formResult.fields = form.fields.map((field) => fieldStub(visit, form, field, "escalated", reason));
      return formResult;
    }
    throw error;
  }

  formResult.fields = [];
  for (let i = 0; i < form.fields.length; i += 1) {
    if (tracker.isTripped()) {
      const reason = `not attempted — the run stopped: ${tracker.tripReason()}`;
      formResult.fields.push(
        ...form.fields.slice(i).map((field) => fieldStub(visit, form, field, "not_attempted", reason))
      );
      break;
    }

    const field = form.fields[i];
    if (existingLabels.has(field.label)) {
      tracker.recordSuccess();
      formResult.fields.push({ label: field.label, irPath: fieldIrPath(visit, form, field), status: "already_exists" });
      continue;
    }

    try {
      const fieldResult = await buildOneField(tabId, form.name, visit, form, field, tracker);
      formResult.fields.push(fieldResult);
    } catch (error) {
      formResult.fields.push(
        fieldStub(visit, form, field, "aborted", `build interrupted by an unexpected error: ${error.message}`)
      );
      throw attachPartialProgress(error, formResult);
    }
  }

  // Phase 6.4: Draft → Activate — deliberately strict, since activating a form that's actually
  // incomplete risks Mock A's own documented version-bump/edit-lockout trap (Gap #5). THREE
  // independent checks must ALL hold before this ever attempts anything: (1) the run wasn't
  // stopped partway through this form's own field loop; (2) every field this form's IR entry
  // names has a recorded outcome, and every one of them is "created" or "already_exists" — no
  // escalation, rejection, or not-attempted field anywhere; (3) a FRESH, independent live re-scan
  // of the form's editor — not a reuse of this function's own in-memory tracking — genuinely finds
  // every one of those field labels on screen right now. Checks 1–2 failing is the ordinary,
  // already-explained case (something elsewhere already recorded why) and is simply skipped, not
  // escalated again for the same reason. Check 3 failing when 1–2 both said "clean" is a genuine,
  // surprising contradiction between this driver's own bookkeeping and live reality — that IS
  // escalated, never silently tolerated, per Gap #2's "verify what you built" principle applied
  // here to the activation decision itself, not just existence-checking.
  const allFieldsAccountedFor = formResult.fields.length === form.fields.length;
  const cleanByBookkeeping =
    !tracker.isTripped() &&
    allFieldsAccountedFor &&
    formResult.fields.every((f) => f.status === "created" || f.status === "already_exists");

  if (!cleanByBookkeeping) {
    formResult.activated = false;
    return formResult;
  }

  try {
    await ensureOnFormEditorOrEscalate(tabId, form.name, irPath);
    const liveLabels = await scanExistingFieldLabels(tabId, form.name, form.fields.map((f) => f.label), irPath);
    const missingLive = form.fields.filter((f) => !liveLabels.has(f.label));

    if (missingLive.length > 0) {
      const reason =
        "This driver's own tracking recorded every field as built, but a fresh live re-scan just " +
        `before Activate did not find: ${missingLive.map((f) => f.label).join(", ")}. Activating ` +
        "on this contradiction would risk locking in a form that isn't actually complete.";
      tracker.recordHardFailure();
      formResult.activated = false;
      formResult.activateEscalationReason = "create_form_activate_precheck_mismatch";
      await writeRecord({
        ir_path: irPath,
        step: "create_form_activate_precheck",
        action_taken: "fresh_live_rescan",
        decide_reasoning: reason,
        confidence: 0,
        gate_outcome: "escalated",
        confirm_result: "precheck_mismatch",
      });
      await logEscalation("Driver", "create_form_activate_precheck_mismatch", reason);
    } else {
      const activateResult = await activateForm(tabId, form.name, irPath);
      tracker.recordSuccess();
      formResult.activated = true;
      formResult.alreadyActive = activateResult.alreadyActive;
    }
  } catch (error) {
    if (error instanceof CreateFieldEscalatedError || error instanceof CreateFormEscalatedError) {
      tracker.recordHardFailure();
      formResult.activated = false;
      formResult.activateEscalationReason = error.reason;
    } else {
      throw error;
    }
  }

  return formResult;
}

// Builds one visit: the visit itself, then every form under it in IR order. Phase 6.2: same
// exists-before-create shape as buildOneForm, one level up — navigates to the Visit Schedule and
// checks existence before deciding whether to call createVisit, and still descends into a
// visit's forms whether it was just created or found already present. Same disclosed, accepted
// double-navigation inefficiency as buildOneForm when a visit does need creating.
async function buildOneVisit(tabId, visit, tracker) {
  const irPath = visitIrPath(visit);
  let visitResult;

  try {
    await ensureOnVisitScheduleOrEscalate(tabId, irPath);
    const alreadyExists = await visitExists(tabId, visit.name, irPath);

    if (alreadyExists) {
      tracker.recordSuccess();
      visitResult = { name: visit.name, irPath, status: "already_exists" };
    } else {
      const result = await createVisit(tabId, {
        name: visit.name,
        windowStartDay: visit.window_start_day,
        windowEndDay: visit.window_end_day,
        irPath,
      });
      if (result.created) {
        tracker.recordSuccess();
        visitResult = { name: visit.name, irPath, status: "created" };
      } else {
        tracker.recordRejection();
        visitResult = { name: visit.name, irPath, status: "rejected" };
      }
    }
  } catch (error) {
    if (error instanceof CreateVisitEscalatedError) {
      tracker.recordHardFailure();
      visitResult = { name: visit.name, irPath, status: "escalated", reason: error.reason };
    } else {
      throw error;
    }
  }

  if (visitResult.status !== "created" && visitResult.status !== "already_exists") {
    const reason = `skipped — visit "${visit.name}" was not created (${visitResult.status})`;
    visitResult.forms = visit.forms.map((form) => formStub(visit, form, "skipped_dependency", reason));
    return visitResult;
  }

  visitResult.forms = [];
  for (let i = 0; i < visit.forms.length; i += 1) {
    if (tracker.isTripped()) {
      const reason = `not attempted — the run stopped: ${tracker.tripReason()}`;
      visitResult.forms.push(
        ...visit.forms.slice(i).map((form) => formStub(visit, form, "not_attempted", reason))
      );
      break;
    }
    try {
      const formResult = await buildOneForm(tabId, visit, visit.forms[i], tracker);
      visitResult.forms.push(formResult);
    } catch (error) {
      const partialForm =
        error.partialProgress ||
        formStub(visit, visit.forms[i], "aborted", `build interrupted by an unexpected error: ${error.message}`);
      visitResult.forms.push(partialForm);
      throw attachPartialProgress(error, visitResult);
    }
  }

  return visitResult;
}

function flattenFields(summary) {
  const all = [];
  for (const visit of summary.visits) {
    for (const form of visit.forms) {
      all.push(...form.fields);
    }
  }
  return all;
}

const STATUS_MARKER = {
  created: "✓",
  already_exists: "○",
  escalated: "✗",
  rejected: "✗",
  skipped_dependency: "—",
  not_attempted: "…",
  aborted: "!",
};

function printSummary(summary) {
  const allFields = flattenFields(summary);
  const counts = allFields.reduce((acc, f) => {
    acc[f.status] = (acc[f.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`\n[driver] ===== Run ${summary.runId} summary =====`);
  console.log(`[driver] started: ${summary.startedAt} | finished: ${summary.finishedAt}`);
  console.log(
    `[driver] fields — total: ${allFields.length}, created: ${counts.created || 0}, ` +
      `already existed: ${counts.already_exists || 0}, escalated: ${counts.escalated || 0}, ` +
      `rejected: ${counts.rejected || 0}, skipped (dependency): ${counts.skipped_dependency || 0}, ` +
      `not attempted: ${counts.not_attempted || 0}, aborted: ${counts.aborted || 0}`
  );
  if (summary.circuitBreakerTripped) {
    console.warn(`[driver] STOPPED EARLY — circuit breaker: ${summary.tripReason}`);
  }
  if (summary.abortedWithError) {
    console.error(`[driver] STOPPED — unexpected error: ${summary.abortedWithError}`);
  }

  for (const visit of summary.visits) {
    console.log(`\n[driver] VISIT "${visit.name}" — ${visit.status}${visit.reason ? ` (${visit.reason})` : ""}`);
    for (const form of visit.forms) {
      console.log(`[driver]   FORM "${form.name}" — ${form.status}${form.reason ? ` (${form.reason})` : ""}`);
      for (const field of form.fields) {
        const marker = STATUS_MARKER[field.status] || "?";
        console.log(`[driver]     ${marker} "${field.label}" — ${field.status}${field.reason ? `: ${field.reason}` : ""}`);
      }
    }
  }
  console.log(`\n[driver] ===== end summary =====\n`);
}

async function persistLastRunSummary(summary) {
  try {
    await chrome.storage.local.set({ lastRunSummary: summary });
  } catch (error) {
    console.warn("[driver] failed to persist last-run summary for the side panel:", error.message);
  }
}

export async function runFullBuild(tabId) {
  const loaded = await getLoadedIr();
  if (!loaded) {
    throw new Error(
      "No study input file has been loaded yet — upload one from the side panel before starting a run."
    );
  }
  const ir = loaded.ir;

  const runId = makeRunId();
  console.log(`[driver] starting run ${runId} against "${loaded.sourceFilename}" (loaded ${loaded.loadedAt})`);

  // A fresh run must never inherit a stop request left over from a previous run that was
  // stopped by a person — otherwise the very first loop-boundary check would halt the new run
  // before it ever attempted anything.
  clearStopRequest();
  await chrome.storage.local.set({ driverRunState: "running" });

  try {
    await resetTypeMappingCache();
    resetSaveButtonCache();
    resetFormEditorStateCache();
    resetSkipLogicPanelCache();
    resetFormReuseCache();
    await chrome.storage.local.set({ escalationLog: [] });

    try {
      await runOrient(tabId);
    } catch (error) {
      if (error instanceof OrientEscalatedError) {
        console.error(
          `[driver] run ${runId} could not start: Orient escalated (${error.reason}) — the agent ` +
            "could not confirm it was looking at a usable starting screen."
        );
      }
      throw error;
    }

    const tracker = createRunTracker(runId);

    try {
      for (let i = 0; i < ir.visits.length; i += 1) {
        if (tracker.isTripped()) {
          const reason = `not attempted — the run stopped: ${tracker.tripReason()}`;
          tracker.summary.visits.push(
            ...ir.visits.slice(i).map((visit) => visitStub(visit, "not_attempted", reason))
          );
          break;
        }
        try {
          const visitResult = await buildOneVisit(tabId, ir.visits[i], tracker);
          tracker.summary.visits.push(visitResult);
        } catch (error) {
          const partialVisit =
            error.partialProgress ||
            visitStub(ir.visits[i], "aborted", `build interrupted by an unexpected error: ${error.message}`);
          tracker.summary.visits.push(partialVisit);
          throw error;
        }
      }
      if (tracker.isTripped()) {
        tracker.summary.circuitBreakerTripped = tracker.isCircuitBreakerTrip();
        tracker.summary.stoppedByUser = tracker.isUserStop();
        tracker.summary.tripReason = tracker.tripReason();
      }
    } catch (error) {
      tracker.summary.abortedWithError = error.message;
      tracker.summary.finishedAt = new Date().toISOString();
      if (error instanceof BudgetExhaustedError) {
        console.warn(
          `[driver] STOPPED — the LLM daily token budget was exhausted mid-run (${error.message}). ` +
            "Per Gap #7, this is meant to be a safe, resumable stop: reconciliation state is left " +
            "exactly where it is. Re-running is safe once budget is available."
        );
      }
      await persistLastRunSummary(tracker.summary);
      printSummary(tracker.summary);
      throw error;
    }

    tracker.summary.finishedAt = new Date().toISOString();
    await persistLastRunSummary(tracker.summary);
    printSummary(tracker.summary);
    return tracker.summary;
  } finally {
    // Always runs — clean finish, circuit-breaker trip, user stop, or a genuine crash — so the
    // side panel's Start/Stop buttons never get stuck reflecting a run that has actually ended.
    clearStopRequest();
    await chrome.storage.local.set({ driverRunState: "idle" });
  }
}