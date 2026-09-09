// In-memory cache of a form's Save button location, keyed by form name. Deliberately NOT
// persisted to chrome.storage the way typeMappingCache.js's cross-platform-relevant facts are —
// a Save button's identity is only meaningful for as long as the browser tab is actually showing
// that specific form's editor, and has no reason to survive a service-worker restart or leak
// between platforms the way a genuine type-mapping fact does.
//
// Exists because paying a real semantic locate call for the Save button on every single field's
// commit is pure waste once a form has more than one field: the button's identity doesn't change
// across a form's own fields, only across different forms — so it should be located once per form
// and reused, the same probe-once/cache-the-signature pattern already proven by the type-mapping
// cache and createField.js's own addOptionRow "Add Value" button.

const cache = new Map();

// Cleared once at the true top of a run, the same moment the type-mapping cache is reset — a
// signature learned during one run (or worse, against one platform) must never leak into another.
export function resetSaveButtonCache() {
  cache.clear();
}

export function getSaveButtonCacheEntry(formName) {
  return cache.get(formName) || null;
}

export function setSaveButtonCacheEntry(formName, { label, axRole }) {
  cache.set(formName, { label, axRole });
}

// Called when a cached signature is re-found on screen but the resulting click doesn't actually
// commit — the same self-healing principle already used for the type-mapping cache: a stale or
// wrong cached fact is discarded immediately, never propagated silently, and the caller falls
// through to a fresh, fully-verified locate instead of trusting the cache again.
export function invalidateSaveButtonCacheEntry(formName) {
  cache.delete(formName);
}