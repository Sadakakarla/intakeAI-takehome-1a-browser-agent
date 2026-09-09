// Manages the lifecycle of the single chrome.debugger session used as the agent's sole channel
// into the target page: attaching (with a pre-check for a stale session left by a prior crashed
// run), detecting a session end the agent did not itself initiate (for example, the user opening
// Chrome DevTools on the same tab, which the browser treats as mutually exclusive with an
// extension's debugger session and will silently end ours), and guaranteeing a clean detach at
// the end of every run regardless of how that run ends.

const PROTOCOL_VERSION = "1.3";

// Thrown when the debugger session ends mid-run for a reason outside the agent's own control.
// Callers should treat this the same way as any other mid-run stop: halt cleanly, leave build
// state exactly where it is, and surface the reason to the human, rather than failing silently
// or attempting to push forward with a session that no longer exists.
export class UnexpectedDetachError extends Error {
  constructor(reason) {
    super(`Debugger session ended unexpectedly (reason: ${reason || "unknown"})`);
    this.name = "UnexpectedDetachError";
    this.reason = reason;
  }
}

// Tracks tabs whose current detach was initiated by detachSession() itself, so the onDetach
// listener can tell an intentional end-of-run detach apart from an externally caused one.
const intentionalDetaches = new Set();

let onUnexpectedDetachHandler = null;

chrome.debugger.onDetach.addListener((source, reason) => {
  const { tabId } = source;
  if (intentionalDetaches.has(tabId)) {
    intentionalDetaches.delete(tabId);
    return;
  }
  console.warn(`[debugger-session] unexpected detach on tab ${tabId}, reason: ${reason}`);
  if (onUnexpectedDetachHandler) {
    onUnexpectedDetachHandler(tabId, reason);
  }
});

// Registers the callback invoked when a debugger session ends for a reason the agent did not
// initiate. Only one handler is supported, matching the current single-tab, single-run design.
// Call this once per run, before attachSession().
export function setUnexpectedDetachHandler(handler) {
  onUnexpectedDetachHandler = handler;
}

// Attaches the debugger to the given tab. chrome.debugger.getTargets() can tell us that *some*
// debugger session already exists on a tab, but not who owns it — and an extension can only
// detach a session it opened itself. So rather than guessing, this attempts a direct attach
// first; if that fails, it tries a self-clear-and-retry, which correctly recovers a stale session
// left behind by this same extension's own prior run. If it still fails after that, the session
// belongs to something we have no ability to clear (most commonly, Chrome DevTools open on the
// same tab, which the browser treats as mutually exclusive with an extension debugger session) —
// in that case, a clear, actionable message is surfaced instead of a raw low-level error.
export async function attachSession(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (firstError) {
    console.warn(
      `[debugger-session] initial attach to tab ${tabId} failed (${firstError.message}); attempting to clear a stale session from a prior run and retry once`
    );

    intentionalDetaches.add(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch (detachError) {
      // detach() only succeeds for a session this extension itself opened. Failure here means
      // either there is nothing to clear, or the existing session belongs to something we have
      // no ability to detach (e.g. DevTools) — either way, no onDetach will fire as a result of
      // this call, so the intentional-detach marker must be removed rather than left dangling.
      intentionalDetaches.delete(tabId);
    }

    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (secondError) {
      throw new Error(
        `Could not attach the debugger to this tab. Chrome DevTools (or another tool) may already ` +
          `be attached to it — close it and try again. Original error: ${secondError.message}`
      );
    }
  }

  // The Accessibility and DOM domains must be explicitly enabled before their query methods
  // (getFullAXTree, getBoxModel) return data.
  await chrome.debugger.sendCommand({ tabId }, "Accessibility.enable");
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
}

// Detaches the debugger from the given tab. Marks the detach as intentional first, so the
// onDetach listener does not mistake this for an externally caused session end.
export async function detachSession(tabId) {
  intentionalDetaches.add(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    // Most commonly means the session was already gone (e.g. the tab itself was closed).
    // Worth logging, not worth treating as fatal.
    intentionalDetaches.delete(tabId);
    console.warn(`[debugger-session] detach on tab ${tabId} failed (session may already be gone):`, error);
  }
}

// Sends a single CDP command against the given tab's active session. Kept as a thin wrapper in
// this module so every CDP call in the agent goes through one place — the same pattern already
// used for callGroq in agent.js.
export async function sendCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}