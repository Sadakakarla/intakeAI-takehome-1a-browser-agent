// Minimal human-gate mechanism for Phase 4. Sends a proposed, not-yet-committed action to the
// side panel over a persistent chrome.runtime.connect() port and waits for an explicit
// approve/reject response before the caller proceeds. This is deliberately the smallest working
// version: one pending action at a time, no queue, no editing, no persistence across a closed
// side panel. Phase 7 replaces this with the full triage/escalation-queue UX described in the
// architecture; nothing here should be assumed to be the final design.
//
// A persistent port (rather than one-off sendMessage calls) is used per the project's existing
// design decision on the side panel connection — it also keeps this service worker alive for as
// long as the panel stays open, which matters for a run that pauses here for an indefinite amount
// of real time waiting on a human.

const GATE_PORT_NAME = "gate-panel";

let connectedPort = null;
const pendingRequests = new Map();
let nextRequestId = 1;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== GATE_PORT_NAME) return;

  connectedPort = port;

  port.onMessage.addListener((message) => {
    if (message.type !== "gate:response") return;
    const resolver = pendingRequests.get(message.requestId);
    if (!resolver) return; // Stale or duplicate response — nothing to resolve.
    pendingRequests.delete(message.requestId);
    resolver(message.approved);
  });

  port.onDisconnect.addListener(() => {
    if (connectedPort === port) connectedPort = null;
    // Any request still pending when the panel disconnects can never be answered — resolve each
    // as a rejection rather than leaving the caller hanging forever, since "the human is gone" is
    // functionally equivalent to "the human said no" for a run that must not silently proceed.
    for (const [requestId, resolve] of pendingRequests) {
      resolve(false);
      pendingRequests.delete(requestId);
    }
  });
});

// Sends a human-approval request to the side panel and resolves once the human responds.
// `description` is a short, plain-language summary of the action ("Create visit 'Screening'
// (window: day -28 to day -1)"); `details` is an arbitrary JSON-serializable object shown
// alongside it for context. `screenshotBase64` is optional — a base64-encoded PNG (with Set-of-
// Mark boxes already drawn on it, if the caller has one) shown alongside the description so the
// reviewer sees exactly what the agent saw, not just a text summary of it. Omitted entirely when
// the caller has no screenshot to offer, rather than sending an empty string — the side panel
// treats "no screenshotBase64 key at all" as "nothing to show," never as a broken image.
// Resolves to a boolean: true if approved, false if rejected — and also false, immediately, if
// no side panel is currently connected, since a run must never silently proceed on an action
// nobody actually saw.
export function requestHumanApproval(description, details = {}, screenshotBase64 = null) {
  if (!connectedPort) {
    console.error("[gate] no side panel connected — treating this action as rejected");
    return Promise.resolve(false);
  }

  const requestId = nextRequestId++;
  return new Promise((resolve) => {
    pendingRequests.set(requestId, resolve);
    const message = { type: "gate:request", requestId, description, details };
    if (screenshotBase64) message.screenshotBase64 = screenshotBase64;
    connectedPort.postMessage(message);
  });
}