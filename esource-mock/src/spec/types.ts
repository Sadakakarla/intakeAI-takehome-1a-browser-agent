import type { FieldType } from '../shared/study';

/**
 * Mock 1 — "intakeAI eSource Mock 1" — vocabulary.
 *
 * The standard site-facing builder, modeled on the RealTime-eSOURCE user
 * manual's authoring flow: Study Plan → Visit → Source Documents (forms with a
 * Draft/Active lifecycle and versions) → a builder with an element library on
 * the left, a paged canvas in the middle and an Options panel on the right.
 *
 * Same discipline as `tests/mock/spec/types.ts`: everything the renderer draws
 * and everything the scorer grades is named here once. The renderer decides
 * what the DOM looks like; it never decides what exists.
 */

/** An element type as Mock 1's library presents it. `canonical` is the shared-study type it realizes. */
export interface ElementTypeDef {
  canonical: FieldType;
  /** The label on the library tile and in the Options panel's type selector. */
  label: string;
}

/** The screens grounding happens against. */
export type ScreenContext = 'study_plan' | 'visit_detail' | 'form_builder' | 'form_preview';

export type SemanticControlId =
  // study_plan — the visit schedule
  | 'visit.add_button'
  | 'visit.name_input'
  | 'visit.window_start_input'
  | 'visit.window_end_input'
  | 'visit.save_button'
  | 'visit.cancel_button'
  | 'visit.row'
  // visit_detail — the source-documents table
  | 'visit.back_to_plan'
  | 'form.new_button'
  | 'form.name_input'
  | 'form.repeating_toggle'
  | 'form.create_button'
  | 'form.cancel_button'
  | 'form.row'
  | 'form.edit_button'
  | 'form.activate_button'
  | 'form.new_version_button'
  | 'form.delete_button'
  // form_builder — chrome
  | 'builder.back_button'
  | 'builder.save_button'
  | 'builder.save_template_button'
  | 'builder.preview_button'
  | 'builder.activate_button'
  // form_builder — element library
  | 'library.filter_input'
  | 'library.item'
  // form_builder — pages and canvas
  | 'page.tab'
  | 'page.add_button'
  | 'canvas.element'
  // form_builder — Options panel
  | 'options.label_input'
  | 'options.placeholder_input'
  | 'options.type_select'
  | 'options.required_toggle'
  | 'options.hidden_toggle'
  | 'options.min_input'
  | 'options.max_input'
  | 'options.units_input'
  | 'options.decimal_places_input'
  | 'options.formula_input'
  | 'options.allow_past_toggle'
  | 'options.allow_future_toggle'
  | 'options.value_add_button'
  | 'options.value_code_input'
  | 'options.value_label_input'
  | 'options.value_remove_button'
  | 'options.value_paste_textarea'
  | 'options.value_paste_apply'
  | 'options.visibility_select'
  | 'options.visibility_when_select'
  | 'options.visibility_value_input'
  | 'options.delete_element_button'
  // form_preview
  | 'preview.close_button';
