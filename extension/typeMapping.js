// Canonical-type-to-intent-description translation, per the IR's documented vocabulary
// (data/README.md). These descriptions force the semantic distinctions the README calls out as
// routinely confused (text vs textarea, single_select vs radio, checkbox vs multi_select).
//
// Every description is wrapped with an explicit "palette entry that ADDS this, not an
// already-existing field elsewhere" framing — found necessary via live diagnosis, not assumed:
// a real run showed a vision model spending ~2,800 reasoning tokens deliberating between the
// correct palette button and an unrelated "Find" filter box that also happened to be a literal
// single-line text input. Raising max_tokens alone did not fix this, because the problem was
// genuine ambiguity causing unpredictable-length rambling, not a hard budget ceiling — a
// different sampling run could exceed any fixed ceiling given the same ambiguous prompt. This
// disambiguation is expected to generalize: a search/filter box next to an element palette is a
// common real UI pattern, not specific to this one mock.

function wrapPaletteIntent(specificDescription) {
  return (
    `the button or list entry in the element/field-type palette that would ADD ${specificDescription} ` +
    "to the form if clicked — NOT any already-existing input field elsewhere on the screen that " +
    "happens to share the same literal type (for example, a search or filter box is never the " +
    "answer, even though it may itself be a single-line text input)."
  );
}

const TYPE_SPECIFIC_DESCRIPTIONS = {
  text: "a field for a SINGLE LINE of free-form text — not a multi-line text area, not a list of choices",
  textarea: "a field for MULTIPLE LINES of free-form text — larger than a single-line text field",
  integer: "a field for a whole number",
  decimal: "a field for a number that may include a decimal/fractional part",
  date: "a field for a calendar date only, with no time component",
  time: "a field for a time of day only, with no date component",
  datetime: "a field for both a date AND a time together",
  boolean: "a simple Yes/No toggle for a single true-or-false question — not a checklist or list of options",
  single_select: "a field for choosing EXACTLY ONE option from a coded list, typically a dropdown/combo box — not one where all choices are visible at once as separate buttons",
  multi_select: "a field for choosing ZERO OR MORE options from a coded list — not a single on/off tick",
  radio: "a field for choosing EXACTLY ONE option from a coded list where ALL choices are visible at once as separate selectable buttons — not a dropdown",
  checkbox: "a SINGLE tick box that is simply on or off — not a list of multiple options",
  calculated: "a field whose value is DERIVED/COMPUTED from other fields by a formula, not entered by hand",
};

// Falls back to a generic description for any type not in the table above, still wrapped in the
// same palette-vs-existing-field framing.
export function describeCanonicalType(type) {
  const specific = TYPE_SPECIFIC_DESCRIPTIONS[type] || `a field matching the canonical type "${type}"`;
  return wrapPaletteIntent(specific);
}

// Expected AX role(s) for each canonical type — used by Gap #11's structural-role cross-check
// (createField.js), a cheap, free sanity check independent of DECIDE's own semantic judgment.
// Deliberately loose/multi-valued where a real platform could reasonably expose the same
// canonical type via more than one AX role (e.g. a date field might report as "textbox" with a
// picker attached). "calculated" fields are often read-only with no standard input role at all,
// so they're excluded from this check entirely rather than forced into a guessed expectation.
const EXPECTED_STRUCTURAL_ROLES = {
  text: ["textbox"],
  textarea: ["textbox"],
  integer: ["textbox", "spinbutton"],
  decimal: ["textbox", "spinbutton"],
  date: ["textbox"],
  time: ["textbox"],
  datetime: ["textbox"],
  boolean: ["checkbox", "switch", "button"],
  single_select: ["combobox"],
  multi_select: ["listbox", "combobox", "checkbox"],
  radio: ["radio"],
  checkbox: ["checkbox"],
};

// Returns the acceptable role(s) for a canonical type, or null if this type has no meaningful
// structural expectation to check (currently just "calculated") — callers should skip the
// cross-check entirely for a null result, not treat it as a failure.
export function expectedStructuralRoles(type) {
  return EXPECTED_STRUCTURAL_ROLES[type] || null;
}