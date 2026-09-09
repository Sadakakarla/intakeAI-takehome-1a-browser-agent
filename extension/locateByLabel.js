// LOCATE: a free, $0 structural match against the AXTree's own accessible names — no LLM call.
// Used specifically for controls whose text is expected to be a near-universal, standard term
// across virtually any form-builder (e.g. an Options/property panel's own "Label" and "Required"
// controls) — categorically different from an element-library's widget-type naming, which the
// project's own research (data/README.md) confirms genuinely varies enough across platforms to
// need DECIDE's semantic reasoning instead (see typeMapping.js). Matches are checked
// case-insensitively against each candidate's accessible name; more than one match is treated
// the same as zero matches (ambiguous — never guess between multiple candidates).
export function locateByLabel(candidates, expectedLabels, roleFilter) {
  const lowerExpected = expectedLabels.map((s) => s.toLowerCase());
  const matches = candidates.filter((c) => {
    if (roleFilter && c.role !== roleFilter) return false;
    const name = (c.name || "").trim().toLowerCase();
    return lowerExpected.some((expected) => name === expected || name.includes(expected));
  });
  return matches.length === 1 ? matches[0] : null;
}