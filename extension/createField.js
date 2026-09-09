// CREATE FIELD — the real 7-step-loop implementation: opens a form's editor, decides the correct
// element-library entry for the field's canonical type, adds and selects it, sets Label,
// Required, coded Options, and any Range Check in the Options panel, gates, saves (via the
// Save-lookalike retry rule), and confirms.
//
// Label/Required/Options-locate use LOCATE first (locateCheapOrEscalate — a free, $0 literal
// accessible-label match via locateByLabel.js), falling back to the paid semantic DECIDE-style
// locate only if that fails — these are near-universal property-panel terms, categorically
// different from an element-library's widget-type naming (see typeMapping.js's own comment on
// why THAT needs semantic reasoning instead). Everything else in this file still uses the paid
// semantic locate directly, since those targets (the type-mapping decision, the Save button) are
// exactly the kind of platform-specific, unpredictably-worded controls LOCATE's free path was
// never expected to reliably handle.

import { perceiveCandidates, getAllAccessibleText, getNativeSelectOptions } from "./perception.js";
import { clickCandidate, clearAndType, setCheckedState, diffNewCandidates, diffNewText, typeAheadSelect } from "./actions.js";
import { locateElement } from "./locateElement.js";
import { confirmVisible } from "./confirmVisible.js";
import { confirmFormEditorScreen } from "./confirmFormEditorScreen.js";
import { requestHumanApproval } from "./gate.js";
import { captureCroppedAnnotatedScreenshot } from "./som-overlay.js";
import { writeRecord } from "./record.js";
import { locateByLabel } from "./locateByLabel.js";
import { describeCanonicalType, expectedStructuralRoles } from "./typeMapping.js";
import { getTypeMappingCacheEntry, setTypeMappingCacheEntry, setNegativeCacheEntry } from "./typeMappingCache.js";
import { getSaveButtonCacheEntry, setSaveButtonCacheEntry, invalidateSaveButtonCacheEntry } from "./saveButtonCache.js";
import { getFormEditorState, setFormEditorState } from "./formEditorStateCache.js";
import { getSkipLogicPanelCacheEntry, setSkipLogicPanelCacheEntry } from "./skipLogicPanelCache.js";
import { callGroqJsonWithRetry } from "./groq-json-retry.js";

const ESCALATION_STORAGE_KEY = "escalationLog";
const LOCATE_CONFIDENCE_FLOOR = 0.6;
const TYPE_MAPPING_CONFIDENCE_FLOOR = 0.6;
const AUTO_BUILD_CONFIDENCE_FLOOR = 0.85;
const MAX_FIELD_SELECTION_ATTEMPTS = 3;
const MAX_SAVE_ATTEMPTS = 2;

export class CreateFieldEscalatedError extends Error {
  constructor(reason, details = {}) {
    super(`CREATE FIELD escalated: ${reason}`);
    this.name = "CreateFieldEscalatedError";
    this.reason = reason;
    this.details = details;
  }
}

async function logEscalation(prefix, reason, message) {
  const { [ESCALATION_STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(ESCALATION_STORAGE_KEY);
  existing.push(`[${prefix}] ${reason}: ${message}`);
  await chrome.storage.local.set({ [ESCALATION_STORAGE_KEY]: existing });
}

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
    await logEscalation("CreateField", `${stepLabel}_locate_failed`, reasoning);
    throw new CreateFieldEscalatedError(`${stepLabel}_locate_failed`, { intentDescription });
  }
  return result;
}

// Tries the free literal-label match first; only falls back to the paid semantic locate
// (locateOrEscalate) if that fails. Returns the same shape either way, so callers don't need to
// branch on which path resolved it — only the reasoning text and confidence differ, and that
// difference is itself the evidence used to verify this path is genuinely free (see the
// project's build notes on LOCATE-freedom verification).
async function locateCheapOrEscalate(tabId, candidates, { expectedLabels, roleFilter, semanticIntent }, irPath, stepLabel) {
  const cheapMatch = locateByLabel(candidates, expectedLabels, roleFilter);
  if (cheapMatch) {
    return {
      markNumber: cheapMatch.markNumber,
      confidence: 1,
      reasoning: `Matched literally by accessible label (free, no LLM call): "${cheapMatch.name}"`,
    };
  }
  console.warn(`[createField] cheap literal match failed for ${stepLabel} — falling back to paid semantic locate`);
  return locateOrEscalate(tabId, candidates, semanticIntent, irPath, stepLabel);
}

// Attempts to re-find a previously cached type-mapping candidate on the current screen by exact
// accessible-name and role match. Cache entries only ever come from a real candidate already
// confirmed present on this same platform, so this is not a fresh semantic guess — it is
// re-finding a known thing, the same trust level LOCATE's own free literal-label path already
// relies on elsewhere in this file.
function locateByCachedSignature(candidates, cacheEntry) {
  return candidates.find((c) => c.role === cacheEntry.axRole && c.name === cacheEntry.label) || null;
}

// Resolves the element-library entry for a field's canonical type: checks the in-run
// type-mapping cache first, and on a miss runs a fresh semantic locate. Deliberately scoped to
// the type-mapping decision alone rather than folded into locateOrEscalate, which is shared by
// unrelated locate targets in this file (the Save button) that are not designed to route through
// Gate on low confidence. A present-but-uncertain type mapping is treated as the genuine
// human-in-the-loop case the architecture describes: a real candidate exists, so it is escalated
// to the existing approval gate rather than aborting the field outright. A true absence of any
// matching candidate is not recoverable the same way and is still treated as a hard escalation,
// now also recorded as a negative cache entry so the next field of the same type doesn't repeat
// the identical, expensive failure.
async function decideTypeMappingOrEscalate(tabId, beforeAdd, type, irPath) {
  const cached = await getTypeMappingCacheEntry(type);

  if (cached && cached.noMappingExists) {
    const reasoning =
      `Cached result: no element-library entry exists for canonical type "${type}" on this ` +
      `platform (originally discovered while building ${cached.irPathOfOrigin}) — escalating ` +
      "without repeating a known-failed lookup.";
    await writeRecord({
      ir_path: irPath,
      step: "create_field_decide_type",
      action_taken: "cache_hit_negative",
      decide_reasoning: reasoning,
      confidence: 1,
      gate_outcome: "escalated",
      confirm_result: "no_mapping_on_platform",
    });
    await logEscalation("CreateField", "create_field_no_type_mapping", reasoning);
    throw new CreateFieldEscalatedError("create_field_no_type_mapping", { type });
  }

  if (cached) {
    const rediscovered = locateByCachedSignature(beforeAdd, cached);
    if (rediscovered) {
      return {
        markNumber: rediscovered.markNumber,
        confidence: 1,
        reasoning:
          `Cache hit for canonical type "${type}" (originally resolved for ` +
          `${cached.irPathOfOrigin}, source: ${cached.source}) — re-found on this screen by ` +
          `exact label+role match: "${cached.label}" (${cached.axRole}). No semantic call made.`,
        fromCache: true,
      };
    }
    console.warn(
      `[createField] cached type mapping for "${type}" not found on this screen — falling back to a fresh Decide call`
    );
  }

  const result = await locateElement(tabId, beforeAdd, describeCanonicalType(type));

  if (!result.found) {
    const reasoning = `No candidate matching canonical type "${type}" found at all: ${result.reasoning}`;
    await writeRecord({
      ir_path: irPath,
      step: "create_field_decide_type",
      action_taken: "locate_element",
      decide_reasoning: reasoning,
      confidence: result.confidence,
      gate_outcome: "escalated",
      confirm_result: "not_found",
    });
    await logEscalation("CreateField", "create_field_decide_type_not_found", reasoning);
    await setNegativeCacheEntry(type, irPath);
    throw new CreateFieldEscalatedError("create_field_decide_type_not_found", { type });
  }

  const candidate = beforeAdd.find((c) => c.markNumber === result.markNumber);

  if (result.confidence >= TYPE_MAPPING_CONFIDENCE_FLOOR) {
    if (candidate) {
      await setTypeMappingCacheEntry(type, {
        label: candidate.name,
        axRole: candidate.role,
        confidence: result.confidence,
        source: "decide",
        irPathOfOrigin: irPath,
      });
    }
    return result;
  }

  // Genuine ambiguity: a real candidate exists, but confidence is below the floor. This is the
  // human-in-the-loop case — route through the existing minimal approval gate rather than
  // hard-aborting the field build.
  const approvalDescription =
    `Uncertain type mapping for canonical type "${type}": Decide proposes "${candidate?.name ?? "unknown"}" ` +
    `(confidence ${result.confidence.toFixed(2)}, below the ${TYPE_MAPPING_CONFIDENCE_FLOOR} floor). ` +
    `Reasoning: ${result.reasoning}`;
  const approved = await requestHumanApproval(approvalDescription, {
    type,
    candidateLabel: candidate?.name,
    candidateRole: candidate?.role,
    confidence: result.confidence,
  });

  await writeRecord({
    ir_path: irPath,
    step: "create_field_decide_type_gate",
    action_taken: "requested_human_approval",
    decide_reasoning: approvalDescription,
    confidence: result.confidence,
    gate_outcome: approved ? "approved" : "rejected",
    confirm_result: approved ? "human_approved_mapping" : "human_rejected_mapping",
  });

  if (!approved) {
    await logEscalation("CreateField", "create_field_decide_type_rejected", approvalDescription);
    throw new CreateFieldEscalatedError("create_field_decide_type_rejected", { type });
  }

  if (candidate) {
    await setTypeMappingCacheEntry(type, {
      label: candidate.name,
      axRole: candidate.role,
      confidence: result.confidence,
      source: "human_approved",
      irPathOfOrigin: irPath,
    });
  }

  return { ...result, reasoning: `${result.reasoning} (human-approved after low-confidence escalation)` };
}

async function confirmFieldSelected(tabId, beforeAnythingText, newCandidates, irPath) {
  let currentText = await getAllAccessibleText(tabId);
  if (diffNewText(beforeAnythingText, currentText).length > 0) {
    return { selected: true, viaAutoSelect: true };
  }

  const attempts = newCandidates.slice(0, MAX_FIELD_SELECTION_ATTEMPTS);
  for (const candidate of attempts) {
    await clickCandidate(tabId, candidate);
    currentText = await getAllAccessibleText(tabId);
    if (diffNewText(beforeAnythingText, currentText).length > 0) {
      return { selected: true, viaAutoSelect: false, clickedCandidate: candidate };
    }
  }

  const reasoning =
    `After adding the field, neither auto-selection nor ${attempts.length} explicit candidate ` +
    "click(s) caused any new descriptive text to appear on screen — could not confirm the field " +
    "is selected for editing.";
  await writeRecord({
    ir_path: irPath,
    step: "create_field_confirm_selected",
    action_taken: "diff_new_text_check",
    decide_reasoning: reasoning,
    confidence: 0,
    gate_outcome: "escalated",
    confirm_result: "selection_not_confirmed",
  });
  await logEscalation("CreateField", "create_field_selection_failed", reasoning);
  throw new CreateFieldEscalatedError("create_field_selection_failed", { attemptsTried: attempts.length });
}

// Gap #11: a cheap, free structural sanity check, independent of DECIDE's own semantic
// reasoning. Checks whether ANY candidate newly added to this form since the field build began
// carries an AX role consistent with the field's canonical type — if so, stays silent (the
// negative case: a clean match, nothing to escalate). If none match, this is a real,
// worth-surfacing contradiction between what DECIDE picked and what actually got built —
// escalated rather than silently accepted. Skipped entirely for types with no meaningful
// structural expectation (currently just "calculated").
//
// Deliberately run at the very end of Stage 3, after Label, Required, Options, and any Range
// Check have all been set — not immediately after the element-library entry is selected. An
// earlier version of this check ran right after selection and produced a real false escalation
// on option-bearing types (radio, single_select, multi_select): on this platform, selecting the
// element-library entry alone only adds the surrounding Options-panel controls, none of which
// carry the expected role (e.g. "radio") until at least one option value actually exists. Running
// this check once, uniformly, after every Stage-3 sub-step is complete removes the need for any
// type-based special case: for types with no options (text, date, decimal, ...) this changes
// nothing, since their expected role never depended on anything set later in Stage 3 anyway.
async function structuralRoleCrossCheck(type, allNewCandidates, irPath) {
  const expectedRoles = expectedStructuralRoles(type);
  if (!expectedRoles) {
    await writeRecord({
      ir_path: irPath,
      step: "create_field_structural_role_check",
      action_taken: "skipped",
      decide_reasoning: `Canonical type "${type}" has no defined structural-role expectation to check against.`,
      confidence: 1,
      gate_outcome: "auto",
      confirm_result: "skipped_no_expectation",
    });
    return;
  }

  const matchingCandidate = allNewCandidates.find((c) => expectedRoles.includes(c.role));

  if (matchingCandidate) {
    await writeRecord({
      ir_path: irPath,
      step: "create_field_structural_role_check",
      action_taken: "cross_check_passed",
      decide_reasoning: `Expected role(s) [${expectedRoles.join(", ")}] for canonical type "${type}"; found a matching candidate (added since this field's build began) with role "${matchingCandidate.role}" — no contradiction.`,
      confidence: 1,
      gate_outcome: "auto",
      confirm_result: "no_contradiction",
    });
    return;
  }

  const foundRoles = allNewCandidates.map((c) => c.role).join(", ") || "(none)";
  const reasoning =
    `Expected role(s) [${expectedRoles.join(", ")}] for canonical type "${type}", but none of the ` +
    `candidates added since this field's build began had a matching role (found: ${foundRoles}) — ` +
    "DECIDE's semantic pick may not structurally match the intended type.";
  await writeRecord({
    ir_path: irPath,
    step: "create_field_structural_role_check",
    action_taken: "cross_check_failed",
    decide_reasoning: reasoning,
    confidence: 0,
    gate_outcome: "escalated",
    confirm_result: "contradiction_found",
  });
  await logEscalation("CreateField", "create_field_structural_role_contradiction", reasoning);
  throw new CreateFieldEscalatedError("create_field_structural_role_contradiction", { type, foundRoles });
}

// Which Options-panel targets a Range Check block can carry, per the IR schema. Only the keys
// actually present on a given fieldSpec are ever touched — nothing is invented for a key the IR
// didn't specify, and most fields (anything not integer/decimal) skip this entirely.
const RANGE_FIELD_TARGETS = [
  { key: "min", expectedLabels: ["minimum", "min"], description: "the minimum-value input in this field's Range Check" },
  { key: "max", expectedLabels: ["maximum", "max"], description: "the maximum-value input in this field's Range Check" },
  { key: "units", expectedLabels: ["units", "unit"], description: "the units input in this field's Range Check" },
];

// Exact-value comparison for a range field's read-back. Units are compared as an exact string —
// the same rigor already applied to a coded value's label — since "cm" vs "CM" is a real,
// worth-catching discrepancy. Min/Max are compared numerically rather than as exact strings: a
// platform may legitimately render 100 back as "100.0" without that being a genuine mismatch —
// the IR specifies a numeric value, not a particular string formatting of it.
function rangeValueMatches(key, expected, actualRawValue) {
  const actual = (actualRawValue ?? "").toString().trim();
  if (key === "units") return actual === String(expected).trim();
  const actualNumber = Number(actual);
  return actual !== "" && !Number.isNaN(actualNumber) && actualNumber === Number(expected);
}

// Sets and independently verifies any Min/Max/Units values present on fieldSpec. Each target is
// located via the same free, literal-label path already used for Label/Required — these are
// near-universal property-panel terms, not platform-specific element-library naming — so a
// target this platform genuinely doesn't expose surfaces as an ordinary LOCATE escalation for
// free, with no range-specific escalation logic needed for that case.
//
// Confirmation re-perceives and re-locates each target from scratch after typing, independently
// of the element just typed into — the same re-Locate-at-Confirm principle already used
// elsewhere in this file — since that is what actually catches a platform silently discarding or
// reformatting a range value it cannot hold, rather than trusting that a keystroke was sent.
async function setRangeCheckValues(tabId, fieldSpec, irPath) {
  const targets = RANGE_FIELD_TARGETS.filter(
    (t) => fieldSpec[t.key] !== undefined && fieldSpec[t.key] !== null
  );
  if (targets.length === 0) return;

  for (const target of targets) {
    const candidates = await perceiveCandidates(tabId);
    const located = await locateCheapOrEscalate(
      tabId,
      candidates,
      { expectedLabels: target.expectedLabels, roleFilter: "textbox", semanticIntent: target.description },
      irPath,
      `create_field_find_${target.key}`
    );
    await clearAndType(
      tabId,
      candidates.find((c) => c.markNumber === located.markNumber),
      String(fieldSpec[target.key])
    );
  }

  const afterCandidates = await perceiveCandidates(tabId);
  const mismatches = [];

  for (const target of targets) {
    const relocated = await locateCheapOrEscalate(
      tabId,
      afterCandidates,
      { expectedLabels: target.expectedLabels, roleFilter: "textbox", semanticIntent: target.description },
      irPath,
      `create_field_confirm_${target.key}`
    );
    const candidate = afterCandidates.find((c) => c.markNumber === relocated.markNumber);
    const expected = fieldSpec[target.key];
    if (!rangeValueMatches(target.key, expected, candidate?.value)) {
      mismatches.push({ key: target.key, expected, actual: candidate?.value });
    }
  }

  if (mismatches.length > 0) {
    const reasoning =
      "Range check value(s) did not match after setting: " +
      mismatches.map((m) => `${m.key} expected "${m.expected}", found "${m.actual}"`).join("; ") +
      ". The platform may have silently rejected or reformatted a value this field's type cannot hold.";
    await writeRecord({
      ir_path: irPath,
      step: "create_field_confirm_range",
      action_taken: "read_back_range_values",
      decide_reasoning: reasoning,
      confidence: 0,
      gate_outcome: "escalated",
      confirm_result: "range_mismatch",
    });
    await logEscalation("CreateField", "create_field_range_mismatch", reasoning);
    throw new CreateFieldEscalatedError("create_field_range_mismatch", { mismatches });
  }

  await writeRecord({
    ir_path: irPath,
    step: "create_field_confirm_range",
    action_taken: "read_back_range_values",
    decide_reasoning: `All range value(s) [${targets.map((t) => t.key).join(", ")}] confirmed matching after independent read-back.`,
    confidence: 1,
    gate_outcome: "auto",
    confirm_result: "range_confirmed",
  });
}

// Sets and independently verifies a field's formula (calculated fields only). No-op for any
// field with no `formula` on fieldSpec. "Formula" is treated as a near-universal property-panel
// term, same category as Label/Required/Min/Max/Units — so a platform genuinely lacking a
// formula affordance for calculated fields surfaces as an ordinary LOCATE escalation, consistent
// with the IR README's own "not entered by hand" framing rather than a fabricated fallback.
//
// Comparison is whitespace-normalized (collapsed runs of spaces, trimmed) rather than a strict
// byte-exact match — the platform may reformat spacing around operators without that being a
// real discrepancy in the expression itself, the same reasoning already applied to Min/Max
// tolerating "100" vs "100.0".
function normalizeFormula(value) {
  return (value ?? "").toString().trim().replace(/\s+/g, " ");
}

async function setFormulaValue(tabId, fieldSpec, irPath) {
  const { formula } = fieldSpec;
  if (!formula) return;

  let candidates = await perceiveCandidates(tabId);
  const formulaField = await locateCheapOrEscalate(
    tabId,
    candidates,
    {
      expectedLabels: ["formula"],
      roleFilter: "textbox",
      semanticIntent: "the input field for this calculated field's derivation formula",
    },
    irPath,
    "create_field_find_formula"
  );
  await clearAndType(tabId, candidates.find((c) => c.markNumber === formulaField.markNumber), formula);

  candidates = await perceiveCandidates(tabId);
  const relocated = await locateCheapOrEscalate(
    tabId,
    candidates,
    {
      expectedLabels: ["formula"],
      roleFilter: "textbox",
      semanticIntent: "the input field for this calculated field's derivation formula",
    },
    irPath,
    "create_field_confirm_formula"
  );
  const candidate = candidates.find((c) => c.markNumber === relocated.markNumber);

  if (normalizeFormula(candidate?.value) !== normalizeFormula(formula)) {
    const reasoning =
      `Formula did not match after setting: expected "${formula}", found "${candidate?.value}". ` +
      "The platform may have rejected or reformatted the expression.";
    await writeRecord({
      ir_path: irPath,
      step: "create_field_confirm_formula",
      action_taken: "read_back_formula",
      decide_reasoning: reasoning,
      confidence: 0,
      gate_outcome: "escalated",
      confirm_result: "formula_mismatch",
    });
    await logEscalation("CreateField", "create_field_formula_mismatch", reasoning);
    throw new CreateFieldEscalatedError("create_field_formula_mismatch", { expected: formula, actual: candidate?.value });
  }

  await writeRecord({
    ir_path: irPath,
    step: "create_field_confirm_formula",
    action_taken: "read_back_formula",
    decide_reasoning: `Formula confirmed matching after independent read-back: "${formula}"`,
    confidence: 1,
    gate_outcome: "auto",
    confirm_result: "formula_confirmed",
  });
}

// The semantic intent used to locate the control that governs a field's conditional-visibility
// rule. Deliberately paid/semantic, never cheap-first — unlike Label/Required/Min/Max/Units/
// Formula, this concept's real-world naming varies far too much across platforms (Skip Logic,
// Display Logic, Conditional Visibility, Branching, Visibility, "Show if...") to meet this file's
// own bar for a safe literal match; a broad-enough whitelist to catch all of those risks an
// accidental false match on an unseen platform, exactly the failure mode the cheap-first
// discipline exists to avoid. Explicitly describes both mechanisms a platform might use — a
// toggle/button to click, or a dropdown/select whose VALUE must be changed — since which one an
// unseen platform uses is not something to assume; the exact way to operate it is handled by
// revealSkipLogicSection below, not baked into this description.
const SKIP_LOGIC_REVEAL_INTENT =
  "the control in the Options panel that governs this field's conditional-visibility rule — i.e. " +
  "a setting that makes this field only appear when another field on the same form holds a " +
  "specific value (sometimes labeled Skip Logic, Display Logic, Conditional Visibility, " +
  "Visibility, or similar). This may be a simple toggle/button to click, OR a dropdown/select " +
  'whose current VALUE must be changed (e.g. from a default like "Visible" to something like ' +
  '"Visible When...", "Conditional", or "Custom") to enable the rule — find the control itself; ' +
  "NOT a Range Check, NOT the Required checkbox, and not anything already set above";

function parseSkipLogicOptionChoice(content, options) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`response was not valid JSON: ${error.message}`);
  }
  if (typeof parsed.value !== "string" || !options.some((o) => o.value === parsed.value)) {
    throw new Error(`"value" was missing or did not match any real option (got: ${JSON.stringify(parsed.value)})`);
  }
  return parsed;
}

// Given a native select's REAL option list (read via getNativeSelectOptions, since a native
// select's own closed-popup options are invisible to both the accessibility tree and any
// screenshot), asks a cheap, text-only, JSON-retry-protected model call which single option
// enables a CONDITIONAL / rule-based state — as opposed to an unconditional default like
// "Visible", "Always", or "Hidden". This is a genuinely different problem from every other locate
// in this file: there is no clickable candidate to point at, only a plain list of real strings to
// reason over, so this reuses callGroqJsonWithRetry (the project's general JSON-classification
// retry wrapper) directly rather than locateElement's candidate/mark-number-specific machinery.
async function classifyConditionalVisibilityOption(options) {
  const manifest = options.map((o) => `value="${o.value}", label="${o.label}"`).join("\n");
  const promptText =
    "A form field has a Visibility setting with the following real options:\n\n" +
    `${manifest}\n\n` +
    "Which ONE option makes this field's visibility CONDITIONAL on another field's value " +
    '(sometimes worded like "Visible When...", "Conditional", "Custom Rule", or similar) — as ' +
    'opposed to an unconditional default like "Visible", "Always", or "Hidden"?\n\n' +
    'Reply with a JSON object with exactly these keys: "value" (the exact value of the chosen ' +
    'option, copied verbatim from above) and "reasoning" (one sentence). Reply with JSON only.';

  const { parsed } = await callGroqJsonWithRetry(
    "openai/gpt-oss-120b",
    (correctionNote) => [
      {
        role: "user",
        content: [{ type: "text", text: correctionNote ? `${correctionNote}\n\n${promptText}` : promptText }],
      },
    ],
    { response_format: { type: "json_object" }, reasoning_format: "hidden", max_tokens: 800 },
    (content) => parseSkipLogicOptionChoice(content, options)
  );

  return options.find((o) => o.value === parsed.value);
}

// Reveals the conditional-visibility section for the current field and returns the candidates
// newly visible as a result. The control's own location is a single, platform-wide fact, not
// something that varies per field or per form — so it is located semantically only the first time
// any field in the whole run needs it, then re-found by exact label+role signature for every later
// rule, the same probe-once-cache-the-fact pattern already used for the Save button (per form) and
// canonical type mappings (per type), now applied at the coarsest scope this project has used it
// at, since this fact is expected to hold for the entire run regardless of which field asks.
//
// Two platform shapes are handled generically, discovered live rather than assumed (found via a
// real escalation on Mock A: a plain click on this control produced zero new candidates, because
// it turned out to be a native <select> whose value must be CHANGED, not merely clicked): (1) a
// custom-rendered toggle/dropdown, where clicking it directly reveals real, inspectable option or
// section candidates — handled by the pre-existing click-and-diff path; (2) a native <select>,
// where clicking only opens an OS-rendered popup with no new AX candidates at all. For (2), this
// never guesses or hardcodes a platform-specific option string — it reads the select's REAL
// option list via getNativeSelectOptions, asks classifyConditionalVisibilityOption which one is
// the conditional option, and drives the selection via typeAheadSelect's real keyboard events.
async function revealSkipLogicSection(tabId, irPath, stepLabel) {
  const before = await perceiveCandidates(tabId);
  const cached = getSkipLogicPanelCacheEntry();

  let target = cached
    ? before.find((c) => c.role === cached.axRole && c.name === cached.label)
    : null;

  if (!target) {
    if (cached) {
      console.warn(
        "[createField] cached skip-logic reveal affordance not found on this screen — falling back to a fresh locate"
      );
    }
    const located = await locateOrEscalate(tabId, before, SKIP_LOGIC_REVEAL_INTENT, irPath, stepLabel);
    target = before.find((c) => c.markNumber === located.markNumber);
    setSkipLogicPanelCacheEntry({ label: target.name, axRole: target.role });
  }

  await clickCandidate(tabId, target);
  const afterClick = await perceiveCandidates(tabId);
  const openedCandidates = diffNewCandidates(before, afterClick);

  if (openedCandidates.length === 0) {
    // No new candidates appeared — treat this as a native select whose real options must be read
    // directly rather than clicked.
    const options = await getNativeSelectOptions(tabId, target.backendNodeId);

    if (options.length === 0) {
      const reasoning =
        "The conditional-visibility control did not behave like a custom dropdown (clicking it " +
        "produced no new candidates), and reading it as a native <select> found no real options " +
        "either. This platform's skip-logic UI doesn't match what this logic assumes, and " +
        "guessing which control to use would risk silently wiring the rule to the wrong element.";
      await writeRecord({
        ir_path: irPath,
        step: stepLabel,
        action_taken: "reveal_skip_logic_section",
        decide_reasoning: reasoning,
        confidence: 0,
        gate_outcome: "escalated",
        confirm_result: "unexpected_control_shape",
      });
      await logEscalation("CreateField", "create_field_skip_logic_control_shape_unexpected", reasoning);
      throw new CreateFieldEscalatedError("create_field_skip_logic_control_shape_unexpected", {});
    }

    const chosenOption = await classifyConditionalVisibilityOption(options);
    await typeAheadSelect(tabId, target, chosenOption.label);
  } else {
    // A custom-rendered dropdown/section: its own opened candidates ARE inspectable. Pick the one
    // that enables a conditional/rule-based state, same cheap-first/semantic-fallback discipline
    // used everywhere else in this file.
    const cheapMatch = locateByLabel(openedCandidates, ["visible when", "conditional", "custom", "rule"], null);
    let chosen = cheapMatch;
    if (!chosen) {
      const located = await locateOrEscalate(
        tabId,
        openedCandidates,
        "the option that makes this field's visibility CONDITIONAL on another field's value, as " +
          'opposed to an unconditional default like "Visible", "Always", or "Hidden"',
        irPath,
        `${stepLabel}_choose_conditional_option`
      );
      chosen = openedCandidates.find((c) => c.markNumber === located.markNumber);
    }
    await clickCandidate(tabId, chosen);
  }

  const after = await perceiveCandidates(tabId);
  return diffNewCandidates(before, after);
}

// Determines, from the candidates newly revealed by revealSkipLogicSection, which one lets the
// user choose the controlling field (the "when field" selector) and which one accepts the value
// to compare it against (the "equals" target) — tried first via the same free literal-label match
// already used elsewhere in this file, falling back to a small semantic locate scoped to just the
// two (or few) revealed candidates if that fails. Mirrors classifyCodeLabelPosition's own
// classify-once shape for the equivalent Code-vs-Label problem in setOptionValues.
//
// A platform may reveal only the field selector up front, rendering the equals-value target only
// once a controlling field has actually been chosen (a natural staged UI — "pick which field
// first, THEN its value input appears," sometimes even typed to that specific field). This is
// treated as a legitimate, expected shape (valueTarget: null, resolved later by
// resolveStagedValueTarget) rather than an error — the earlier version of this function did not
// account for it, which handed a real zero-candidate, impossible-to-answer locate to the model and
// caused it to hallucinate a nonexistent mark number rather than honestly report "not found."
async function classifySkipLogicControls(tabId, revealedCandidates, irPath) {
  if (revealedCandidates.length === 0) {
    const reasoning =
      "Revealing this field's conditional-visibility section produced no new candidates on " +
      "screen. This platform's skip-logic UI doesn't match what this logic assumes, and guessing " +
      "which controls to use would risk silently wiring the rule to the wrong element.";
    await writeRecord({
      ir_path: irPath,
      step: "create_field_classify_skip_logic",
      action_taken: "classify_skip_logic_controls",
      decide_reasoning: reasoning,
      confidence: 0,
      gate_outcome: "escalated",
      confirm_result: "unexpected_reveal_shape",
    });
    await logEscalation("CreateField", "create_field_skip_logic_reveal_shape_unexpected", reasoning);
    throw new CreateFieldEscalatedError("create_field_skip_logic_reveal_shape_unexpected", { revealedCount: 0 });
  }

  if (revealedCandidates.length === 1) {
    return { fieldSelector: revealedCandidates[0], valueTarget: null };
  }

  const fieldCheap = locateByLabel(
    revealedCandidates,
    ["when field", "controlling field", "show when", "field"],
    null
  );
  const valueCheap = locateByLabel(revealedCandidates, ["equals value", "equals", "value"], null);

  if (fieldCheap && valueCheap && fieldCheap.markNumber !== valueCheap.markNumber) {
    return { fieldSelector: fieldCheap, valueTarget: valueCheap };
  }

  const fieldLocated = await locateOrEscalate(
    tabId,
    revealedCandidates,
    "the control for choosing WHICH other field on this form controls this field's visibility " +
      '(the "when field" selector) — as opposed to the separate control for the value to compare ' +
      "it against",
    irPath,
    "create_field_classify_skip_logic_field_selector"
  );
  const remaining = revealedCandidates.filter((c) => c.markNumber !== fieldLocated.markNumber);

  if (remaining.length === 0) {
    // Only one real candidate existed and it was just claimed as the field selector — the same
    // staged-UI shape as the single-candidate case above, just reached via the semantic path.
    return {
      fieldSelector: revealedCandidates.find((c) => c.markNumber === fieldLocated.markNumber),
      valueTarget: null,
    };
  }

  const valueLocated = await locateOrEscalate(
    tabId,
    remaining,
    "the control for entering the VALUE this rule compares the chosen controlling field against " +
      "(the equals-value target) — not the field selector itself",
    irPath,
    "create_field_classify_skip_logic_value_target"
  );

  return {
    fieldSelector: revealedCandidates.find((c) => c.markNumber === fieldLocated.markNumber),
    valueTarget: revealedCandidates.find((c) => c.markNumber === valueLocated.markNumber),
  };
}

// Resolves the equals-value target when classifySkipLogicControls reported none up front — i.e.
// a staged platform UI where the value target only appears once the controlling field has been
// chosen. Diffs against a perception snapshot taken immediately before the field selector was
// set, so whatever is genuinely new is attributed to that choice specifically, not to anything
// else already on screen.
async function resolveStagedValueTarget(tabId, beforeFieldChosen, irPath) {
  const afterFieldChosen = await perceiveCandidates(tabId);
  const newlyRevealed = diffNewCandidates(beforeFieldChosen, afterFieldChosen);

  if (newlyRevealed.length === 0) {
    const reasoning =
      "Choosing the controlling field revealed no equals-value target control at all — expected " +
      "exactly one new control to appear as a result of that choice.";
    await writeRecord({
      ir_path: irPath,
      step: "create_field_classify_skip_logic_value_target",
      action_taken: "classify_skip_logic_controls",
      decide_reasoning: reasoning,
      confidence: 0,
      gate_outcome: "escalated",
      confirm_result: "unexpected_reveal_shape",
    });
    await logEscalation("CreateField", "create_field_skip_logic_value_target_not_found", reasoning);
    throw new CreateFieldEscalatedError("create_field_skip_logic_value_target_not_found", {});
  }

  if (newlyRevealed.length === 1) {
    return newlyRevealed[0];
  }

  const cheapMatch = locateByLabel(newlyRevealed, ["equals value", "equals", "value"], null);
  if (cheapMatch) return cheapMatch;

  const located = await locateOrEscalate(
    tabId,
    newlyRevealed,
    "the control for entering the VALUE this rule compares the chosen controlling field against " +
      "(the equals-value target), which just appeared after choosing the controlling field",
    irPath,
    "create_field_classify_skip_logic_value_target_staged"
  );
  return newlyRevealed.find((c) => c.markNumber === located.markNumber);
}

// Sets the field-selector control to the controlling field's label. Two platform shapes are
// handled generically, since which one an unseen platform uses is not something to assume up
// front: (1) a custom-rendered dropdown, where clicking the selector reveals real, inspectable
// option candidates — matched by the same cheap-first/semantic-fallback pattern already used for
// the option Code/Label classification; (2) a native <select>, whose real options are not exposed
// to the accessibility tree as separate candidates at all — detected by clicking producing NO new
// candidates, and handled via typeAheadSelect's real keyboard events instead of guessing a blind
// option index. Either path is independently verified afterward by confirmSkipLogicRule's own
// read-back, so a wrong guess here is caught, never silently trusted.
async function setSkipLogicFieldSelector(tabId, fieldSelectorCandidate, whenFieldLabel, irPath) {
  const before = await perceiveCandidates(tabId);
  await clickCandidate(tabId, fieldSelectorCandidate);
  const after = await perceiveCandidates(tabId);
  const revealedOptions = diffNewCandidates(before, after);

  if (revealedOptions.length > 0) {
    const cheapMatch = locateByLabel(revealedOptions, [whenFieldLabel], null);
    let chosen = cheapMatch;
    if (!chosen) {
      const located = await locateOrEscalate(
        tabId,
        revealedOptions,
        `the option in this list whose visible text is the field named "${whenFieldLabel}"`,
        irPath,
        "create_field_select_skip_logic_controlling_field"
      );
      chosen = revealedOptions.find((c) => c.markNumber === located.markNumber);
    }
    await clickCandidate(tabId, chosen);
    return;
  }

  // No new candidates appeared after clicking — this is treated as a native, closed-popup control
  // rather than an error, and driven by real keyboard type-ahead instead.
  await typeAheadSelect(tabId, fieldSelectorCandidate, whenFieldLabel);
}

// Sets the equals-value target. Per the IR schema, equalsCode is a raw code for coded controlling
// fields and a literal "Yes"/"No" for boolean ones; equalsLabel is the same field's resolved
// human-readable label, or null when there is none to resolve (see driver.js's toFieldSpec, which
// does this resolution using the full form's field list — createField itself never has that list).
// A free-text target is filled with the raw code directly, matching both the IR's own literal
// instruction and Mock A's confirmed real behavior. A selectable target tries the code first, then
// the resolved label, since an unseen platform may present the controlling field's own options by
// either — never guessing a position, escalating instead if neither is found among the real,
// currently-visible options.
async function setSkipLogicValueTarget(tabId, valueTargetCandidate, equalsCode, equalsLabel, irPath) {
  if (valueTargetCandidate.role === "textbox") {
    await clearAndType(tabId, valueTargetCandidate, equalsCode);
    return;
  }

  const before = await perceiveCandidates(tabId);
  await clickCandidate(tabId, valueTargetCandidate);
  const after = await perceiveCandidates(tabId);
  const revealedOptions = diffNewCandidates(before, after);

  const candidatesToTry = [equalsCode, equalsLabel].filter(Boolean);
  for (const text of candidatesToTry) {
    const match = locateByLabel(revealedOptions, [text], null);
    if (match) {
      await clickCandidate(tabId, match);
      return;
    }
  }

  const located = await locateOrEscalate(
    tabId,
    revealedOptions,
    `the option matching a value of "${equalsCode}"${equalsLabel ? ` (also known as "${equalsLabel}")` : ""}`,
    irPath,
    "create_field_select_skip_logic_value"
  );
  const chosen = revealedOptions.find((c) => c.markNumber === located.markNumber);
  await clickCandidate(tabId, chosen);
}

// Independently re-locates the field-selector and value-target controls by the exact role+name
// signature captured right after classification (never a remembered element handle, per this
// project's gap #10 discipline) and compares their CURRENT reported value against what was meant
// to be set. Per §7.5's own confirmed platform research, a skip-logic rule resolves the
// controlling element by its CURRENT label at read time, not a frozen reference at the moment it
// was wired — so re-reading fresh here is what actually verifies the rule attached to the right
// field, not just that some click happened.
async function confirmSkipLogicRule(tabId, signatures, whenFieldLabel, equalsCode, equalsLabel, irPath) {
  const candidates = await perceiveCandidates(tabId);
  const fieldSelector = candidates.find(
    (c) => c.role === signatures.fieldSelector.role && c.name === signatures.fieldSelector.name
  );
  const valueTarget = candidates.find(
    (c) => c.role === signatures.valueTarget.role && c.name === signatures.valueTarget.name
  );

  const mismatches = [];
  const fieldValue = (fieldSelector?.value ?? "").toString().trim();
  if (fieldValue.toLowerCase() !== whenFieldLabel.trim().toLowerCase()) {
    mismatches.push(`controlling field: expected "${whenFieldLabel}", found "${fieldValue || "(empty)"}"`);
  }

  const targetValue = (valueTarget?.value ?? "").toString().trim();
  const acceptable = [equalsCode, equalsLabel].filter(Boolean).map((v) => v.trim());
  if (!acceptable.some((v) => v === targetValue)) {
    mismatches.push(
      `equals value: expected "${equalsCode}"${equalsLabel ? ` (or "${equalsLabel}")` : ""}, found "${targetValue || "(empty)"}"`
    );
  }

  if (mismatches.length > 0) {
    const reasoning = `Skip-logic rule did not match after wiring: ${mismatches.join("; ")}.`;
    await writeRecord({
      ir_path: irPath,
      step: "create_field_confirm_skip_logic",
      action_taken: "read_back_skip_logic",
      decide_reasoning: reasoning,
      confidence: 0,
      gate_outcome: "escalated",
      confirm_result: "skip_logic_mismatch",
    });
    await logEscalation("CreateField", "create_field_skip_logic_mismatch", reasoning);
    throw new CreateFieldEscalatedError("create_field_skip_logic_mismatch", { mismatches });
  }

  await writeRecord({
    ir_path: irPath,
    step: "create_field_confirm_skip_logic",
    action_taken: "read_back_skip_logic",
    decide_reasoning:
      `Skip-logic rule confirmed matching after independent read-back: show when ` +
      `"${whenFieldLabel}" equals "${equalsCode}".`,
    confidence: 1,
    gate_outcome: "auto",
    confirm_result: "skip_logic_confirmed",
  });
}

// The semantic intent used to locate the Values section's "add one option" control. Deliberately
// paid/semantic on first use — its wording is exactly the kind of platform-specific naming
// LOCATE's free literal-label path isn't expected to reliably handle (Mock A calls it "+ Add
// Value"; another platform might not).
const OPTION_ADD_VALUE_INTENT =
  "the button in the Options panel's Values section that adds one new option/value to this field's coded list";

// Reads back every option row currently present among a set of newly-added textbox candidates,
// using a previously-established, field-local fact about which position (0 or 1) within each
// two-textbox row holds the Code versus the Label. Rows are assumed to appear as consecutive
// pairs in perception order, reflecting real, stable DOM/AX order rather than an order this code
// imposes — a genuine simplifying assumption, disclosed rather than hidden, that would need
// revisiting if a platform ever interleaves unrelated textboxes into the Values list.
function extractOptionPairs(newTextboxes, codeIndex) {
  const pairs = [];
  for (let i = 0; i + 1 < newTextboxes.length; i += 2) {
    const row = [newTextboxes[i], newTextboxes[i + 1]];
    pairs.push({
      code: (row[codeIndex]?.value ?? "").toString().trim(),
      label: (row[1 - codeIndex]?.value ?? "").toString().trim(),
    });
  }
  return pairs;
}

// Clicks the Values section's "Add Value" control once, returning the newly-added row's two
// textbox candidates. The control is located semantically only the first time it's needed for a
// given field and re-found by exact label+role signature for every subsequent option in the same
// field — the same probe-once-cache-the-fact pattern already used elsewhere in this project for
// recurring form definitions and, at the run level, for canonical type mappings.
async function addOptionRow(tabId, addValueSignature, irPath, stepLabel) {
  const before = await perceiveCandidates(tabId);

  let addValueCandidate = addValueSignature.current
    ? before.find((c) => c.role === addValueSignature.current.role && c.name === addValueSignature.current.name)
    : null;

  if (!addValueCandidate) {
    const located = await locateOrEscalate(tabId, before, OPTION_ADD_VALUE_INTENT, irPath, stepLabel);
    addValueCandidate = before.find((c) => c.markNumber === located.markNumber);
    addValueSignature.current = { role: addValueCandidate.role, name: addValueCandidate.name };
  }

  await clickCandidate(tabId, addValueCandidate);
  const after = await perceiveCandidates(tabId);
  const newTextboxes = diffNewCandidates(before, after).filter((c) => c.role === "textbox");

  if (newTextboxes.length !== 2) {
    const reasoning =
      `Clicking the Add Value control produced ${newTextboxes.length} new textbox(es); expected ` +
      "exactly 2 (a Code input and a Label input). This platform's option-row shape doesn't " +
      "match what this logic assumes, and guessing which fields to fill would risk silently " +
      "storing the wrong values.";
    await writeRecord({
      ir_path: irPath,
      step: stepLabel,
      action_taken: "add_option_row",
      decide_reasoning: reasoning,
      confidence: 0,
      gate_outcome: "escalated",
      confirm_result: "unexpected_row_shape",
    });
    await logEscalation("CreateField", "create_field_option_row_shape_unexpected", reasoning);
    throw new CreateFieldEscalatedError("create_field_option_row_shape_unexpected", {
      foundCount: newTextboxes.length,
    });
  }

  return newTextboxes;
}

// Determines, once per field, which of a newly-added option row's two textboxes (position 0 or
// 1) holds the Code versus the Label — tried first via the same free literal-label match already
// used for Label/Required (a platform may give these inputs real placeholder/aria-label text
// even before any value is typed), falling back to a small semantic locate scoped to just these
// 2 candidates if that fails. This result is reused for every later option in the same field
// without spending another call: which physical position holds which value is a fixed fact about
// this platform's row template, not something that can vary row to row within one field.
async function classifyCodeLabelPosition(tabId, rowCandidates, irPath) {
  const codeCheap = locateByLabel(rowCandidates, ["code", "value code", "option code"], "textbox");
  const labelCheap = locateByLabel(rowCandidates, ["label", "value label", "display label", "option label"], "textbox");

  if (codeCheap && labelCheap && codeCheap.markNumber !== labelCheap.markNumber) {
    return rowCandidates.findIndex((c) => c.markNumber === codeCheap.markNumber);
  }

  const located = await locateOrEscalate(
    tabId,
    rowCandidates,
    'the input for this option row\'s short, stored CODE value (e.g. an abbreviation like "F" or "WH") — as opposed to the human-readable display Label for the same option',
    irPath,
    "create_field_classify_option_code_position"
  );
  return rowCandidates.findIndex((c) => c.markNumber === located.markNumber);
}

// Sets and independently verifies a full coded options list (radio / single_select /
// multi_select). No-op for any field with no `options` on fieldSpec (most fields — checkbox
// carries no options list at all per the IR schema, and non-coded types never have one).
//
// Deliberately built per-option rather than via any bulk-paste affordance a platform might offer
// (Mock A has one, "Paste Values"). A bulk shortcut requires knowing the platform's expected
// delimiter format with no generic way to discover that format at runtime — a strictly harder,
// less verifiable problem than anything else this agent does, and the IR README itself warns
// bulk shortcuts "tend to replace rather than append" without guaranteeing a format. Per-option
// entry costs more calls but never requires guessing a syntax; every value written is
// independently confirmed by read-back, comparing code AND label — never label alone, per the
// README's own explicit warning that entering only labels stores the wrong thing.
async function setOptionValues(tabId, fieldSpec, irPath) {
  const { options } = fieldSpec;
  if (!options || options.length === 0) return;

  const beforeAnyOptions = await perceiveCandidates(tabId);
  const addValueSignature = {};
  let codeIndex = null;

  for (let i = 0; i < options.length; i += 1) {
    const rowCandidates = await addOptionRow(tabId, addValueSignature, irPath, `create_field_add_option_${i}`);

    if (codeIndex === null) {
      codeIndex = await classifyCodeLabelPosition(tabId, rowCandidates, irPath);
    }

    await clearAndType(tabId, rowCandidates[codeIndex], options[i].code);
    await clearAndType(tabId, rowCandidates[1 - codeIndex], options[i].label);
  }

  await writeRecord({
    ir_path: irPath,
    step: "create_field_fill_options_values",
    action_taken: `added ${options.length} option row(s) via per-option entry`,
    decide_reasoning: `Code/Label position within each row classified once (index ${codeIndex}) and reused for all ${options.length} option(s).`,
    confidence: 1,
    gate_outcome: "auto",
    confirm_result: "not_yet_confirmed",
  });

  // Independent read-back: fresh perception, compared as a SET (not by position or order)
  // against fieldSpec.options.
  const afterAllOptions = await perceiveCandidates(tabId);
  const newTextboxes = diffNewCandidates(beforeAnyOptions, afterAllOptions).filter((c) => c.role === "textbox");
  const actualPairs = extractOptionPairs(newTextboxes, codeIndex);

  const pairKey = (o) => `${o.code}\u0000${o.label}`;
  const expectedSet = new Set(options.map(pairKey));
  const actualSet = new Set(actualPairs.map(pairKey));

  const missing = options.filter((o) => !actualSet.has(pairKey(o)));
  const unexpected = actualPairs.filter((p) => !expectedSet.has(pairKey(p)));

  if (missing.length > 0 || unexpected.length > 0) {
    const reasoning =
      "Option values did not match after entry (compared as a set, order not required): " +
      (missing.length > 0
        ? `missing expected option(s): ${missing.map((o) => `${o.code}=${o.label}`).join(", ")}. `
        : "") +
      (unexpected.length > 0
        ? `unexpected/extra option(s) found: ${unexpected.map((p) => `${p.code}=${p.label}`).join(", ")}.`
        : "");
    await writeRecord({
      ir_path: irPath,
      step: "create_field_confirm_options",
      action_taken: "read_back_option_values",
      decide_reasoning: reasoning,
      confidence: 0,
      gate_outcome: "escalated",
      confirm_result: "options_mismatch",
    });
    await logEscalation("CreateField", "create_field_options_mismatch", reasoning);
    throw new CreateFieldEscalatedError("create_field_options_mismatch", { missing, unexpected });
  }

  // Order is logged for traceability but is not itself a pass/fail condition.
  const orderPreserved = options.every((o, idx) => pairKey(o) === pairKey(actualPairs[idx]));
  await writeRecord({
    ir_path: irPath,
    step: "create_field_confirm_options",
    action_taken: "read_back_option_values",
    decide_reasoning:
      `All ${options.length} option(s) confirmed matching after independent read-back (compared ` +
      `as a set). Order ${orderPreserved ? "was" : "was NOT"} preserved relative to the IR — logged ` +
      "for reference, not a failure condition.",
    confidence: 1,
    gate_outcome: "auto",
    confirm_result: "options_confirmed",
  });
}

// Sets and independently verifies this field's conditional-visibility rule (Stage 3e). No-op for
// any field with no `skip_logic` on fieldSpec — the great majority of fields. `skip_logic` is
// expected to already carry `{ whenFieldLabel, equalsCode, equalsLabel }` fully resolved by
// driver.js's toFieldSpec before this is ever called, since resolving equalsLabel requires the
// controlling field's own IR entry (to look up its options by code), which this function has no
// access to and should not — createField operates on one field's spec at a time, by design.
//
// Deliberately run after Gap #11's structural-role cross-check has already captured its own
// "everything new since the type was selected" diff, never before it — the field-selector and
// value-target controls this step reveals are not evidence about the field's OWN canonical type,
// and running this first would contaminate that check with an unrelated diff.
async function setSkipLogicRule(tabId, fieldSpec, irPath) {
  const { skip_logic } = fieldSpec;
  if (!skip_logic) return;

  const { whenFieldLabel, equalsCode, equalsLabel } = skip_logic;

  const revealed = await revealSkipLogicSection(tabId, irPath, "create_field_reveal_skip_logic");
  const classified = await classifySkipLogicControls(tabId, revealed, irPath);
  const { fieldSelector } = classified;

  // Signature captured immediately after classification, before the control's value is set — the
  // same "trust an already-confirmed real accessible name+role, never a remembered element
  // handle" principle used by decideTypeMappingOrEscalate's cache re-find, applied here so
  // confirmSkipLogicRule can re-locate this control fresh rather than reusing this in-memory
  // object (per gap #10's re-Locate-at-Confirm discipline).
  const fieldSelectorSignature = { role: fieldSelector.role, name: fieldSelector.name };

  // Snapshotted before setting the field selector — not before revealing the section — so that if
  // the value target turns out to be staged (see below), only what's newly appeared as a direct
  // result of THIS choice is attributed to it, not anything already present from the reveal step.
  const beforeFieldChosen = await perceiveCandidates(tabId);
  await setSkipLogicFieldSelector(tabId, fieldSelector, whenFieldLabel, irPath);

  // A platform may not render the equals-value target until a controlling field has actually
  // been chosen (classifySkipLogicControls reports this as valueTarget: null, an expected shape,
  // not an error) — resolved here, now that the choice has genuinely been made.
  const valueTarget = classified.valueTarget ?? (await resolveStagedValueTarget(tabId, beforeFieldChosen, irPath));
  const valueTargetSignature = { role: valueTarget.role, name: valueTarget.name };

  await setSkipLogicValueTarget(tabId, valueTarget, equalsCode, equalsLabel, irPath);

  await writeRecord({
    ir_path: irPath,
    step: "create_field_fill_skip_logic",
    action_taken: `wired rule: show this field when "${whenFieldLabel}" equals "${equalsCode}"`,
    decide_reasoning: "Field selector and value target classified and set; independent read-back to follow.",
    confidence: 1,
    gate_outcome: "auto",
    confirm_result: "not_yet_confirmed",
  });

  await confirmSkipLogicRule(
    tabId,
    { fieldSelector: fieldSelectorSignature, valueTarget: valueTargetSignature },
    whenFieldLabel,
    equalsCode,
    equalsLabel,
    irPath
  );
}

// The Save-lookalike retry rule — identical shape to createForm.js's clickCommitWithRetry,
// duplicated rather than shared, since the two modules' surrounding context (form-level vs.
// field-level candidates/state) differs enough that a shared abstraction would need its own
// design discussion; kept as a deliberate, noted duplication rather than a silent one.
//
// Two fixes landed together here: (1) a fast path that reuses a previously-found Save button
// signature for this same form (saveButtonCache.js) rather than paying a fresh semantic locate on
// every field's commit, since the button's identity doesn't change across a form's own fields —
// self-healing exactly like the type-mapping cache, re-verified present before being trusted, and
// a click that doesn't confirm invalidates the entry rather than being retried blindly; (2) a
// real, pre-existing bug fix, found while wiring the cache in: the retry loop below built its own
// avoidMarks list but never actually passed it to locateOrEscalate, so a second attempt could
// re-propose the identical wrong mark instead of genuinely trying something else — harmless only
// because every real commit has succeeded on the first attempt so far, but a latent inconsistency
// with createForm.js's own, already-correct version of this same pattern.
async function clickCommitWithRetry(tabId, formName, intentDescription, confirmFn, irPath, stepLabel) {
  const cached = getSaveButtonCacheEntry(formName);
  if (cached) {
    const candidates = await perceiveCandidates(tabId);
    const rediscovered = candidates.find((c) => c.role === cached.axRole && c.name === cached.label);
    if (rediscovered) {
      await clickCandidate(tabId, rediscovered);
      const confirmResult = await confirmFn();
      await writeRecord({
        ir_path: irPath,
        step: `${stepLabel}_cache_hit`,
        action_taken: `clicked mark #${rediscovered.markNumber} (cached Save button for form "${formName}", no semantic call made)`,
        decide_reasoning: `Re-found by exact label+role match: "${cached.label}" (${cached.axRole}).`,
        confidence: 1,
        gate_outcome: "auto",
        confirm_result: confirmResult.matches ? "confirmed_visible" : "commit_not_detected",
      });
      if (confirmResult.matches) {
        return {
          success: true,
          target: { markNumber: rediscovered.markNumber, confidence: 1 },
          confirmResult,
          attempts: 0,
        };
      }
      console.warn(
        `[createField] cached Save button for form "${formName}" did not commit — invalidating and re-locating`
      );
      invalidateSaveButtonCacheEntry(formName);
    }
  }

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
      if (targetCandidate) {
        setSaveButtonCacheEntry(formName, { label: targetCandidate.name, axRole: targetCandidate.role });
      }
      return { success: true, target, confirmResult, attempts: attempt };
    }

    console.warn(`[createField] attempt ${attempt} (mark #${target.markNumber}) not confirmed — retrying`);
    avoidMarks = [...avoidMarks, target.markNumber];
  }

  const reasoning = `Failed to commit after ${MAX_SAVE_ATTEMPTS} attempts (marks tried: ${avoidMarks.join(", ")})`;
  await logEscalation("CreateField", `${stepLabel}_commit_failed`, reasoning);
  throw new CreateFieldEscalatedError(`${stepLabel}_commit_failed`, { avoidMarks });
}

// Ensures the current screen is the target form's own editor — see confirmFormEditorScreen.js's
// own header for the real incidents this exists to catch. Exported (not just used internally by
// createField below) — Phase 6.2's reconciliation walk needs this same navigation independently
// of building anything, to scan a form's existing field labels before deciding what's still
// missing. Returns the freshly-perceived candidate list for the confirmed editor screen, since
// createField's own Stage 2 needs it immediately afterward.
export async function ensureOnFormEditorOrEscalate(tabId, formName, irPath) {
  // Tries a genuinely free, code-only proxy first: if the last field successfully completed was
  // on this exact form, and that field's label is still present among freshly-perceived
  // candidates, that is real, $0 evidence we're still on the same editor — skip the paid check
  // entirely. The form-name check runs before the label check specifically because a field label
  // can legitimately repeat across two different forms in the real IR (e.g. "Ongoing" appears in
  // both Medical History and Prior and Concomitant Medications) — checking the form first is what
  // keeps this from being fooled by that overlap. Only when the proxy can't apply (a brand-new
  // form, or the previous field's label unexpectedly missing — e.g. after a retry navigated
  // somewhere unexpected) does this fall back to the full, paid confirmFormEditorScreen check.
  //
  // Never removes the real check — see confirmFormEditorScreen.js's own header for the two real
  // incidents (a wrong Stage 1 click, and a separate wrong CREATE FORM navigation) this project
  // has already had from operating on the wrong screen undetected. This only changes how often
  // the paid version of that question gets asked, never whether it gets asked when genuinely
  // unsure.
  let candidates = await perceiveCandidates(tabId);
  const editorState = getFormEditorState();
  let screenCheck;

  if (
    editorState &&
    editorState.formName === formName &&
    candidates.some((c) => c.name === editorState.lastConfirmedFieldLabel)
  ) {
    screenCheck = {
      isEditor: true,
      confidence: 1,
      reasoning:
        `Free structural proxy: previously-completed field "${editorState.lastConfirmedFieldLabel}" ` +
        "for this same form is still present among current candidates — no LLM call made.",
      tier: "cached_proxy",
    };
  } else {
    screenCheck = await confirmFormEditorScreen(tabId, formName);
  }

  await writeRecord({
    ir_path: irPath,
    step: "create_field_check_editor_screen",
    action_taken: screenCheck.isEditor ? "already_on_editor" : "not_on_editor",
    decide_reasoning: `[tier: ${screenCheck.tier}] ${screenCheck.reasoning}`,
    confidence: screenCheck.confidence,
    gate_outcome: "auto",
    confirm_result: screenCheck.isEditor ? "editor_confirmed" : "editor_not_present",
  });

  if (!screenCheck.isEditor) {
    const editControl = await locateOrEscalate(
      tabId,
      candidates,
      `the control that lets a user edit the fields of the form named "${formName}"`,
      irPath,
      "create_field_find_edit_control"
    );
    await clickCandidate(tabId, candidates.find((c) => c.markNumber === editControl.markNumber));
    await writeRecord({
      ir_path: irPath,
      step: "create_field_open_form_editor",
      action_taken: `clicked mark #${editControl.markNumber}`,
      decide_reasoning: editControl.reasoning,
      confidence: editControl.confidence,
      gate_outcome: "auto",
      confirm_result: "not_yet_confirmed",
    });
    candidates = await perceiveCandidates(tabId);
  }

  return candidates;
}

// Creates one field on an existing form. fieldSpec is { label, type, required, irPath, min?,
// max?, units?, options? } — the exact shape of one entry in the real IR's fields array
// (min/max/units present only for integer/decimal fields with a range check; options present
// only for radio/single_select/multi_select fields). Returns { created: true } or
// { created: false, reason: "rejected_by_human" }.
export async function createField(tabId, formName, fieldSpec) {
  const { label, type, required, irPath } = fieldSpec;

  // Stage 1: ensure we're looking at the target form's own editor — see
  // ensureOnFormEditorOrEscalate's own header for why this check exists and how it's kept cheap.
  let candidates = await ensureOnFormEditorOrEscalate(tabId, formName, irPath);

  // Stage 2: Decide — find and add the element-library entry, confirm it's selected.
  const beforeAdd = candidates;
  const beforeAddText = await getAllAccessibleText(tabId);
  const typeMatch = await decideTypeMappingOrEscalate(tabId, beforeAdd, type, irPath);
  await clickCandidate(tabId, beforeAdd.find((c) => c.markNumber === typeMatch.markNumber));
  await writeRecord({
    ir_path: irPath,
    step: "create_field_decide_type",
    action_taken: `clicked mark #${typeMatch.markNumber} for canonical type "${type}"`,
    decide_reasoning: typeMatch.reasoning,
    confidence: typeMatch.confidence,
    gate_outcome: "auto",
    confirm_result: "not_yet_confirmed",
  });

  const afterAdd = await perceiveCandidates(tabId);
  await confirmFieldSelected(tabId, beforeAddText, diffNewCandidates(beforeAdd, afterAdd), irPath);

  // Stage 3: set Label and Required in the Options panel — free literal match tried first.
  candidates = await perceiveCandidates(tabId);
  const labelField = await locateCheapOrEscalate(
    tabId,
    candidates,
    {
      expectedLabels: ["label", "field label", "display label"],
      roleFilter: "textbox",
      semanticIntent: "the input field in the Options panel for editing this field's Label",
    },
    irPath,
    "create_field_find_label_field"
  );
  await clearAndType(tabId, candidates.find((c) => c.markNumber === labelField.markNumber), label);

  candidates = await perceiveCandidates(tabId);
  const requiredCheckbox = await locateCheapOrEscalate(
    tabId,
    candidates,
    {
      expectedLabels: ["required"],
      roleFilter: "checkbox",
      semanticIntent: "the checkbox in the Options panel indicating whether this field is Required",
    },
    irPath,
    "create_field_find_required_checkbox"
  );
  await setCheckedState(tabId, candidates.find((c) => c.markNumber === requiredCheckbox.markNumber), required);

  await writeRecord({
    ir_path: irPath,
    step: "create_field_fill_options",
    action_taken: `set Label="${label}", Required=${required}`,
    decide_reasoning: `Label field: ${labelField.reasoning} | Required checkbox: ${requiredCheckbox.reasoning}`,
    confidence: Math.min(labelField.confidence, requiredCheckbox.confidence),
    gate_outcome: "auto",
    confirm_result: "not_yet_confirmed",
  });

  // Stage 3b: set and independently verify a coded Options list (radio/single_select/
  // multi_select). No-op for any field with no `options` on fieldSpec.
  await setOptionValues(tabId, fieldSpec, irPath);

  // Stage 3b2: set and independently verify a calculated field's formula. No-op for any field
  // with no `formula` on fieldSpec.
  await setFormulaValue(tabId, fieldSpec, irPath);

  // Stage 3c: set and independently verify any Range Check values (Min/Max/Units). No-op for
  // any field that carries none of the three.
  await setRangeCheckValues(tabId, fieldSpec, irPath);

  // Stage 3d: Gap #11's structural-role cross-check — deliberately run last among the ORIGINAL
  // Stage-3 sub-steps, so option-bearing types have real rendered elements to be checked against.
  const afterAllStage3 = await perceiveCandidates(tabId);
  await structuralRoleCrossCheck(type, diffNewCandidates(beforeAdd, afterAllStage3), irPath);

  // Stage 3e: skip-logic wiring. Deliberately runs AFTER Gap #11's check above, never before —
  // the field-selector/value-target controls this reveals are not evidence about this field's own
  // canonical type, and running it earlier would contaminate that check's diff with an unrelated
  // set of newly-visible candidates. No-op for the great majority of fields (no `skip_logic` on
  // fieldSpec).
  await setSkipLogicRule(tabId, fieldSpec, irPath);

  // Stage 4: GATE. Per §13's original design — never actually built into this stage until now,
  // which is why every field has been escalating unconditionally regardless of confidence, the
  // exact "re-verify all 195 fields" failure the assignment calls out by name. Everything upstream
  // of this point already escalates on its own if anything went wrong (type selection, Label/
  // Required, Options/Range/Formula, Gap #11's structural-role check) — by the time execution
  // reaches here, the type-mapping confidence is the only remaining variable signal, so it's what
  // this floor is checked against. A cache hit or a human-approved-then-cached mapping reports
  // confidence 1 on every reuse, so in practice a human is asked at most once per canonical type,
  // not once per field.
  const description = `Set field "${label}" (type: ${type}, required: ${required}) on form "${formName}"`;
  let approved;

  if (typeMatch.confidence >= AUTO_BUILD_CONFIDENCE_FLOOR) {
    approved = true;
    await writeRecord({
      ir_path: irPath,
      step: "create_field_gate",
      action_taken: "auto_approved",
      decide_reasoning:
        `${description} — auto-approved: type-mapping confidence (${typeMatch.confidence.toFixed(2)}) ` +
        `met the ${AUTO_BUILD_CONFIDENCE_FLOOR} floor for building without human review.`,
      confidence: typeMatch.confidence,
      gate_outcome: "auto",
      confirm_result: "pending_save",
    });
  } else {
    // Only captured on the escalation branch, never the auto-approve one above — this is a real
    // CDP screenshot call, and the great majority of fields (cache hits, confident Decide
    // results) never need to pay for it. `afterAllStage3` is already the freshest full
    // candidate list on screen (captured just above for Gap #11's role check), so this needs no
    // extra AXTree read — only the screenshot-plus-overlay work itself.
    let screenshotBase64 = null;
    try {
      // Crops to just this field's own newly-added elements — the same diff Gap #11's structural
      // check already computed just above — rather than the whole page, so the reviewer sees a
      // legible, tightly-framed view instead of the entire app shrunk into a side panel.
      const newFieldCandidates = diffNewCandidates(beforeAdd, afterAllStage3);
      ({ imageBase64: screenshotBase64 } = await captureCroppedAnnotatedScreenshot(
        tabId,
        afterAllStage3,
        newFieldCandidates
      ));
    } catch (error) {
      // A failed screenshot capture is a real, disclosed degradation of what the reviewer sees —
      // never a reason to block or fail the Gate request itself. The text description and details
      // still carry everything needed to make a decision.
      console.warn(`[createField] could not capture a Gate screenshot for "${label}":`, error.message);
    }
    approved = await requestHumanApproval(description, { label, type, required, formName }, screenshotBase64);
    await writeRecord({
      ir_path: irPath,
      step: "create_field_gate",
      action_taken: "requested_human_approval",
      decide_reasoning:
        `${description} — escalated: type-mapping confidence (${typeMatch.confidence.toFixed(2)}) ` +
        `was below the ${AUTO_BUILD_CONFIDENCE_FLOOR} floor for auto-building.`,
      confidence: typeMatch.confidence,
      gate_outcome: approved ? "approved" : "rejected",
      confirm_result: approved ? "pending_save" : "not_saved",
    });
  }

  if (!approved) {
    console.warn(`[createField] rejected by human for field "${label}" — leaving unsaved`);
    // The field's element and label were genuinely added to the canvas in Stage 3 before the
    // Gate ran — that's real, on-screen state regardless of the human's decision — so it's still
    // valid evidence for the next field's Stage 1 proxy check on this same form.
    setFormEditorState(formName, label);
    return { created: false, reason: "rejected_by_human" };
  }

  await clickCommitWithRetry(
    tabId,
    formName,
    "the button that actually saves this form's changes (not Save As Template, not Preview)",
    () => confirmVisible(tabId, [label], `This should be a form editor for "${formName}".`),
    irPath,
    "create_field_commit"
  );

  setFormEditorState(formName, label);
  return { created: true };
}