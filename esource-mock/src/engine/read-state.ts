import type { ReadField, ReadStudy } from '../shared/read-state';
import { PLATFORM_ID, SPEC_VERSION } from '../spec/surface';
import type { BuiltElement, BuiltForm } from './state';
import type { Mock1Store } from './store';

/**
 * Mock 1 → canonical readState.
 *
 * Serializes the SAVED study only; the builder's working copy never appears.
 * Pages are flattened in order — pagination is presentation, and the shared
 * comparator matches fields by label, not position.
 */

function readField(element: BuiltElement, form: BuiltForm): ReadField {
  let skipLogic: ReadField['skipLogic'] = null;
  const visibility = element.visibility;
  if (visibility.mode === 'when' && visibility.whenElementId) {
    const when = form.pages
      .flatMap((p) => p.elements)
      .find((e) => e.id === visibility.whenElementId);
    if (when) {
      skipLogic = { whenFieldLabel: when.label, equalsValue: visibility.equalsValue };
    }
  }
  return {
    label: element.label,
    type: element.type,
    required: element.required,
    options: element.values.map((v) => ({ code: v.code, label: v.label })),
    min: element.min,
    max: element.max,
    units: element.units,
    formula: element.formula,
    skipLogic,
  };
}

export function readState(store: Mock1Store): ReadStudy {
  const { study } = store.getState();
  return {
    platform: PLATFORM_ID,
    specVersion: SPEC_VERSION,
    study: {
      name: study.name,
      visits: study.visits.map((visit) => ({
        name: visit.name,
        windowStart: visit.windowStart,
        windowEnd: visit.windowEnd,
        forms: visit.forms.map((form) => ({
          name: form.name,
          repeating: form.repeating,
          status: form.status,
          fields: form.pages.flatMap((page) => page.elements.map((el) => readField(el, form))),
        })),
      })),
    },
  };
}
