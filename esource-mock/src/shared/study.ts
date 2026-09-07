/**
 * Canonical field-type vocabulary for the eSource domain.
 *
 * These are the semantic types a study's specification is written in. Every
 * eSource platform maps them onto whatever its own element library happens to
 * call them ("Dropdown", "Combo", "Picklist", "Select One"). The mapping lives
 * in the platform, never here.
 */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'integer'
  | 'decimal'
  | 'date'
  | 'time'
  | 'datetime'
  | 'boolean'
  | 'single_select'
  | 'multi_select'
  | 'radio'
  | 'checkbox'
  | 'calculated';

export interface FieldTypeDef {
  id: FieldType;
  /**
   * Whether the type carries a coded-value list. `checkbox` is a single tick
   * and `boolean` a yes/no toggle — neither has one.
   */
  hasOptions: boolean;
  /** Whether min/max/units apply. */
  hasRange: boolean;
  /** Whether a formula applies. */
  hasFormula: boolean;
}

export const FIELD_TYPES: readonly FieldTypeDef[] = [
  { id: 'text', hasOptions: false, hasRange: false, hasFormula: false },
  { id: 'textarea', hasOptions: false, hasRange: false, hasFormula: false },
  { id: 'integer', hasOptions: false, hasRange: true, hasFormula: false },
  { id: 'decimal', hasOptions: false, hasRange: true, hasFormula: false },
  { id: 'date', hasOptions: false, hasRange: false, hasFormula: false },
  { id: 'time', hasOptions: false, hasRange: false, hasFormula: false },
  { id: 'datetime', hasOptions: false, hasRange: false, hasFormula: false },
  { id: 'boolean', hasOptions: false, hasRange: false, hasFormula: false },
  { id: 'single_select', hasOptions: true, hasRange: false, hasFormula: false },
  { id: 'multi_select', hasOptions: true, hasRange: false, hasFormula: false },
  { id: 'radio', hasOptions: true, hasRange: false, hasFormula: false },
  { id: 'checkbox', hasOptions: false, hasRange: false, hasFormula: false },
  { id: 'calculated', hasOptions: false, hasRange: false, hasFormula: true },
];

export function fieldType(id: FieldType): FieldTypeDef {
  const found = FIELD_TYPES.find((t) => t.id === id);
  if (!found) throw new Error(`unknown field type "${id}"`);
  return found;
}
