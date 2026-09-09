// In-memory cache of the platform's own "reveal this field's conditional-visibility rule"
// affordance — a single, run-wide fact, not keyed per field or per form. Deliberately NOT
// persisted to chrome.storage, for the same reason saveButtonCache.js isn't: this fact is only
// meaningful for as long as the current run is looking at the same platform, and has no reason to
// survive a service-worker restart or leak between platforms.
//
// Exists because paying a real semantic locate call for this affordance on every one of the run's
// skip-logic rules is pure waste once more than one rule exists: the control's identity doesn't
// change across fields on the same platform — so it should be located once, for the whole run,
// and reused, the same probe-once/cache-the-signature pattern already proven by
// saveButtonCache.js and createField.js's own addOptionRow "Add Value" button.

let entry = null;

// Cleared once at the true top of a run, the same moment the type-mapping and Save-button caches
// are reset — a signature learned during one run (or worse, against one platform) must never leak
// into another.
export function resetSkipLogicPanelCache() {
  entry = null;
}

export function getSkipLogicPanelCacheEntry() {
  return entry;
}

export function setSkipLogicPanelCacheEntry({ label, axRole }) {
  entry = { label, axRole };
}

// Called when a cached signature is re-found on screen but doesn't actually reveal the expected
// conditional-visibility controls — the same self-healing principle already used elsewhere: a
// stale or wrong cached fact is discarded immediately, never propagated silently, and the caller
// falls through to a fresh, fully-verified locate instead of trusting the cache again.
export function invalidateSkipLogicPanelCacheEntry() {
  entry = null;
}