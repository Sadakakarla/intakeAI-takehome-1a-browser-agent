// In-memory, per-run cache of whether a distinct form DEFINITION supports a reuse/attach
// affordance, keyed by the definition's own name + field signature — not by name alone, per the
// architecture's explicit "name + field-signature" key (two forms sharing a name with genuinely
// different fields must never share a cache entry). Deliberately in-memory, not persisted to
// chrome.storage the way the type-mapping cache is: a reuse fact, like a Save button's location,
// is only meaningful for the platform currently being driven this run, and has no reason to
// survive a service-worker restart or leak into a different run against a different platform.
//
// Exists so a recurring form definition (e.g. Vital Signs, appearing at four visits in this
// project's real IR) is only ever probed for reuse support once — on its first occurrence — with
// every later occurrence reusing that same answer instead of repeating the probe.

const cache = new Map();

// Deterministic, order-independent signature for a form definition: sorted "label:type" pairs
// joined into one string. Order-independent because the architecture's own definition of "the
// same form definition" is about WHICH fields it has, not the sequence they're listed in for this
// particular occurrence.
export function formDefinitionSignature(formFields) {
  return formFields
    .map((f) => `${f.label}:${f.type}`)
    .sort()
    .join("|");
}

function cacheKey(formName, signature) {
  return `${formName}::${signature}`;
}

// Cleared once at the true top of a run, the same moment every other per-run cache is reset — a
// reuse fact learned during one run (or worse, against one platform) must never leak into another.
export function resetFormReuseCache() {
  cache.clear();
}

export function getFormReuseCacheEntry(formName, signature) {
  return cache.get(cacheKey(formName, signature)) || null;
}

export function setFormReuseCacheEntry(formName, signature, { reuseAvailable, reasoning }) {
  cache.set(cacheKey(formName, signature), { reuseAvailable, reasoning });
}