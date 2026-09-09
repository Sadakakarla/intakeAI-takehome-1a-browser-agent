// Shared storage accessor for the study input file (the IR) the agent is building against.
// Exists as its own module — rather than folding the storage key into both the side panel (the
// writer, via its upload control) and the driver (the reader) — so both sides agree on exactly
// one storage key and one validated shape, the same pattern already used by typeMappingCache.js
// and record.js for their own storage-backed concerns.

const STORAGE_KEY = "loadedIr";

// A minimal plausibility check, not a full schema validator. Enough to catch "this obviously
// isn't an IR file" (wrong file selected, a truncated upload, valid JSON that happens to be
// something else entirely) at the moment of upload, with a message a human can act on
// immediately — rather than letting a malformed file surface as a confusing crash deep inside a
// run, on whichever visit or form happens to be missing what the build functions assumed was
// there. Does not validate every field-level key (e.g. a form missing "fields" entirely would
// still pass this check and fail later as an ordinary JS error) — tightening this further is
// reasonable future polish, not required for this check's actual purpose.
function isPlausibleIr(candidate) {
  return (
    candidate &&
    typeof candidate === "object" &&
    Array.isArray(candidate.visits) &&
    candidate.visits.length > 0 &&
    candidate.visits.every((v) => typeof v.name === "string" && Array.isArray(v.forms))
  );
}

export class InvalidIrError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidIrError";
  }
}

// Validates and stores a newly uploaded IR object. Throws InvalidIrError — and stores nothing —
// if the shape doesn't look like a real IR, so a bad upload can never silently overwrite a
// previously good one.
export async function setLoadedIr(candidate, sourceFilename) {
  if (!isPlausibleIr(candidate)) {
    throw new InvalidIrError(
      'This file doesn\'t look like a study IR — expected a top-level "visits" array, where ' +
        'each visit has a "name" and a "forms" array.'
    );
  }
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ir: candidate, sourceFilename, loadedAt: new Date().toISOString() },
  });
}

// Returns the currently loaded IR record ({ ir, sourceFilename, loadedAt }), or null if nothing
// has been uploaded yet.
export async function getLoadedIr() {
  const { [STORAGE_KEY]: record = null } = await chrome.storage.local.get(STORAGE_KEY);
  return record;
}