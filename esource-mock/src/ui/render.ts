import { tag } from '../shared/tag';
import { fieldType, type FieldType } from '../shared/study';
import { ELEMENT_TYPES, elementTypeLabel } from '../spec/surface';
import type { BuiltElement, BuiltForm, FormPage } from '../engine/state';
import type { Mock1Store } from '../engine/store';

/**
 * Mock 1's one rendering: a plain-DOM three-pane builder in the visual
 * language of the product it models — dark-maroon chrome, teal primary
 * actions, white cards on light gray.
 *
 * Mock 1 is the BASELINE platform of the suite: honest labels, stable ids,
 * no framework. Its difficulty is the surface itself — a form lifecycle, a
 * paged canvas, an element library with near-duplicate entries, an Options
 * panel that reshapes under the type selector, and inert preview controls
 * that shadow every real one.
 */

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

/** Label + control wired by for/id, tagged so it cannot render untagged. */
function labelled(
  id: string,
  labelText: string,
  control: HTMLElement,
  gt: string,
  className = 'row',
  gtIndex?: number,
): HTMLElement {
  control.setAttribute('id', id);
  tag(control, gt, gtIndex);
  return el('div', { class: className }, [el('label', { for: id }, [labelText]), control]);
}

function btn(id: string, text: string, gt: string, className = 'btn', gtIndex?: number): HTMLButtonElement {
  const button = el('button', { type: 'button', id, class: className }, [text]);
  tag(button, gt, gtIndex);
  return button;
}

/**
 * The structural render key. Draft TEXT is deliberately excluded — inputs are
 * uncontrolled and re-rendering per keystroke would destroy the caret. What IS
 * included is everything that changes which controls exist.
 */
export function layoutKey(store: Mock1Store): string {
  const { study, ui } = store.getState();
  const route = ui.route;
  const routeKey =
    route.kind === 'plan'
      ? 'plan'
      : route.kind === 'visit'
        ? `visit:${route.visitId}`
        : `builder:${route.visitId}:${route.formId}`;

  const studyKey = study.visits
    .map((v) => `${v.id}(${v.forms.map((f) => `${f.id}:${f.status}:${f.version}`).join(',')})`)
    .join('|');

  const b = ui.builder;
  const selected = store.selectedElement();
  const workingKey = b.working
    ? [
        b.working.status,
        b.dirty,
        b.working.pages.map((p) => `${p.id}:${p.elements.length}`).join(','),
        b.selectedPageId,
        b.selectedElementId ?? '-',
        selected ? `${selected.type}:${selected.values.length}:${selected.visibility.mode}` : '-',
        b.libraryFilter,
        b.previewOpen,
        b.notice ?? '',
      ].join('~')
    : '-';

  return [routeKey, studyKey, ui.visitFormOpen, ui.formFormOpen, workingKey].join('#');
}

export function mount(store: Mock1Store, root: HTMLElement): void {
  let last: string | null = null;
  const render = (): void => {
    const key = layoutKey(store);
    if (key === last) return;
    last = key;
    root.replaceChildren(build(store));
  };
  store.subscribe(render);
  render();
}

export function build(store: Mock1Store): HTMLElement {
  const { study, ui } = store.getState();
  const app = el('div', { class: 'app' });

  app.append(
    el('header', { class: 'chrome' }, [
      el('div', { class: 'brand' }, ['intakeAI eSource']),
      el('nav', { class: 'chrome-tabs', 'aria-label': 'Modules' }, [
        // Sibling modules that do nothing — the Study Plan tab must be picked
        // out, not handed over as the only thing on screen.
        el('button', { type: 'button', class: 'chrome-tab', id: 'module-patients' }, ['Patients']),
        el('button', { type: 'button', class: 'chrome-tab', id: 'module-calendar' }, ['Calendar']),
        el('button', { type: 'button', class: 'chrome-tab active', id: 'module-study', 'aria-current': 'page' }, ['Study Plan']),
        el('button', { type: 'button', class: 'chrome-tab', id: 'module-reports' }, ['Reports']),
      ]),
      el('div', { class: 'study-name' }, [study.name]),
    ]),
  );

  const main = el('main', { class: 'main' });
  app.append(main);

  switch (ui.route.kind) {
    case 'plan':
      main.append(...planScreen(store));
      break;
    case 'visit':
      main.append(...visitScreen(store));
      break;
    case 'builder':
      main.append(builderScreen(store));
      break;
  }

  if (ui.builder.previewOpen && ui.builder.working) app.append(previewModal(store, ui.builder.working));
  return app;
}

// ── Study Plan: the visit schedule ──────────────────────────────────────────

function planScreen(store: Mock1Store): HTMLElement[] {
  const { study, ui } = store.getState();
  const nodes: HTMLElement[] = [el('h2', {}, ['Visit Schedule'])];

  const table = el('table', { class: 'grid' });
  table.append(
    el('thead', {}, [
      el('tr', {}, [
        el('th', {}, ['Visit']),
        el('th', {}, ['Window (days)']),
        el('th', {}, ['Source Documents']),
        el('th', {}, ['']),
      ]),
    ]),
  );
  const body = el('tbody', {});
  for (const [index, visit] of study.visits.entries()) {
    const open = tag(
      el('button', { type: 'button', class: 'link', id: `open-visit-${visit.id}` }, [visit.name]),
      'visit.row',
      index,
    );
    open.addEventListener('click', () => store.navigate({ kind: 'visit', visitId: visit.id }));
    body.append(
      el('tr', {}, [
        el('td', {}, [open]),
        el('td', {}, [`${visit.windowStart} to ${visit.windowEnd}`]),
        el('td', {}, [String(visit.forms.length)]),
        el('td', {}, ['']),
      ]),
    );
  }
  if (study.visits.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '4', class: 'empty' }, ['No visits defined.'])]));
  }
  table.append(body);
  nodes.push(table);

  const add = btn('add-visit', '+ Add Visit', 'visit.add_button', 'btn primary');
  add.addEventListener('click', () => store.openVisitForm());
  nodes.push(add);

  if (ui.visitFormOpen) {
    const card = el('div', { class: 'card inline-form' }, [el('h3', {}, ['New Visit'])]);
    const name = el('input', { type: 'text' });
    name.addEventListener('input', () => store.setVisitDraft({ name: name.value }));
    const start = el('input', { type: 'text' });
    start.addEventListener('input', () => store.setVisitDraft({ windowStart: start.value }));
    const end = el('input', { type: 'text' });
    end.addEventListener('input', () => store.setVisitDraft({ windowEnd: end.value }));
    const save = btn('save-visit', 'Save Visit', 'visit.save_button', 'btn primary');
    save.addEventListener('click', () => store.saveVisit());
    const cancel = btn('cancel-visit', 'Cancel', 'visit.cancel_button');
    cancel.addEventListener('click', () => store.cancelVisitForm());
    card.append(
      labelled('visit-name', 'Visit Name', name, 'visit.name_input'),
      labelled('visit-window-start', 'Window Start (day)', start, 'visit.window_start_input'),
      labelled('visit-window-end', 'Window End (day)', end, 'visit.window_end_input'),
      el('div', { class: 'actions' }, [save, cancel]),
    );
    nodes.push(card);
  }

  return nodes;
}

// ── Visit detail: the source-documents table ────────────────────────────────

function visitScreen(store: Mock1Store): HTMLElement[] {
  const visit = store.currentVisit();
  if (!visit) return [el('p', {}, ['Visit not found.'])];
  const { ui } = store.getState();

  const back = btn('back-to-plan', '← Visit Schedule', 'visit.back_to_plan', 'btn link-btn');
  back.addEventListener('click', () => store.navigate({ kind: 'plan' }));

  const nodes: HTMLElement[] = [
    el('p', { class: 'breadcrumb' }, [`Study Plan / ${visit.name}`]),
    back,
    el('h2', {}, [`${visit.name} — Source Documents`]),
  ];

  const table = el('table', { class: 'grid' });
  table.append(
    el('thead', {}, [
      el('tr', {}, [
        el('th', {}, ['Document']),
        el('th', {}, ['Version']),
        el('th', {}, ['Status']),
        el('th', {}, ['Type']),
        el('th', {}, ['Actions']),
      ]),
    ]),
  );
  const body = el('tbody', {});
  for (const [index, form] of visit.forms.entries()) {
    const actions = el('td', { class: 'row-actions' });
    if (form.status === 'draft') {
      const edit = btn(`edit-form-${form.id}`, '✎ Edit', 'form.edit_button', 'btn small', index);
      edit.addEventListener('click', () => store.openBuilder(visit.id, form.id));
      const activate = btn(`activate-form-${form.id}`, 'Activate', 'form.activate_button', 'btn small teal', index);
      activate.addEventListener('click', () => store.activateForm(visit.id, form.id));
      actions.append(edit, activate);
    } else {
      // The pencil is gone on active rows; the way back to editing has a
      // different name. Lifecycle discovery, not decoration.
      const newVersion = btn(`new-version-${form.id}`, 'Create New Version', 'form.new_version_button', 'btn small', index);
      newVersion.addEventListener('click', () => store.createNewVersion(visit.id, form.id));
      actions.append(newVersion);
    }
    const del = btn(`delete-form-${form.id}`, 'Delete', 'form.delete_button', 'btn small danger', index);
    del.addEventListener('click', () => store.deleteForm(visit.id, form.id));
    actions.append(del);

    body.append(
      el('tr', {}, [
        tag(el('td', { class: 'doc-name' }, [form.name]), 'form.row', index),
        el('td', {}, [`v${form.version}`]),
        el('td', {}, [el('span', { class: `chip ${form.status}` }, [form.status === 'draft' ? 'Draft' : 'Active'])]),
        el('td', {}, [form.repeating ? 'Repeating log' : 'Standard']),
        actions,
      ]),
    );
  }
  if (visit.forms.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '5', class: 'empty' }, ['No source documents.'])]));
  }
  table.append(body);
  nodes.push(table);

  const add = btn('new-form', '+ New Source Document', 'form.new_button', 'btn primary');
  add.addEventListener('click', () => store.openFormForm());
  nodes.push(add);

  if (ui.formFormOpen) {
    const card = el('div', { class: 'card inline-form' }, [el('h3', {}, ['New Source Document'])]);
    const name = el('input', { type: 'text' });
    name.addEventListener('input', () => store.setFormDraft({ name: name.value }));
    const repeating = el('input', { type: 'checkbox' });
    repeating.addEventListener('change', () => store.setFormDraft({ repeating: repeating.checked }));
    const create = btn('create-form', 'Create', 'form.create_button', 'btn primary');
    create.addEventListener('click', () => store.createForm());
    const cancel = btn('cancel-form', 'Cancel', 'form.cancel_button');
    cancel.addEventListener('click', () => store.cancelFormForm());
    card.append(
      labelled('form-name', 'Document Name', name, 'form.name_input'),
      labelled('form-repeating', 'Repeating log (many records per visit)', repeating, 'form.repeating_toggle', 'row checkbox'),
      el('div', { class: 'actions' }, [create, cancel]),
    );
    nodes.push(card);
  }

  return nodes;
}

// ── Form builder ─────────────────────────────────────────────────────────────

function builderScreen(store: Mock1Store): HTMLElement {
  const { ui } = store.getState();
  const visit = store.currentVisit();
  const working = ui.builder.working;
  if (!visit || !working) return el('p', {}, ['Document not found.']);

  const wrap = el('div', { class: 'builder' });

  // Top bar.
  const back = btn('builder-back', `← ${visit.name}`, 'builder.back_button', 'btn link-btn');
  back.addEventListener('click', () => store.navigate({ kind: 'visit', visitId: visit.id }));

  const save = btn('builder-save', 'Save', 'builder.save_button', 'btn teal');
  save.addEventListener('click', () => store.saveWorking());
  // Sits beside Save, styled like Save, is not Save.
  const saveTemplate = btn('builder-save-template', 'Save As Template', 'builder.save_template_button', 'btn teal');
  saveTemplate.addEventListener('click', () => store.saveAsTemplate());
  const preview = btn('builder-preview', 'Preview Form', 'builder.preview_button', 'btn');
  preview.addEventListener('click', () => store.openPreview());
  // Looks live regardless of dirty state; refuses with a toast when dirty.
  const activate = btn('builder-activate', 'Activate', 'builder.activate_button', 'btn primary');
  activate.addEventListener('click', () => store.activateWorking());

  const statusBits = [`v${working.version}`, working.status === 'draft' ? 'Draft' : 'Active'];
  if (ui.builder.dirty) statusBits.push('Unsaved changes');

  wrap.append(
    el('div', { class: 'builder-bar' }, [
      el('div', { class: 'builder-bar-left' }, [
        back,
        el('span', { class: 'builder-title' }, [working.name]),
        el('span', { class: 'builder-status' }, [statusBits.join(' · ')]),
      ]),
      el('div', { class: 'builder-bar-right' }, [preview, saveTemplate, save, activate]),
    ]),
  );
  if (ui.builder.notice) {
    wrap.append(el('div', { class: 'toast', role: 'status' }, [ui.builder.notice]));
  }

  const columns = el('div', { class: 'builder-columns' });
  columns.append(libraryColumn(store), canvasColumn(store, working), optionsColumn(store));
  wrap.append(columns);
  return wrap;
}

function libraryColumn(store: Mock1Store): HTMLElement {
  const { builder } = store.getState().ui;
  const column = el('aside', { class: 'library' }, [el('h3', {}, ['Elements'])]);

  const filter = el('input', { type: 'text', placeholder: 'Filter elements…' });
  filter.value = builder.libraryFilter;
  filter.addEventListener('input', () => store.setLibraryFilter(filter.value));
  column.append(labelled('library-filter', 'Find', filter, 'library.filter_input', 'row compact'));

  const list = el('ul', { class: 'library-list' });
  const needle = builder.libraryFilter.trim().toLowerCase();
  for (const [index, def] of ELEMENT_TYPES.entries()) {
    if (needle && !def.label.toLowerCase().includes(needle)) continue;
    const item = tag(
      el('button', { type: 'button', class: 'library-item', id: `library-${def.canonical}` }, [def.label]),
      'library.item',
      index,
    );
    item.addEventListener('click', () => store.addElement(def.canonical));
    list.append(el('li', {}, [item]));
  }
  column.append(list);

  // Enabled-looking, permanently inert — the visual half of trap 3 in the
  // library. No listener, no disabled attribute.
  column.append(el('button', { type: 'button', class: 'library-item ghost', id: 'library-import' }, ['Import From Library…']));
  return column;
}

function canvasColumn(store: Mock1Store, working: BuiltForm): HTMLElement {
  const { builder } = store.getState().ui;
  const column = el('section', { class: 'canvas' });

  const tabs = el('div', { class: 'page-tabs', role: 'tablist' });
  for (const [index, page] of working.pages.entries()) {
    const isSelected = page.id === builder.selectedPageId;
    const tabEl = tag(
      el('button', { type: 'button', class: `page-tab${isSelected ? ' active' : ''}`, id: `page-tab-${page.id}`, role: 'tab' }, [page.name]),
      'page.tab',
      index,
    );
    tabEl.addEventListener('click', () => store.selectPage(page.id));
    tabs.append(tabEl);
  }
  const addPage = btn('add-page', '+ Page', 'page.add_button', 'btn small');
  addPage.addEventListener('click', () => store.addPage());
  tabs.append(addPage);
  column.append(tabs);

  const page = store.selectedPage();
  const surface = el('div', { class: 'canvas-surface' });
  if (!page || page.elements.length === 0) {
    surface.append(el('p', { class: 'empty' }, ['Click an element on the left to add it to this page.']));
  } else {
    for (const [index, element] of page.elements.entries()) {
      surface.append(elementCard(store, element, index, element.id === builder.selectedElementId));
    }
  }
  column.append(surface);
  return column;
}

/**
 * An element card is the element AS THE FORM WILL SHOW IT — which means every
 * card contains an enabled-looking control that persists nothing. The card's
 * inert control and the Options panel's live Label input share the element's
 * label text; telling them apart is the grounding task.
 */
function elementCard(store: Mock1Store, element: BuiltElement, index: number, selected: boolean): HTMLElement {
  const card = tag(
    el('div', { class: `element-card${selected ? ' selected' : ''}`, id: `element-${element.id}` }),
    'canvas.element',
    index,
  );
  card.addEventListener('click', () => store.selectElement(element.id));

  const bits = [elementTypeLabel(element.type)];
  if (element.required) bits.push('Required');
  if (element.hidden) bits.push('Hidden');
  if (element.visibility.mode === 'when') bits.push('Conditional');

  card.append(
    el('div', { class: 'element-head' }, [
      el('span', { class: 'element-label' }, [element.label + (element.required ? ' *' : '')]),
      el('span', { class: 'element-meta' }, [bits.join(' · ')]),
    ]),
    inertControl(element),
  );
  return card;
}

/** The inert preview control for a type. No listeners — writes land in the DOM and persist nowhere. */
function inertControl(element: BuiltElement): HTMLElement {
  const holder = el('div', { class: 'element-preview' });
  switch (element.type) {
    case 'text':
      holder.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: element.placeholder }));
      break;
    case 'textarea':
      holder.append(el('textarea', { rows: '2', 'aria-label': element.label }));
      break;
    case 'integer':
    case 'decimal':
      holder.append(
        el('input', { type: 'text', 'aria-label': element.label, class: 'narrow' }),
        el('span', { class: 'units' }, [element.units]),
      );
      break;
    case 'date':
      holder.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: 'DD-MMM-YYYY', class: 'narrow' }));
      break;
    case 'time':
      holder.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: 'HH:MM', class: 'narrow' }));
      break;
    case 'datetime':
      holder.append(el('input', { type: 'text', 'aria-label': element.label, placeholder: 'DD-MMM-YYYY HH:MM', class: 'narrow' }));
      break;
    case 'boolean':
      holder.append(
        el('button', { type: 'button', class: 'pill' }, ['Yes']),
        el('button', { type: 'button', class: 'pill' }, ['No']),
      );
      break;
    case 'single_select': {
      const select = el('select', { 'aria-label': element.label });
      select.append(el('option', {}, ['— Select —']));
      for (const value of element.values) select.append(el('option', {}, [value.label]));
      holder.append(select);
      break;
    }
    case 'multi_select':
    case 'radio': {
      const kind = element.type === 'radio' ? 'radio' : 'checkbox';
      for (const value of element.values) {
        holder.append(
          el('span', { class: 'choice' }, [el('input', { type: kind, 'aria-label': `${element.label}: ${value.label}` }), value.label]),
        );
      }
      if (element.values.length === 0) holder.append(el('span', { class: 'element-meta' }, ['No values defined.']));
      break;
    }
    case 'checkbox':
      holder.append(el('span', { class: 'choice' }, [el('input', { type: 'checkbox', 'aria-label': element.label }), element.label]));
      break;
    case 'calculated':
      holder.append(el('input', { type: 'text', 'aria-label': element.label, readonly: 'readonly', value: element.formula ? `= ${element.formula}` : '= (no formula)' }));
      break;
  }
  return holder;
}

function optionsColumn(store: Mock1Store): HTMLElement {
  const column = el('aside', { class: 'options' }, [el('h3', {}, ['Options'])]);
  const element = store.selectedElement();
  if (!element) {
    column.append(el('p', { class: 'empty' }, ['Select an element on the canvas to edit its options.']));
    return column;
  }
  const def = fieldType(element.type);
  const working = store.getState().ui.builder.working;

  const label = el('input', { type: 'text' });
  label.value = element.label;
  label.addEventListener('input', () => store.patchSelected({ label: label.value }));
  column.append(labelled('opt-label', 'Label', label, 'options.label_input'));

  const type = el('select', {});
  for (const t of ELEMENT_TYPES) {
    const opt = el('option', { value: t.canonical }, [t.label]);
    if (t.canonical === element.type) opt.setAttribute('selected', 'selected');
    type.append(opt);
  }
  type.addEventListener('change', () => store.setSelectedType(type.value as FieldType));
  column.append(labelled('opt-type', 'Element Type', type, 'options.type_select'));

  const required = el('input', { type: 'checkbox' });
  if (element.required) required.setAttribute('checked', 'checked');
  required.addEventListener('change', () => store.patchSelected({ required: required.checked }));
  column.append(labelled('opt-required', 'Required', required, 'options.required_toggle', 'row checkbox'));

  const hidden = el('input', { type: 'checkbox' });
  if (element.hidden) hidden.setAttribute('checked', 'checked');
  hidden.addEventListener('change', () => store.patchSelected({ hidden: hidden.checked }));
  column.append(labelled('opt-hidden', 'Hidden', hidden, 'options.hidden_toggle', 'row checkbox'));

  if (element.type === 'text' || element.type === 'textarea') {
    const placeholder = el('input', { type: 'text' });
    placeholder.value = element.placeholder;
    placeholder.addEventListener('input', () => store.patchSelected({ placeholder: placeholder.value }));
    column.append(labelled('opt-placeholder', 'Placeholder', placeholder, 'options.placeholder_input'));
  }

  if (def.hasRange) {
    const fieldset = el('fieldset', {}, [el('legend', {}, ['Range Check'])]);
    const min = el('input', { type: 'text' });
    min.value = element.min;
    min.addEventListener('input', () => store.patchSelected({ min: min.value }));
    const max = el('input', { type: 'text' });
    max.value = element.max;
    max.addEventListener('input', () => store.patchSelected({ max: max.value }));
    const units = el('input', { type: 'text' });
    units.value = element.units;
    units.addEventListener('input', () => store.patchSelected({ units: units.value }));
    fieldset.append(
      labelled('opt-min', 'Minimum', min, 'options.min_input'),
      labelled('opt-max', 'Maximum', max, 'options.max_input'),
      labelled('opt-units', 'Units', units, 'options.units_input'),
    );
    if (element.type === 'decimal') {
      const places = el('input', { type: 'text' });
      places.value = element.decimalPlaces;
      places.addEventListener('input', () => store.patchSelected({ decimalPlaces: places.value }));
      fieldset.append(labelled('opt-decimal-places', 'Decimal Places', places, 'options.decimal_places_input'));
    }
    column.append(fieldset);
  }

  if (element.type === 'date' || element.type === 'datetime' || element.type === 'time') {
    const fieldset = el('fieldset', {}, [el('legend', {}, ['Picker Options'])]);
    const past = el('input', { type: 'checkbox' });
    if (element.allowPast) past.setAttribute('checked', 'checked');
    past.addEventListener('change', () => store.patchSelected({ allowPast: past.checked }));
    const future = el('input', { type: 'checkbox' });
    if (element.allowFuture) future.setAttribute('checked', 'checked');
    future.addEventListener('change', () => store.patchSelected({ allowFuture: future.checked }));
    fieldset.append(
      labelled('opt-allow-past', 'Allow Past Dates', past, 'options.allow_past_toggle', 'row checkbox'),
      labelled('opt-allow-future', 'Allow Future Dates', future, 'options.allow_future_toggle', 'row checkbox'),
    );
    column.append(fieldset);
  }

  if (def.hasFormula) {
    const formula = el('input', { type: 'text', placeholder: 'e.g. Weight / (Height / 100) ^ 2' });
    formula.value = element.formula;
    formula.addEventListener('input', () => store.patchSelected({ formula: formula.value }));
    column.append(labelled('opt-formula', 'Formula', formula, 'options.formula_input'));
  }

  if (def.hasOptions) {
    const fieldset = el('fieldset', { class: 'values' }, [el('legend', {}, ['Values'])]);
    element.values.forEach((value, index) => {
      const code = el('input', { type: 'text', class: 'narrow' });
      code.value = value.code;
      code.addEventListener('input', () => store.setValueCode(index, code.value));
      const valueLabel = el('input', { type: 'text' });
      valueLabel.value = value.label;
      valueLabel.addEventListener('input', () => store.setValueLabel(index, valueLabel.value));
      const remove = btn(`value-remove-${index}`, '×', 'options.value_remove_button', 'btn small danger', index);
      remove.addEventListener('click', () => store.removeValue(index));
      fieldset.append(
        el('div', { class: 'value-row' }, [
          labelled(`value-code-${index}`, 'Code', code, 'options.value_code_input', 'row compact', index),
          labelled(`value-label-${index}`, 'Label', valueLabel, 'options.value_label_input', 'row compact', index),
          remove,
        ]),
      );
    });
    const add = btn('value-add', '+ Add Value', 'options.value_add_button', 'btn small');
    add.addEventListener('click', () => store.addValue());
    fieldset.append(add);

    const paste = el('textarea', { rows: '3', placeholder: 'code=Label, one per line' });
    paste.addEventListener('input', () => store.setPasteText(paste.value));
    const apply = btn('value-paste-apply', 'Apply Pasted Values', 'options.value_paste_apply', 'btn small');
    apply.addEventListener('click', () => store.applyPasteValues());
    fieldset.append(labelled('value-paste', 'Paste Values (replaces list)', paste, 'options.value_paste_textarea'), apply);
    column.append(fieldset);
  }

  // Element Visibility — the skip-logic editor.
  const fieldset = el('fieldset', {}, [el('legend', {}, ['Element Visibility'])]);
  const mode = el('select', {});
  mode.append(el('option', { value: 'always' }, ['Visible']));
  mode.append(el('option', { value: 'when' }, ['Visible When…']));
  if (element.visibility.mode === 'when') (mode.children[1] as HTMLOptionElement).setAttribute('selected', 'selected');
  mode.addEventListener('change', () => store.setVisibilityMode(mode.value as 'always' | 'when'));
  fieldset.append(labelled('opt-visibility', 'Visibility', mode, 'options.visibility_select'));

  if (element.visibility.mode === 'when') {
    const when = el('select', {});
    when.append(el('option', { value: '' }, ['— choose element —']));
    for (const page of working?.pages ?? []) {
      for (const other of page.elements) {
        if (other.id === element.id) continue;
        const opt = el('option', { value: other.id }, [other.label]);
        if (other.id === element.visibility.whenElementId) opt.setAttribute('selected', 'selected');
        when.append(opt);
      }
    }
    when.addEventListener('change', () => store.setVisibilityWhen(when.value));
    const equals = el('input', { type: 'text' });
    equals.value = element.visibility.equalsValue;
    equals.addEventListener('input', () => store.setVisibilityValue(equals.value));
    fieldset.append(
      labelled('opt-visibility-when', 'When Element', when, 'options.visibility_when_select'),
      labelled('opt-visibility-value', 'Equals Value', equals, 'options.visibility_value_input'),
    );
  }
  column.append(fieldset);

  const del = btn('opt-delete-element', 'Delete Element', 'options.delete_element_button', 'btn danger');
  del.addEventListener('click', () => store.deleteSelectedElement());
  column.append(del);

  return column;
}

// ── Preview modal ────────────────────────────────────────────────────────────

function previewModal(store: Mock1Store, working: BuiltForm): HTMLElement {
  const panel = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Preview Form' });
  panel.append(el('h3', {}, [`Preview — ${working.name}`]));
  for (const page of working.pages) {
    panel.append(el('h4', {}, [page.name]));
    for (const element of page.elements.filter((e) => !e.hidden)) {
      panel.append(
        el('div', { class: 'preview-row' }, [
          el('span', { class: 'element-label' }, [element.label + (element.required ? ' *' : '')]),
          inertControl(element),
        ]),
      );
    }
  }
  const close = btn('preview-close', 'Close Preview', 'preview.close_button', 'btn primary');
  close.addEventListener('click', () => store.closePreview());
  panel.append(el('div', { class: 'actions' }, [close]));
  return el('div', { class: 'modal-overlay' }, [panel]);
}

/** A page's elements in canvas order — used by fidelity tests. */
export function pageElements(page: FormPage): BuiltElement[] {
  return page.elements;
}
