// Single shared writer for the agent's traceability log. Every action the agent takes, across
// every step of its loop, produces exactly one record through this function, so the trace log has
// one consistent shape regardless of which part of the agent wrote to it — no consumer of this
// log (including the final traceability read-back) ever needs to branch on more than one shape.
//
// Records are appended to chrome.storage.local as a single growing array, rather than one storage
// key per record, since the log needs to be read back and walked in order as a whole — a single
// array is the natural shape for "everything that happened, in order," and stays well within
// chrome.storage.local's size limits at the scale of this project.

const STORAGE_KEY = "traceLog";

// Every key a record must carry. ir_path is the only one allowed to hold null — for steps that
// don't correspond to a real input-file entry (currently, only Orient).
const REQUIRED_KEYS = [
  "ir_path",
  "step",
  "action_taken",
  "decide_reasoning",
  "confidence",
  "gate_outcome",
  "confirm_result",
];

// Appends one record to the trace log, stamping it with the time it was written. Throws
// synchronously, before touching storage, if the record is missing a required key — a malformed
// record is a bug in the caller worth surfacing immediately, not something to silently patch with
// a placeholder value.
export async function writeRecord(record) {
  for (const key of REQUIRED_KEYS) {
    if (!(key in record)) {
      throw new Error(`writeRecord: record is missing required key "${key}"`);
    }
  }

  const entry = { ...record, timestamp: new Date().toISOString() };

  const { [STORAGE_KEY]: existingLog = [] } = await chrome.storage.local.get(STORAGE_KEY);
  existingLog.push(entry);
  await chrome.storage.local.set({ [STORAGE_KEY]: existingLog });

  return entry;
}

// Reads back the full trace log, in the order records were written.
export async function readTraceLog() {
  const { [STORAGE_KEY]: log = [] } = await chrome.storage.local.get(STORAGE_KEY);
  return log;
}