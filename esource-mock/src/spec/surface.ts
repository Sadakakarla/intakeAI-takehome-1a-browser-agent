import type { FieldType } from '../shared/study';
import type { ElementTypeDef } from './types';

/** Stamped into readState so a score can never be separated from the surface that produced it. */
export const SPEC_VERSION = 'esource-mock-a/1.0.0';

export const PLATFORM_ID = 'esource-mock-a';
export const PLATFORM_LABEL = 'intakeAI eSource — Mock A';

/**
 * The element library, in the order the panel shows it — ALPHABETICAL, like
 * the product it is modeled on.
 *
 * Two adjacencies are deliberate grounding hazards rather than accidents:
 * "Check List" (multi-select) sits beside "Checkbox" (a single tick), and
 * "Number (Decimal)" beside "Number (Whole)". A builder that matches type by
 * fuzzy label rather than meaning picks the wrong neighbor, and only read-back
 * catches it.
 */
export const ELEMENT_TYPES: readonly ElementTypeDef[] = [
  { canonical: 'calculated', label: 'Calculated Field' },
  { canonical: 'multi_select', label: 'Check List' },
  { canonical: 'checkbox', label: 'Checkbox' },
  { canonical: 'date', label: 'Date' },
  { canonical: 'datetime', label: 'Date/Time' },
  { canonical: 'single_select', label: 'Dropdown' },
  { canonical: 'textarea', label: 'Multi-line Textbox' },
  { canonical: 'decimal', label: 'Number (Decimal)' },
  { canonical: 'integer', label: 'Number (Whole)' },
  { canonical: 'radio', label: 'Radio Buttons' },
  { canonical: 'text', label: 'Single Line Textbox' },
  { canonical: 'time', label: 'Time' },
  { canonical: 'boolean', label: 'Yes/No Toggle' },
];

export function elementTypeByCanonical(canonical: FieldType): ElementTypeDef {
  const found = ELEMENT_TYPES.find((t) => t.canonical === canonical);
  if (!found) throw new Error(`mock1 has no element type for canonical "${canonical}"`);
  return found;
}

export function elementTypeLabel(canonical: FieldType): string {
  return elementTypeByCanonical(canonical).label;
}
