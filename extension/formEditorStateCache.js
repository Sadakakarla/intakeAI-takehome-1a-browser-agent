// In-memory tracking of "the form and field we most recently confirmed were really on screen,"
// used by createField.js's Stage 1 to skip a real, paid confirmFormEditorScreen call for most
// fields of a form — not by removing that check, but by trying a genuinely free, code-only proxy
// for the same question first. See createField.js's Stage 1 for the actual decision logic; this
// module only owns the small piece of state that logic depends on.
//
// Deliberately NOT persisted to chrome.storage, same reasoning as saveButtonCache.js — this state
// is only meaningful for the current run against the current screen.

let state = null; // { formName, lastConfirmedFieldLabel } | null

export function resetFormEditorStateCache() {
  state = null;
}

export function getFormEditorState() {
  return state;
}

export function setFormEditorState(formName, lastConfirmedFieldLabel) {
  state = { formName, lastConfirmedFieldLabel };
}