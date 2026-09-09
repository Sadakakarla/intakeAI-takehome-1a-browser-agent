// Shared, generic page-action primitives. Every action here uses CDP synthetic, OS-level
// input events (Input.dispatchMouseEvent, Input.insertText) rather than any DOM-level shortcut
// (.click(), .value=) — load-bearing for working against arbitrary, unknown widget libraries,
// since framework-controlled elements can silently ignore direct DOM manipulation while still
// responding correctly to real input events.

import { sendCommand } from "./debugger-session.js";
import { quadToRect } from "./perception.js";

// Clicks the center of a candidate's bounding box. Coordinates are in CSS pixels — the same
// space DOM.getBoxModel reports bounding boxes in. This is a different coordinate space from a
// screenshot's own pixel dimensions (som-overlay.js's scaleX/scaleY); that scale factor must
// never be applied here, or every click would land in the wrong place on a HiDPI display.
//
// Scrolls the target into view first, using its backendNodeId (already captured by
// perception.js) — a candidate can be correctly found via the accessibility tree while sitting
// entirely outside the current viewport, since AXTree traversal doesn't care about scroll
// position at all. Dispatching a click at a stale, off-screen bounding box then lands on nothing,
// or on whatever else happens to occupy that same screen position — a real, previously-latent
// bug that only surfaced once a genuinely tall screen (a long form's Preview modal) appeared;
// every screen exercised before that happened to fit within one viewport already. After
// scrolling, the bounding box is re-fetched fresh, since scrolling changes the element's on-screen
// position and the coordinates captured at perception time are no longer necessarily correct.
export async function clickCandidate(tabId, candidate) {
  let boundingBox = candidate.boundingBox;

  if (candidate.backendNodeId) {
    try {
      await sendCommand(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: candidate.backendNodeId });
      const { model } = await sendCommand(tabId, "DOM.getBoxModel", { backendNodeId: candidate.backendNodeId });
      const refreshed = quadToRect(model);
      if (refreshed) boundingBox = refreshed;
    } catch (error) {
      console.warn(
        `[clickCandidate] scroll/re-measure failed for mark #${candidate.markNumber}, using existing coordinates:`,
        error.message
      );
    }
  }

  const x = boundingBox.x + boundingBox.width / 2;
  const y = boundingBox.y + boundingBox.height / 2;

  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

// Clicks a candidate to focus it, then types the given text via a real input-level event. Does
// not clear any existing content first — callers that need a clean field are responsible for
// clearing it themselves (e.g. select-all + delete), since "insert" and "replace" are genuinely
// different operations and this function should not silently guess which one a caller wants.
export async function typeText(tabId, candidate, text) {
  await clickCandidate(tabId, candidate);
  await sendCommand(tabId, "Input.insertText", { text });
}

// Cheap-first dead-click check: compares candidate counts before/after an action, since most
// real navigations or UI changes alter how many interactive elements exist on the page and this
// costs nothing beyond candidates already being perceived on both sides. Falls back to a full
// (role, name) pair-set diff only when the count is unchanged, to catch a screen being replaced
// by one with the same number of controls.
function candidateKey(candidate) {
  return `${candidate.role}::${candidate.name}`;
}

export function screenChangedMaterially(before, after) {
  if (before.length !== after.length) return true;

  const beforeKeys = new Set(before.map(candidateKey));
  const afterKeys = new Set(after.map(candidateKey));
  if (beforeKeys.size !== afterKeys.size) return true;
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) return true;
  }
  return false;
}

// Sets a checkbox/radio/switch candidate to the desired checked state, idempotently — clicks
// only if the candidate's current, already-perceived state doesn't already match, rather than
// blindly toggling. A "mixed" (indeterminate) current state, or a candidate with no known checked
// state at all (checked === null), is NOT guessed at — the caller must handle that as its own
// escalation, since blindly clicking a tri-state control without knowing which way it moves is
// exactly the kind of silent guess this project is built to avoid.
export async function setCheckedState(tabId, candidate, desiredChecked) {
  if (candidate.checked === null) {
    throw new Error(
      `setCheckedState: candidate (mark #${candidate.markNumber}, role="${candidate.role}") has no known checked state — cannot set safely without guessing`
    );
  }
  if (candidate.checked === "mixed") {
    throw new Error(
      `setCheckedState: candidate (mark #${candidate.markNumber}) is in an indeterminate ("mixed") state — cannot determine which way a click would move it`
    );
  }

  const currentlyChecked = candidate.checked === "true";
  if (currentlyChecked !== desiredChecked) {
    await clickCandidate(tabId, candidate);
  }
}

// Generic count-aware "what's new" diff: returns entries from `after` with no matching,
// not-yet-consumed counterpart in `before`, keyed by keyFn. The same operation serves two
// purposes in this project: finding a newly added UI candidate (diffNewCandidates) and detecting
// whether new descriptive text appeared anywhere on screen (diffNewText, used by createField.js
// to confirm a field got selected for editing, regardless of how many clicks that took).
function diffNew(before, after, keyFn) {
  const beforeCounts = new Map();
  for (const item of before) {
    const key = keyFn(item);
    beforeCounts.set(key, (beforeCounts.get(key) || 0) + 1);
  }
  const consumed = new Map();
  const result = [];
  for (const item of after) {
    const key = keyFn(item);
    const available = beforeCounts.get(key) || 0;
    const used = consumed.get(key) || 0;
    if (used < available) {
      consumed.set(key, used + 1);
    } else {
      result.push(item);
    }
  }
  return result;
}

export function diffNewCandidates(before, after) {
  return diffNew(before, after, candidateKey);
}

export function diffNewText(before, after) {
  return diffNew(before, after, (t) => t);
}

// Sends real keyboard events for each character of `text`, used specifically to drive a native
// <select>'s own built-in type-ahead search (jumping to the option whose visible text starts with
// the typed characters) — a control this project has no other generic way to operate, since a
// native select's real options are not exposed to the accessibility tree as inspectable, clickable
// candidates the way a custom-rendered dropdown's are.
//
// Deliberately does NOT use Input.insertText (the mechanism clearAndType/typeText use for text
// fields) — insertText simulates IME-style text composition, which sets a text field's value but
// does not trigger a native select's keyboard-driven type-ahead search. Real keyDown/keyUp events,
// one per character, are what the browser's own native select-search logic listens for.
//
// This is a pure input-dispatch primitive: it does not clear any prior search buffer, and it does
// not verify the resulting selection. The caller is responsible for re-perceiving afterward and
// independently confirming the control's resulting value matches what was intended — the same
// read-back discipline already required of every other write in this project.
export async function typeAheadSelect(tabId, candidate, text) {
  await clickCandidate(tabId, candidate);

  for (const char of text) {
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: char,
      text: char,
    });
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: char,
      text: char,
    });
  }
}

const MAX_CLEAR_KEYSTROKES = 100;

export async function clearAndType(tabId, candidate, text) {
  await clickCandidate(tabId, candidate);

  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "End",
    code: "End",
    windowsVirtualKeyCode: 35,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "End",
    code: "End",
    windowsVirtualKeyCode: 35,
  });

  for (let i = 0; i < MAX_CLEAR_KEYSTROKES; i += 1) {
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
  }

  await sendCommand(tabId, "Input.insertText", { text });
}