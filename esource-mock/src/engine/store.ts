import { fieldType, type FieldType } from '../shared/study';
import { elementTypeLabel } from '../spec/surface';
import {
  EMPTY_FORM_DRAFT,
  EMPTY_VISIT_DRAFT,
  emptyBuilder,
  type BuiltElement,
  type BuiltForm,
  type BuiltValue,
  type BuiltVisit,
  type FormPage,
  type Mock1State,
  type Route,
  type VisitDraft,
  type FormDraft,
  type Visibility,
} from './state';

/**
 * Mock 1 behavior, no rendering in it.
 *
 * The four suite-mandatory traps live HERE, as behavior, so the UI cannot
 * accidentally soften them:
 *
 *   1. Type change discards — `setSelectedType` drops values / range / formula
 *      the new type cannot hold, silently.
 *   2. Bulk replaces — `applyPasteValues` REPLACES the value list, never merges.
 *   3. Disabled look-alikes — behavioral half: `activateWorking` no-ops with a
 *      toast while unsaved edits exist, and `saveAsTemplate` looks like Save
 *      but persists nothing. (The visual half — inert preview inputs on the
 *      canvas — is the renderer's.)
 *   4. Navigate-away loses the draft — `navigate` discards the working copy
 *      and every inline draft, unconditionally and without confirmation.
 */

let sequence = 0;
/** Deterministic within a page load, so a failing run is reproducible. */
function nextId(prefix: string): string {
  return `${prefix}${++sequence}`;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type Listener = () => void;

export class Mock1Store {
  private state: Mock1State;
  private readonly listeners = new Set<Listener>();

  constructor(studyName: string) {
    this.state = {
      study: { name: studyName, visits: [] },
      ui: {
        route: { kind: 'plan' },
        visitFormOpen: false,
        visitDraft: { ...EMPTY_VISIT_DRAFT },
        formFormOpen: false,
        formDraft: { ...EMPTY_FORM_DRAFT },
        builder: emptyBuilder(),
      },
    };
  }

  getState(): Mock1State {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(next: Mock1State): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private patchUi(patch: Partial<Mock1State['ui']>): void {
    this.commit({ ...this.state, ui: { ...this.state.ui, ...patch } });
  }

  private patchBuilder(patch: Partial<Mock1State['ui']['builder']>): void {
    // Any builder action supersedes the previous toast unless the patch sets one.
    this.patchUi({ builder: { ...this.state.ui.builder, notice: null, ...patch } });
  }

  // ── navigation (trap 4 lives here) ──────────────────────────────────────

  /**
   * Navigating discards EVERYTHING unsaved: inline drafts and the builder's
   * working copy alike. No confirmation dialog — the honest version of the
   * trap, because a dialog would be a second chance the executor cannot rely
   * on real platforms offering.
   */
  navigate(route: Route): void {
    this.commit({
      ...this.state,
      ui: {
        route,
        visitFormOpen: false,
        visitDraft: { ...EMPTY_VISIT_DRAFT },
        formFormOpen: false,
        formDraft: { ...EMPTY_FORM_DRAFT },
        builder: emptyBuilder(),
      },
    });
  }

  // ── study plan: visits ───────────────────────────────────────────────────

  openVisitForm(): void {
    this.patchUi({ visitFormOpen: true, visitDraft: { ...EMPTY_VISIT_DRAFT } });
  }

  cancelVisitForm(): void {
    this.patchUi({ visitFormOpen: false, visitDraft: { ...EMPTY_VISIT_DRAFT } });
  }

  setVisitDraft(patch: Partial<VisitDraft>): void {
    this.patchUi({ visitDraft: { ...this.state.ui.visitDraft, ...patch } });
  }

  /** No-ops on an empty name, the way a form with a required field does. */
  saveVisit(): void {
    const draft = this.state.ui.visitDraft;
    if (!draft.name.trim()) return;
    const visit: BuiltVisit = {
      id: nextId('v'),
      name: draft.name.trim(),
      windowStart: draft.windowStart,
      windowEnd: draft.windowEnd,
      forms: [],
    };
    this.commit({
      ...this.state,
      study: { ...this.state.study, visits: [...this.state.study.visits, visit] },
      ui: { ...this.state.ui, visitFormOpen: false, visitDraft: { ...EMPTY_VISIT_DRAFT } },
    });
  }

  // ── visit detail: source documents ───────────────────────────────────────

  openFormForm(): void {
    this.patchUi({ formFormOpen: true, formDraft: { ...EMPTY_FORM_DRAFT } });
  }

  cancelFormForm(): void {
    this.patchUi({ formFormOpen: false, formDraft: { ...EMPTY_FORM_DRAFT } });
  }

  setFormDraft(patch: Partial<FormDraft>): void {
    this.patchUi({ formDraft: { ...this.state.ui.formDraft, ...patch } });
  }

  /** Creates a Draft v1 with one empty page and opens nothing — editing is an explicit second step, as in the product. */
  createForm(): void {
    const { route, formDraft } = this.state.ui;
    if (route.kind !== 'visit') return;
    if (!formDraft.name.trim()) return;

    const form: BuiltForm = {
      id: nextId('f'),
      name: formDraft.name.trim(),
      repeating: formDraft.repeating,
      status: 'draft',
      version: 1,
      pages: [{ id: nextId('pg'), name: 'Page 1', elements: [] }],
    };

    this.commit({
      ...this.state,
      study: {
        ...this.state.study,
        visits: this.state.study.visits.map((v) =>
          v.id === route.visitId ? { ...v, forms: [...v.forms, form] } : v,
        ),
      },
      ui: { ...this.state.ui, formFormOpen: false, formDraft: { ...EMPTY_FORM_DRAFT } },
    });
  }

  /** Drafts delete; an ACTIVE form refuses with a toast, per the product's lifecycle rules. */
  deleteForm(visitId: string, formId: string): void {
    const visit = this.state.study.visits.find((v) => v.id === visitId);
    const form = visit?.forms.find((f) => f.id === formId);
    if (!form) return;
    if (form.status === 'active') {
      this.patchBuilder({ notice: 'Active documents cannot be deleted. Deactivate first.' });
      return;
    }
    this.commit({
      ...this.state,
      study: {
        ...this.state.study,
        visits: this.state.study.visits.map((v) =>
          v.id === visitId ? { ...v, forms: v.forms.filter((f) => f.id !== formId) } : v,
        ),
      },
    });
  }

  /** Activate from the table row — legal for a saved draft. */
  activateForm(visitId: string, formId: string): void {
    this.commit({
      ...this.state,
      study: {
        ...this.state.study,
        visits: this.state.study.visits.map((v) =>
          v.id !== visitId
            ? v
            : {
                ...v,
                forms: v.forms.map((f) => (f.id === formId ? { ...f, status: 'active' as const } : f)),
              },
        ),
      },
    });
  }

  /**
   * An ACTIVE form is not edited in place: Create New Version bumps the
   * version and returns it to Draft, carrying the content forward. This is the
   * lifecycle gate an agent must discover — the pencil is missing on active
   * rows, and the affordance that restores it has a different name.
   */
  createNewVersion(visitId: string, formId: string): void {
    this.commit({
      ...this.state,
      study: {
        ...this.state.study,
        visits: this.state.study.visits.map((v) =>
          v.id !== visitId
            ? v
            : {
                ...v,
                forms: v.forms.map((f) =>
                  f.id === formId && f.status === 'active'
                    ? { ...f, status: 'draft' as const, version: f.version + 1 }
                    : f,
                ),
              },
        ),
      },
    });
  }

  // ── builder lifecycle ─────────────────────────────────────────────────────

  openBuilder(visitId: string, formId: string): void {
    const visit = this.state.study.visits.find((v) => v.id === visitId);
    const form = visit?.forms.find((f) => f.id === formId);
    if (!form || form.status !== 'draft') return;
    const working = deepCopy(form);
    this.commit({
      ...this.state,
      ui: {
        ...this.state.ui,
        route: { kind: 'builder', visitId, formId },
        visitFormOpen: false,
        visitDraft: { ...EMPTY_VISIT_DRAFT },
        formFormOpen: false,
        formDraft: { ...EMPTY_FORM_DRAFT },
        builder: {
          ...emptyBuilder(),
          working,
          selectedPageId: working.pages[0]?.id ?? '',
        },
      },
    });
  }

  /** Commit the working copy over the saved form. The ONLY path by which builder edits persist. */
  saveWorking(): void {
    const { route, builder } = this.state.ui;
    if (route.kind !== 'builder' || !builder.working) return;
    const saved = deepCopy(builder.working);
    this.commit({
      ...this.state,
      study: {
        ...this.state.study,
        visits: this.state.study.visits.map((v) =>
          v.id !== route.visitId
            ? v
            : { ...v, forms: v.forms.map((f) => (f.id === saved.id ? saved : f)) },
        ),
      },
      ui: {
        ...this.state.ui,
        builder: { ...builder, dirty: false, notice: 'Saved.' },
      },
    });
  }

  /**
   * Looks and sits like Save, is not Save. Persists nothing to the study —
   * the near-miss the builder's top bar exists to pose.
   */
  saveAsTemplate(): void {
    if (this.state.ui.route.kind !== 'builder') return;
    this.patchBuilder({ notice: 'Saved as a reusable template.' });
  }

  /** Refuses while dirty — the button LOOKS live either way (trap 3, behavioral half). */
  activateWorking(): void {
    const { route, builder } = this.state.ui;
    if (route.kind !== 'builder' || !builder.working) return;
    if (builder.dirty) {
      this.patchBuilder({ notice: 'Save the document before activating.' });
      return;
    }
    this.activateForm(route.visitId, route.formId);
    this.patchBuilder({
      working: { ...builder.working, status: 'active' },
      notice: 'Document activated.',
    });
  }

  openPreview(): void {
    this.patchBuilder({ previewOpen: true });
  }

  closePreview(): void {
    this.patchBuilder({ previewOpen: false });
  }

  // ── builder: pages and library ────────────────────────────────────────────

  setLibraryFilter(filter: string): void {
    this.patchBuilder({ libraryFilter: filter });
  }

  selectPage(pageId: string): void {
    this.patchBuilder({ selectedPageId: pageId, selectedElementId: null });
  }

  addPage(): void {
    const { builder } = this.state.ui;
    if (!builder.working) return;
    const page: FormPage = {
      id: nextId('pg'),
      name: `Page ${builder.working.pages.length + 1}`,
      elements: [],
    };
    this.patchBuilder({
      working: { ...builder.working, pages: [...builder.working.pages, page] },
      selectedPageId: page.id,
      selectedElementId: null,
      dirty: true,
    });
  }

  /**
   * Add an element of the given type to the selected page and select it.
   *
   * The default label is the TYPE label ("Dropdown"), as the product does. A
   * builder that never renames it produces a structurally present but
   * unmatchable field — silent-wrong, catchable only by read-back.
   */
  addElement(type: FieldType): void {
    const { builder } = this.state.ui;
    if (!builder.working) return;
    const element: BuiltElement = {
      id: nextId('el'),
      label: elementTypeLabel(type),
      type,
      required: false,
      hidden: false,
      placeholder: '',
      min: '',
      max: '',
      units: '',
      decimalPlaces: '',
      formula: '',
      allowPast: true,
      allowFuture: true,
      values: [],
      visibility: { mode: 'always' },
    };
    this.patchBuilder({
      working: {
        ...builder.working,
        pages: builder.working.pages.map((p) =>
          p.id === builder.selectedPageId ? { ...p, elements: [...p.elements, element] } : p,
        ),
      },
      selectedElementId: element.id,
      dirty: true,
    });
  }

  selectElement(elementId: string): void {
    this.patchBuilder({ selectedElementId: elementId });
  }

  deleteSelectedElement(): void {
    const { builder } = this.state.ui;
    if (!builder.working || !builder.selectedElementId) return;
    this.patchBuilder({
      working: {
        ...builder.working,
        pages: builder.working.pages.map((p) => ({
          ...p,
          elements: p.elements.filter((e) => e.id !== builder.selectedElementId),
        })),
      },
      selectedElementId: null,
      dirty: true,
    });
  }

  // ── builder: Options panel ────────────────────────────────────────────────

  selectedElement(): BuiltElement | undefined {
    const { builder } = this.state.ui;
    if (!builder.working || !builder.selectedElementId) return undefined;
    for (const page of builder.working.pages) {
      const found = page.elements.find((e) => e.id === builder.selectedElementId);
      if (found) return found;
    }
    return undefined;
  }

  private updateSelected(update: (element: BuiltElement) => BuiltElement): void {
    const { builder } = this.state.ui;
    if (!builder.working || !builder.selectedElementId) return;
    this.patchBuilder({
      working: {
        ...builder.working,
        pages: builder.working.pages.map((p) => ({
          ...p,
          elements: p.elements.map((e) => (e.id === builder.selectedElementId ? update(e) : e)),
        })),
      },
      dirty: true,
    });
  }

  patchSelected(patch: Partial<Omit<BuiltElement, 'id' | 'type' | 'values' | 'visibility'>>): void {
    this.updateSelected((e) => ({ ...e, ...patch }));
  }

  /**
   * Trap 1. Changing type silently discards whatever the new type cannot
   * hold: values, range/units, formula. The panel simply stops showing those
   * sections, so nothing on screen says data was lost.
   */
  setSelectedType(type: FieldType): void {
    const def = fieldType(type);
    this.updateSelected((e) => ({
      ...e,
      type,
      values: def.hasOptions ? e.values : [],
      min: def.hasRange ? e.min : '',
      max: def.hasRange ? e.max : '',
      units: def.hasRange ? e.units : '',
      decimalPlaces: type === 'decimal' ? e.decimalPlaces : '',
      formula: def.hasFormula ? e.formula : '',
    }));
  }

  addValue(): void {
    const value: BuiltValue = { id: nextId('val'), code: '', label: '' };
    this.updateSelected((e) => ({ ...e, values: [...e.values, value] }));
  }

  setValueCode(index: number, code: string): void {
    this.updateSelected((e) => ({
      ...e,
      values: e.values.map((v, i) => (i === index ? { ...v, code } : v)),
    }));
  }

  setValueLabel(index: number, label: string): void {
    this.updateSelected((e) => ({
      ...e,
      values: e.values.map((v, i) => (i === index ? { ...v, label } : v)),
    }));
  }

  removeValue(index: number): void {
    this.updateSelected((e) => ({ ...e, values: e.values.filter((_, i) => i !== index) }));
  }

  setPasteText(pasteText: string): void {
    this.patchBuilder({ pasteText });
  }

  /**
   * Trap 2. Paste Values REPLACES the list — hand-added rows are gone. Lines
   * are `code=label`, or a bare label whose code defaults to the label.
   */
  applyPasteValues(): void {
    const lines = this.state.ui.builder.pasteText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const values: BuiltValue[] = lines.map((line) => {
      const eq = line.indexOf('=');
      const code = eq === -1 ? line : line.slice(0, eq).trim();
      const label = eq === -1 ? line : line.slice(eq + 1).trim();
      return { id: nextId('val'), code, label };
    });
    this.updateSelected((e) => ({ ...e, values }));
    this.patchBuilder({ pasteText: '' });
  }

  setVisibilityMode(mode: Visibility['mode']): void {
    this.updateSelected((e) => ({
      ...e,
      visibility:
        mode === 'always' ? { mode: 'always' } : { mode: 'when', whenElementId: '', equalsValue: '' },
    }));
  }

  setVisibilityWhen(whenElementId: string): void {
    this.updateSelected((e) =>
      e.visibility.mode === 'when'
        ? { ...e, visibility: { ...e.visibility, whenElementId } }
        : e,
    );
  }

  setVisibilityValue(equalsValue: string): void {
    this.updateSelected((e) =>
      e.visibility.mode === 'when'
        ? { ...e, visibility: { ...e.visibility, equalsValue } }
        : e,
    );
  }

  // ── lookups used by the renderer ──────────────────────────────────────────

  currentVisit(): BuiltVisit | undefined {
    const { route } = this.state.ui;
    if (route.kind === 'plan') return undefined;
    return this.state.study.visits.find((v) => v.id === route.visitId);
  }

  selectedPage(): FormPage | undefined {
    const { builder } = this.state.ui;
    return builder.working?.pages.find((p) => p.id === builder.selectedPageId);
  }

  reset(): void {
    sequence = 0;
    this.commit({
      study: { name: this.state.study.name, visits: [] },
      ui: {
        route: { kind: 'plan' },
        visitFormOpen: false,
        visitDraft: { ...EMPTY_VISIT_DRAFT },
        formFormOpen: false,
        formDraft: { ...EMPTY_FORM_DRAFT },
        builder: emptyBuilder(),
      },
    });
  }
}
