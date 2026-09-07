import type { FieldType } from '../shared/study';

/**
 * Mock 1 state: the SAVED study, plus the builder's working copy and UI state.
 *
 * The saved/working split is the platform's defining behavior, taken from the
 * product it models: the builder edits an in-memory copy of the form, and
 * nothing persists until Save. `__readState()` reports the SAVED side only —
 * a half-built working copy abandoned by navigation must be invisible to
 * read-back, because that is exactly the failure it exists to catch.
 */

export interface BuiltValue {
  id: string;
  code: string;
  label: string;
}

export type Visibility =
  | { mode: 'always' }
  | { mode: 'when'; whenElementId: string; equalsValue: string };

export interface BuiltElement {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  hidden: boolean;
  placeholder: string;
  /** Range/units — meaningful only for number types; cleared on type change away. */
  min: string;
  max: string;
  units: string;
  decimalPlaces: string;
  /** Calculated only. */
  formula: string;
  /** Date/time render-only toggles — stored, never graded. */
  allowPast: boolean;
  allowFuture: boolean;
  values: BuiltValue[];
  visibility: Visibility;
}

export interface FormPage {
  id: string;
  name: string;
  elements: BuiltElement[];
}

export type FormStatus = 'draft' | 'active';

export interface BuiltForm {
  id: string;
  name: string;
  repeating: boolean;
  status: FormStatus;
  version: number;
  pages: FormPage[];
}

export interface BuiltVisit {
  id: string;
  name: string;
  windowStart: string;
  windowEnd: string;
  forms: BuiltForm[];
}

export interface BuiltStudy {
  name: string;
  visits: BuiltVisit[];
}

export type Route =
  | { kind: 'plan' }
  | { kind: 'visit'; visitId: string }
  | { kind: 'builder'; visitId: string; formId: string };

export interface VisitDraft {
  name: string;
  windowStart: string;
  windowEnd: string;
}

export interface FormDraft {
  name: string;
  repeating: boolean;
}

export interface BuilderState {
  /** Deep copy of the saved form; null when the builder is closed. */
  working: BuiltForm | null;
  /** Unsaved edits exist. Gates Activate; lost wholesale on navigation. */
  dirty: boolean;
  selectedPageId: string;
  selectedElementId: string | null;
  libraryFilter: string;
  /** The Paste Values box — applied via its own button, REPLACING the value list. */
  pasteText: string;
  previewOpen: boolean;
  /** One-line toast, e.g. "Save the form before activating." Cleared on the next action. */
  notice: string | null;
}

export interface UiState {
  route: Route;
  visitFormOpen: boolean;
  visitDraft: VisitDraft;
  formFormOpen: boolean;
  formDraft: FormDraft;
  builder: BuilderState;
}

export interface Mock1State {
  study: BuiltStudy;
  ui: UiState;
}

export const EMPTY_VISIT_DRAFT: VisitDraft = { name: '', windowStart: '', windowEnd: '' };
export const EMPTY_FORM_DRAFT: FormDraft = { name: '', repeating: false };

export function emptyBuilder(): BuilderState {
  return {
    working: null,
    dirty: false,
    selectedPageId: '',
    selectedElementId: null,
    libraryFilter: '',
    pasteText: '',
    previewOpen: false,
    notice: null,
  };
}
