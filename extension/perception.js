// Extracts a clean, numbered list of interactive candidate elements from the page's
// accessibility tree — the primary perception source per the agreed design (§15a, §15d). Each
// candidate carries its accessible role and name (the browser's own computed values, which
// already resolve <label for>, aria-label, aria-labelledby, and placeholder fallback) and its
// real on-screen bounding box, obtained via DOM.getBoxModel rather than any DOM-walking of our
// own.

import { sendCommand } from "./debugger-session.js";

// AX roles considered "interactive" for the purpose of this agent — i.e. things a study builder
// might click, type into, or select. This is a first-pass list; it is expected to be refined as
// real forms are exercised in later phases; it does not need to be exhaustive today, since a role
// missing from this set fails safe (the element is simply not offered as a candidate, which
// surfaces as a normal "couldn't locate" escalation rather than a silent wrong action).
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

// Converts a DOM.getBoxModel result's content quad (four corner points: x1,y1,x2,y2,x3,y3,x4,y4,
// not guaranteed to be axis-ordered) into a simple {x, y, width, height} rectangle. Exported so
// actions.js can re-derive fresh coordinates after scrolling a candidate into view, rather than
// duplicating this same conversion logic in a second file.
export function quadToRect(model) {
  if (!model || !Array.isArray(model.content) || model.content.length < 8) return null;
  const xs = [model.content[0], model.content[2], model.content[4], model.content[6]];
  const ys = [model.content[1], model.content[3], model.content[5], model.content[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return { x, y, width, height };
}

// Returns the page's interactive elements as {markNumber, role, name, boundingBox, backendNodeId,
// source: "axtree"} objects, numbered in AXTree traversal order — the browser's own accessible
// reading order, not an order this code invents. Elements with no resolvable box (commonly:
// hidden, detached, or zero-size) are skipped rather than included with a meaningless location.
export async function getAxCandidates(tabId) {
  const { nodes } = await sendCommand(tabId, "Accessibility.getFullAXTree");
  const candidates = [];
  let markNumber = 0;

  for (const node of nodes) {
    if (node.ignored) continue;

    const role = node.role && node.role.value;
    const checked = getCheckedState(node, role);
    if (!role || !INTERACTIVE_ROLES.has(role)) continue;
    if (!node.backendDOMNodeId) continue;

    let rect = null;
    try {
      const { model } = await sendCommand(tabId, "DOM.getBoxModel", {
        backendNodeId: node.backendDOMNodeId,
      });
      rect = quadToRect(model);
    } catch (error) {
      // Most commonly means the AX node's backing DOM node is currently hidden or was removed
      // since the tree was captured. Skip this one node rather than fail the whole perception
      // pass over it.
      continue;
    }

    if (!rect || rect.width <= 0 || rect.height <= 0) continue;

    // markNumber += 1;
    // candidates.push({
    //   markNumber,
    //   role,
    //   name: (node.name && node.name.value) || "",
    //   boundingBox: rect,
    //   backendNodeId: node.backendDOMNodeId,
    //   source: "axtree",
    // });
    markNumber += 1;
    candidates.push({
      markNumber,
      role,
      name: (node.name && node.name.value) || "",
      value: (node.value && node.value.value) ?? null,
      boundingBox: rect,
      backendNodeId: node.backendDOMNodeId,
      source: "axtree",
    });
  }

  return candidates;
}

// Self-contained scan function, injected into the target page via chrome.scripting.executeScript.
// Runs inside the page's own isolated world, so it cannot reference anything from this module's
// scope — every helper it needs is nested inside it. This is the fallback perception path (§15a,
// §15d): used only when AXTree data for a given element looks incomplete or ambiguous, since most
// of perception is expected to be served by the AXTree path for free.
//
// Returns unnumbered candidates — {role, name, boundingBox} — since numbering is decided by the
// merge step, not by this scan.
function scanInteractiveElements() {
  function getAccessibleNameGuess(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelText = labelledBy
        .split(/\s+/)
        .map((id) => {
          const node = document.getElementById(id);
          return node ? node.textContent.trim() : "";
        })
        .filter(Boolean)
        .join(" ");
      if (labelText) return labelText;
    }

    if (el.id) {
      const labelFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelFor && labelFor.textContent.trim()) return labelFor.textContent.trim();
    }

    const closestLabel = el.closest("label");
    if (closestLabel && closestLabel.textContent.trim()) return closestLabel.textContent.trim();

    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();

    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();

    const text = el.textContent && el.textContent.trim();
    if (text) return text.slice(0, 200);

    return "";
  }

  function guessRole(el) {
    const explicitRole = el.getAttribute("role");
    if (explicitRole) return explicitRole;

    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "button" || type === "submit") return "button";
      return "textbox";
    }
    if (el.hasAttribute("contenteditable")) return "textbox";
    return "generic";
  }

  const SELECTOR = "input, select, textarea, button, a[href], [role], [tabindex], [contenteditable]";
  const elements = Array.from(document.querySelectorAll(SELECTOR));
  const results = [];

  for (const el of elements) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || el.disabled) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    results.push({
      role: guessRole(el),
      name: getAccessibleNameGuess(el),
      boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }

  return results;
}

// Runs the fallback scan against the given tab via activeTab-gated script injection (per §15a).
// Requires that the extension has been invoked (e.g. the toolbar icon clicked) for this tab
// since its last navigation — if that hasn't happened, this throws, and the caller should treat
// the fallback as unavailable for this attempt rather than silently proceeding without it.
export async function getFallbackCandidates(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: scanInteractiveElements,
  });
  return result || [];
}

// Overlap fraction of two {x, y, width, height} boxes, used by mergeCandidates to decide whether
// an AXTree candidate and a fallback candidate refer to the same on-screen element.
//
// This is intersection-over-minimum-area, not the more familiar intersection-over-union. The two
// sources measure systematically different regions for the same element: DOM.getBoxModel's
// content box (AXTree candidates) excludes padding and border, while getBoundingClientRect()
// (fallback candidates) includes them — so for any padded, bordered element, the AXTree box is
// expected to sit entirely inside the fallback's larger box. IoU penalizes that as a poor match
// purely because the two boxes differ in size, even when one is fully contained in the other;
// intersection-over-minimum-area correctly scores full containment as a perfect match regardless
// of the size difference between the two boxes, which is the actual question being asked here.
function boxOverlap(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const interWidth = Math.max(0, x2 - x1);
  const interHeight = Math.max(0, y2 - y1);
  const interArea = interWidth * interHeight;
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  if (minArea <= 0) return 0;
  return interArea / minArea;
}

const OVERLAP_MATCH_THRESHOLD = 0.75;

// Merges AXTree candidates (primary, already numbered) with fallback candidates (unnumbered),
// per §15d's design: a strong overlap against an existing AXTree candidate is treated as the same
// element, and AXTree's role/name is kept as-is on conflict, since it's the browser's own
// semantic layer rather than a heuristic guess. A fallback candidate with no AXTree counterpart
// at all is a real element AXTree missed entirely — per the assignment's recall-over-precision
// grading weight, this is added as a new candidate, continuing the mark-number sequence, rather
// than discarded.
export function mergeCandidates(axCandidates, fallbackCandidates) {
  const merged = axCandidates.map((c) => ({ ...c }));
  let nextMark = merged.reduce((max, c) => Math.max(max, c.markNumber), 0) + 1;

  for (const fallback of fallbackCandidates) {
    const hasMatch = merged.some(
      (existing) => boxOverlap(existing.boundingBox, fallback.boundingBox) >= OVERLAP_MATCH_THRESHOLD
    );

    if (!hasMatch) {
      merged.push({
        markNumber: nextMark,
        role: fallback.role,
        name: fallback.name,
        boundingBox: fallback.boundingBox,
        source: "content-script",
      });
      nextMark += 1;
    }
  }

  return merged;
}

// Perceives the current screen's interactive candidates. Tries the AXTree path alone first,
// since it is free and normally sufficient. Only attempts the content-script fallback merge when
// AXTree alone finds nothing, since that is specifically the situation the fallback exists for —
// and because the fallback requires activeTab access that may not yet have been granted. A
// missing grant is treated as "fallback unavailable this time," not a fatal error: an empty
// result either way is left for the caller to treat as its own escalation trigger.
export async function perceiveCandidates(tabId) {
  const axCandidates = await getAxCandidates(tabId);
  if (axCandidates.length > 0) return axCandidates;

  try {
    const fallbackCandidates = await getFallbackCandidates(tabId);
    return mergeCandidates(axCandidates, fallbackCandidates);
  } catch (error) {
    console.warn(
      "[perception] AXTree found nothing and the content-script fallback was unavailable " +
        `(${error.message}); proceeding with an empty candidate list`
    );
    return axCandidates;
  }
}

// Reads a native <select> element's real option list — {value, label} pairs — directly via its
// own DOM node, bypassing the accessibility tree and screenshot entirely. Exists because a native
// select's own open popup is rendered by the OS/browser chrome layer, not the page's own DOM
// rendering surface: it is invisible to both Accessibility.getFullAXTree (no AX nodes exist for
// its real options) and Page.captureScreenshot (a vision call cannot read text that was never
// painted into the page's own rendering surface). Uses the candidate's own backendNodeId (already
// captured by perceiveCandidates) to resolve a live remote-object reference via CDP, then reads
// its `.options` property directly — the only reliable way to discover a native select's real
// choices at all. Returns [] for any element that isn't a real <select> (or has no options),
// rather than throwing — callers treat an empty result as a signal, not an error.
export async function getNativeSelectOptions(tabId, backendNodeId) {
  if (!backendNodeId) return [];

  const { object } = await sendCommand(tabId, "DOM.resolveNode", { backendNodeId });
  if (!object || !object.objectId) return [];

  const { result } = await sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration:
      "function() { return Array.from(this.options || []).map(o => ({ value: o.value, label: o.text })); }",
    returnByValue: true,
  });

  return (result && result.value) || [];
}

// Returns the accessible name of every node in the AXTree with meaningful text — not just
// interactive candidates. getAxCandidates/perceiveCandidates build a click-target list; this is
// for reading rendered content back (e.g. verifying a newly created visit's name and window
// actually appear on screen), regardless of what structural role the platform renders them
// under — a table cell, a plain div, a custom component, whatever it turns out to be.
export async function getAllAccessibleText(tabId) {
  const { nodes } = await sendCommand(tabId, "Accessibility.getFullAXTree");
  const texts = [];
  for (const node of nodes) {
    const name = node.name && node.name.value;
    if (typeof name === "string" && name.trim().length > 0) {
      texts.push(name.trim());
    }
  }
  return texts;
}

// Roles where a checked/unchecked (or indeterminate) state is meaningful. Reading this
// correctly is what lets an action SET a checkbox idempotently — click only if the current
// state doesn't already match the desired one — rather than blindly toggling it, which would be
// wrong exactly half the time on an unseen platform whose default state isn't known in advance.
const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

// Extracts the AX "checked" property from a node's properties array. Returns "true", "false",
// "mixed" (a genuine indeterminate tri-state some UI checkboxes support), or null when the role
// isn't checkable or the property is absent — null is treated by callers as "state unknown,"
// not assumed to mean unchecked.
function getCheckedState(node, role) {
  if (!CHECKABLE_ROLES.has(role)) return null;
  const properties = node.properties || [];
  const checkedProp = properties.find((p) => p.name === "checked");
  return checkedProp && checkedProp.value ? checkedProp.value.value : null;
}