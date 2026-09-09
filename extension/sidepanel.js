// Intake AI eSource Build Agent — side panel script
//
// Displays a live, per-model Groq call counter, a live feed of Orient's (and later, other steps')
// escalation messages, and the minimal Phase 4 human-gate UI (a single pending action with
// Approve/Reject). The counter and escalation feed read directly from chrome.storage.local and
// re-render on chrome.storage.onChanged, with no polling. The gate UI talks to the background
// service worker over a persistent chrome.runtime.connect() port (see gate.js).

import { setLoadedIr, getLoadedIr, InvalidIrError } from "./ir-store.js";

console.log("[Intake AI Agent] side panel loaded");

// Must match the model IDs the governor tracks (see governor.js's TPD_CAPS keys).
const TRACKED_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "qwen/qwen3.8-27b"];

// Must match the key orient.js writes escalation messages to.
const ESCALATION_STORAGE_KEY = "escalationLog";

function storageKey(model) {
  return `governor:${model}`;
}

function renderCounts(counts) {
  const container = document.getElementById("call-counter");
  container.innerHTML = "";

  for (const model of TRACKED_MODELS) {
    const row = document.createElement("div");
    row.className = "counter-row";

    const label = document.createElement("span");
    label.className = "counter-label";
    label.textContent = model;

    const value = document.createElement("span");
    value.className = "counter-value";
    value.textContent = String(counts[model] ?? 0);

    row.appendChild(label);
    row.appendChild(value);
    container.appendChild(row);
  }
}

async function loadCounts() {
  const keys = TRACKED_MODELS.map(storageKey);
  const result = await chrome.storage.local.get(keys);

  const counts = {};
  for (const model of TRACKED_MODELS) {
    const state = result[storageKey(model)];
    counts[model] = state && typeof state.totalCalls === "number" ? state.totalCalls : 0;
  }
  renderCounts(counts);
}

// Renders the escalation feed. This is a deliberately minimal, temporary display — a real
// interactive approve/edit/reject queue is later work; this exists so an escalation has somewhere
// visible to go right now. No-ops if the side panel's HTML doesn't yet contain the element this
// looks for, rather than throwing.
function renderEscalations(messages) {
  const container = document.getElementById("escalation-log");
  if (!container) return;
  container.innerHTML = "";
  for (const message of messages) {
    const line = document.createElement("div");
    line.className = "escalation-line";
    line.textContent = message;
    container.appendChild(line);
  }
}

async function loadEscalations() {
  const result = await chrome.storage.local.get(ESCALATION_STORAGE_KEY);
  renderEscalations(result[ESCALATION_STORAGE_KEY] || []);
}

// Re-render whenever the governor updates any tracked model's stored state, or a new escalation
// is written, so both stay live without polling chrome.storage on a timer.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const relevantChange = TRACKED_MODELS.some((model) => storageKey(model) in changes);
  if (relevantChange) loadCounts();
  if (ESCALATION_STORAGE_KEY in changes) loadEscalations();
  if ("driverRunState" in changes) {
    renderControlStatus(changes.driverRunState.newValue === "running");
  }
  if ("lastRunSummary" in changes) {
    if (changes.lastRunSummary.newValue) {
      renderLastRunStatus(changes.lastRunSummary.newValue);
    } else {
      renderLastRunStatusEmpty();
    }
  }
});

loadCounts();
loadEscalations();

// --- Human gate (Phase 4 minimal version) ---
//
// Connects a persistent port named "gate-panel" to the background service worker. When a
// "gate:request" message arrives, renders the proposed action with Approve/Reject buttons;
// clicking either sends a "gate:response" message back over the same port and clears the display.
// Deliberately the smallest working version — one request at a time, no queue, no editing. Phase
// 7 replaces this with the full triage-queue UX; nothing here is the final design.

const GATE_PORT_NAME = "gate-panel";
const gatePort = chrome.runtime.connect({ name: GATE_PORT_NAME });

function renderGateEmpty() {
  const container = document.getElementById("gate-request");
  container.className = "gate-empty";
  container.textContent = "No pending action.";
}

function renderGateRequest(requestId, description, details, screenshotBase64) {
  const container = document.getElementById("gate-request");
  container.className = "gate-card";
  container.innerHTML = "";

  // Shown first, above the text description, since this is what the assignment specifically
  // asks the reviewer to see: what the agent actually looked at, with its Set-of-Mark boxes
  // still on it, not just a text summary of what it decided. Omitted entirely (no broken-image
  // placeholder) when the caller had no screenshot to send.
  if (screenshotBase64) {
    const img = document.createElement("img");
    img.className = "gate-screenshot";
    img.src = `data:image/png;base64,${screenshotBase64}`;
    img.alt = "Screenshot of the screen at the moment of this escalation, with SoM marks";
    container.appendChild(img);
  }

  const desc = document.createElement("div");
  desc.className = "gate-description";
  desc.textContent = description;
  container.appendChild(desc);

  if (details && Object.keys(details).length > 0) {
    const detailsEl = document.createElement("pre");
    detailsEl.className = "gate-details";
    detailsEl.textContent = JSON.stringify(details, null, 2);
    container.appendChild(detailsEl);
  }

  const buttons = document.createElement("div");
  buttons.className = "gate-buttons";

  const approveButton = document.createElement("button");
  approveButton.className = "gate-approve";
  approveButton.textContent = "Approve";
  approveButton.addEventListener("click", () => {
    gatePort.postMessage({ type: "gate:response", requestId, approved: true });
    renderGateEmpty();
  });

  const rejectButton = document.createElement("button");
  rejectButton.className = "gate-reject";
  rejectButton.textContent = "Reject";
  rejectButton.addEventListener("click", () => {
    gatePort.postMessage({ type: "gate:response", requestId, approved: false });
    renderGateEmpty();
  });

  buttons.appendChild(approveButton);
  buttons.appendChild(rejectButton);
  container.appendChild(buttons);
}

gatePort.onMessage.addListener((message) => {
  if (message.type !== "gate:request") return;
  renderGateRequest(message.requestId, message.description, message.details, message.screenshotBase64);
});

renderGateEmpty();


// --- Study input file upload ---
//
// Reads a JSON file selected by the user, hands it to ir-store.js for validation and storage,
// and shows the outcome. A bad file (unparseable JSON, or JSON that doesn't look like a real IR)
// is reported clearly and never overwrites a previously good upload — setLoadedIr throws before
// writing anything if validation fails, so this handler only needs to catch and display that.

function summarizeIr(ir) {
  const visitCount = ir.visits.length;
  const formCount = ir.visits.reduce((sum, v) => sum + v.forms.length, 0);
  const fieldCount = ir.visits.reduce(
    (sum, v) => sum + v.forms.reduce((s, f) => s + (f.fields ? f.fields.length : 0), 0),
    0
  );
  return `${visitCount} visit(s), ${formCount} form(s), ${fieldCount} field(s)`;
}

function renderIrStatus(className, text) {
  const el = document.getElementById("ir-status");
  el.className = className;
  el.textContent = text;
}

async function loadIrStatusFromStorage() {
  const loaded = await getLoadedIr();
  if (!loaded) {
    renderIrStatus("ir-status-empty", "No file loaded yet.");
    return;
  }
  renderIrStatus("ir-status-ok", `Loaded: ${loaded.sourceFilename} — ${summarizeIr(loaded.ir)}`);
}

document.getElementById("ir-file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch (error) {
    renderIrStatus("ir-status-error", `Could not read "${file.name}" as JSON: ${error.message}`);
    return;
  }

  try {
    await setLoadedIr(parsed, file.name);
    renderIrStatus("ir-status-ok", `Loaded: ${file.name} — ${summarizeIr(parsed)}`);
  } catch (error) {
    if (error instanceof InvalidIrError) {
      renderIrStatus("ir-status-error", `"${file.name}" was not stored: ${error.message}`);
    } else {
      renderIrStatus("ir-status-error", `Unexpected error storing "${file.name}": ${error.message}`);
    }
  }
});

loadIrStatusFromStorage();

// --- Last Run Status ---
//
// Reads the summary driver.js persists at the end of every run (clean finish, circuit-breaker
// trip, or crash — all three paths call persistLastRunSummary before this side panel ever sees
// them) and renders it here, so "what was left unsuccessful" is visible just by opening the panel
// — no need to have had DevTools open at the exact moment a run stopped. Deliberately filters out
// created fields from the itemized list below the header line: the point of this section is
// surfacing what DIDN'T finish, not re-listing everything that already succeeded.

function flattenRunStatusFields(summary) {
  const all = [];
  for (const visit of summary.visits || []) {
    for (const form of visit.forms || []) {
      for (const field of form.fields || []) {
        all.push({ visitName: visit.name, formName: form.name, ...field });
      }
    }
  }
  return all;
}

function renderLastRunStatus(summary) {
  const container = document.getElementById("last-run-status");
  container.className = "";
  container.innerHTML = "";

  const allFields = flattenRunStatusFields(summary);
  const counts = allFields.reduce((acc, f) => {
    acc[f.status] = (acc[f.status] || 0) + 1;
    return acc;
  }, {});

  const stoppedEarly = Boolean(summary.circuitBreakerTripped || summary.abortedWithError);
  const header = document.createElement("div");
  header.className = "run-status-summary" + (stoppedEarly ? " stopped-early" : "");

  const startedAt = summary.startedAt ? new Date(summary.startedAt).toLocaleString() : "?";
  const finishedAt = summary.finishedAt ? new Date(summary.finishedAt).toLocaleString() : "(never finished)";
  let headerText =
    `Run ${String(summary.runId || "?").slice(0, 8)} — ${startedAt} → ${finishedAt}\n` +
    `Fields: ${allFields.length} total, ${counts.created || 0} created, ${counts.escalated || 0} escalated, ` +
    `${counts.rejected || 0} rejected, ${counts.skipped_dependency || 0} skipped, ` +
    `${counts.not_attempted || 0} not attempted, ${counts.aborted || 0} aborted`;
  if (summary.circuitBreakerTripped) {
    headerText += `\nSTOPPED EARLY — circuit breaker: ${summary.tripReason}`;
  }
  if (summary.abortedWithError) {
    headerText += `\nSTOPPED — unexpected error: ${summary.abortedWithError}`;
  }
  header.textContent = headerText;
  container.appendChild(header);

  const unfinished = allFields.filter((f) => f.status !== "created" && f.status !== "already_exists");

  if (unfinished.length === 0) {
    const allGood = document.createElement("div");
    allGood.className = "run-status-item";
    allGood.textContent =
      allFields.length > 0
        ? "Every attempted field was created successfully."
        : "This run did not attempt any fields.";
    container.appendChild(allGood);
    return;
  }

  for (const field of unfinished) {
    const item = document.createElement("div");
    item.className = `run-status-item status-${field.status}`;
    item.textContent =
      `[${field.visitName} / ${field.formName}] "${field.label}" — ${field.status}` +
      (field.reason ? `: ${field.reason}` : "");
    container.appendChild(item);
  }
}

function renderLastRunStatusEmpty() {
  const container = document.getElementById("last-run-status");
  container.className = "run-status-empty";
  container.textContent = "No run has completed yet.";
}

async function loadLastRunStatus() {
  const { lastRunSummary } = await chrome.storage.local.get("lastRunSummary");
  if (!lastRunSummary) return;
  renderLastRunStatus(lastRunSummary);
}

loadLastRunStatus();

document.getElementById("clear-last-run-btn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "lastrun:clear" });
});


// --- Side-panel control buttons ---
//
// Each button sends a one-off message to the background service worker (see background.js's
// chrome.runtime.onMessage listener) rather than opening a persistent port — none of these need
// a long-lived connection, and the existing gate-panel port above already keeps the service
// worker alive for as long as this panel stays open, which is what actually matters for a run
// that can take tens of minutes.

const startBuildButton = document.getElementById("start-build-btn");
const stopBuildButton = document.getElementById("stop-build-btn");
const clearEscalationsButton = document.getElementById("clear-escalations-btn");
const resetGovernorButton = document.getElementById("reset-governor-btn");
const controlStatusEl = document.getElementById("control-status");

function renderControlStatus(running) {
  controlStatusEl.className = running ? "control-status-running" : "control-status-idle";
  controlStatusEl.textContent = running ? "Running..." : "Idle — no run in progress.";
  startBuildButton.disabled = running;
  stopBuildButton.disabled = !running;
}

startBuildButton.addEventListener("click", () => {
  // Disable immediately, before the message round trip completes — this is the real guard
  // against a double-click starting two runs; the background script's own driverRunState check
  // is a defensive backstop, not the primary defense, since there's a small window between a
  // click and storage confirming "running".
  startBuildButton.disabled = true;
  chrome.runtime.sendMessage({ type: "driver:start" }, (response) => {
    if (response && response.started === false) {
      console.warn("[side panel] Start Build was not started:", response.reason);
      startBuildButton.disabled = false; // Nothing actually started — safe to try again.
    }
  });
});

stopBuildButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "driver:stop" });
});

clearEscalationsButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "escalations:clear" });
});

resetGovernorButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "governor:reset" });
});

async function loadControlStatus() {
  const { driverRunState } = await chrome.storage.local.get("driverRunState");
  renderControlStatus(driverRunState === "running");
}

loadControlStatus();