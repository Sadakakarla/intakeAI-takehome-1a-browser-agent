import {
  attachSession,
  detachSession,
  sendCommand,
  setUnexpectedDetachHandler,
} from "./debugger-session.js";
import { getAxCandidates, getFallbackCandidates, mergeCandidates } from "./perception.js";
import { captureAnnotatedScreenshot } from "./som-overlay.js";
import { callGroq } from "./groq-client.js";
import { runOrient, OrientEscalatedError } from "./orient.js";
import { locateElement } from "./locateElement.js";
import { requestHumanApproval } from "./gate.js";
import { createVisit, CreateVisitEscalatedError } from "./createVisit.js";
import { createForm, CreateFormEscalatedError, activateForm, navigateToVisitDocumentsOrEscalate } from "./createForm.js";
import { createField, CreateFieldEscalatedError } from "./createField.js";
import { resetTypeMappingCache } from "./typeMappingCache.js";
import { probeFormReuseOnce } from "./formReuseProbe.js";
import { resetGovernorState } from "./governor.js";
import { runFullBuild as driverRunFullBuild, requestStop as requestDriverStop } from "./driver.js";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Intake AI Agent] agent loaded");
});

// A freshly-starting service worker can never genuinely be mid-run — if `driverRunState` says
// "running" at this point, it can only be stale leftover from a PREVIOUS worker instance that
// was killed before its own runFullBuild() finally block ever ran (e.g. an extension reload or
// an API key change interrupting an in-progress run). Force it back to idle on every real start,
// so the side panel's Start/Stop buttons never get stuck reflecting a run that no longer exists.
chrome.storage.local.set({ driverRunState: "idle" }).catch((error) =>
  console.warn("[background] failed to reset driverRunState on startup:", error.message)
);

// Clicking the toolbar icon opens the side panel directly.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[Intake AI Agent] setPanelBehavior failed:", error));

// Opening the side panel does NOT grant activeTab access to the tab behind it — unlike a
// popup, Chrome does not treat a side panel open as an unambiguous "the user invoked the
// extension on this specific tab" gesture, since the panel persists across tab switches. A
// registered keyboard command is one of the few gestures Chrome does recognize for this
// purpose, so it is the real mechanism this extension uses to obtain activeTab access before a
// run — not just a testing convenience. The listener body only needs to exist; invoking the
// command is itself what triggers the grant for whichever tab is active at that moment.
chrome.commands.onCommand.addListener((command) => {
  if (command === "grant-page-access") {
    console.log(
      "[Intake AI Agent] grant-page-access invoked — activeTab granted for the current tab"
    );
  }
});

// Temporary manual test hook for Phase 2 verification only. Exposes callGroq on the service
// worker's global scope so it can be invoked directly from its DevTools console, since
// module-scope exports are not otherwise reachable that way. Removed once the per-field
// build loop (Phase 4+) calls callGroq through real application code instead.
globalThis.callGroq = callGroq;

// Manual console hook for clearing the in-run type-mapping cache between test sessions. There is
// no top-level driver yet to own "start of run," so this must be called by hand once before the
// first field of a test session is built — see typeMappingCache.js for why the cache must never
// carry over between runs against different platforms.
globalThis.resetTypeMappingCache = resetTypeMappingCache;

// Manual console hook, same rationale as resetTypeMappingCache above — clears stale rate-limit
// memory left over from a previous Groq API key. Call this after changing the key on the Options
// page, before starting a new run.
globalThis.resetGovernorState = () =>
  resetGovernorState(["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "qwen/qwen3.8-27b"]);

// Shared helper for the temporary manual test hooks below: finds the tab currently running the
// mock via chrome.debugger.getTargets() rather than chrome.tabs.query(), since the latter's
// "active tab" can resolve to whichever window last had focus (e.g. a DevTools window) rather
// than the browser tab actually running the mock.
async function findMockTab() {
  const targets = await chrome.debugger.getTargets();
  const target = targets.find((t) => t.url && t.url.startsWith("http://localhost:5173"));
  if (!target) {
    console.error("[test hook] no tab found running the mock at localhost:5173");
    return null;
  }
  return { id: target.tabId, url: target.url };
}

// Temporary manual test hook for Phase 3 verification only. Attaches to the current tab, pulls
// one full accessibility tree, and detaches again — enough to confirm the attach/detach lifecycle
// and the AXTree query both work end to end before any perception logic is built on top of them.
// Removed once Step 0 (Orient) drives this through real application code instead.
globalThis.testDebuggerSession = async function testDebuggerSession() {
  const tab = await findMockTab();
  if (!tab) return;

  setUnexpectedDetachHandler((tabId, reason) => {
    console.warn(`[testDebuggerSession] session on tab ${tabId} ended unexpectedly: ${reason}`);
  });

  console.log(`[testDebuggerSession] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const { nodes } = await sendCommand(tab.id, "Accessibility.getFullAXTree");
    console.log(`[testDebuggerSession] received ${nodes.length} AX nodes:`, nodes);
  } finally {
    await detachSession(tab.id);
    console.log(`[testDebuggerSession] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook for Phase 3 verification only. Attaches to the current tab, runs
// the AXTree-based candidate extraction, and logs the resulting numbered list — enough to
// manually confirm real interactive elements are found with sane bounding boxes before the
// content-script fallback and merge step are added on top of this. Removed once the LOCATE step
// (Phase 4+) calls getAxCandidates through real application code instead.
globalThis.testPerception = async function testPerception() {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testPerception] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const candidates = await getAxCandidates(tab.id);
    console.log(`[testPerception] found ${candidates.length} interactive candidates:`);
    console.table(
      candidates.map((c) => ({
        mark: c.markNumber,
        role: c.role,
        name: c.name,
        x: Math.round(c.boundingBox.x),
        y: Math.round(c.boundingBox.y),
        width: Math.round(c.boundingBox.width),
        height: Math.round(c.boundingBox.height),
      }))
    );
  } finally {
    await detachSession(tab.id);
    console.log(`[testPerception] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook for Phase 3 verification only. Runs both perception sources against
// the current tab and merges them, so the fallback scan and the IoU-based merge logic can be
// manually checked before either is wired into real LOCATE logic. Note: getFallbackCandidates
// requires activeTab access for this tab, which is granted by clicking the extension's toolbar
// icon while the mock tab is active — if that hasn't happened since the tab last navigated, this
// will throw a permissions error rather than silently skipping the fallback.
// Removed once the LOCATE step (Phase 4+) calls this pipeline through real application code.
globalThis.testFallbackAndMerge = async function testFallbackAndMerge() {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testFallbackAndMerge] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const axCandidates = await getAxCandidates(tab.id);
    console.log(`[testFallbackAndMerge] AXTree found ${axCandidates.length} candidates`);

    const fallbackCandidates = await getFallbackCandidates(tab.id);
    console.log(`[testFallbackAndMerge] content-script scan found ${fallbackCandidates.length} candidates:`);
    console.table(
      fallbackCandidates.map((c) => ({
        role: c.role,
        name: c.name,
        x: Math.round(c.boundingBox.x),
        y: Math.round(c.boundingBox.y),
        width: Math.round(c.boundingBox.width),
        height: Math.round(c.boundingBox.height),
      }))
    );

    const merged = mergeCandidates(axCandidates, fallbackCandidates);
    const addedByFallback = merged.filter((c) => c.source === "content-script");
    console.log(
      `[testFallbackAndMerge] merged result: ${merged.length} total (${addedByFallback.length} added by the fallback that AXTree missed entirely)`
    );
    console.table(
      merged.map((c) => ({
        mark: c.markNumber,
        source: c.source,
        role: c.role,
        name: c.name,
        x: Math.round(c.boundingBox.x),
        y: Math.round(c.boundingBox.y),
        width: Math.round(c.boundingBox.width),
        height: Math.round(c.boundingBox.height),
      }))
    );
  } finally {
    await detachSession(tab.id);
    console.log(`[testFallbackAndMerge] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook for Phase 3 verification only. Attaches to the current tab, captures
// a screenshot via CDP, and opens it in a new tab as a data URL so it can be visually confirmed to
// actually show the right screen — rather than just checking that base64 bytes came back at all.
// Removed once real perception logic (Step 0 Orient, and later steps) calls captureScreenshot
// through application code instead.
globalThis.testScreenshot = async function testScreenshot() {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testScreenshot] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const { data } = await sendCommand(tab.id, "Page.captureScreenshot", { format: "png" });
    console.log(`[testScreenshot] captured screenshot (${data.length} base64 chars) — opening in a new tab`);
    await chrome.tabs.create({ url: `data:image/png;base64,${data}` });
  } finally {
    await detachSession(tab.id);
    console.log(`[testScreenshot] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook for verifying som-overlay.js only. Attaches to the current tab, runs
// AXTree candidate extraction, then captures a screenshot with every candidate's mark drawn on
// it, and opens the result in a new tab — so the box/number placement can be visually confirmed
// against the real page rather than trusted on faith. This is the first real exercise of the
// scale-factor math (Page.getLayoutMetrics vs. the screenshot's actual pixel size), which has
// only been reasoned about, not run against a real tab, until this. Removed once Step 0 (Orient)
// calls captureAnnotatedScreenshot through real application code instead.
globalThis.testAnnotatedScreenshot = async function testAnnotatedScreenshot() {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testAnnotatedScreenshot] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const candidates = await getAxCandidates(tab.id);
    console.log(`[testAnnotatedScreenshot] found ${candidates.length} candidates to mark`);

    const { imageBase64, scaleX, scaleY } = await captureAnnotatedScreenshot(tab.id, candidates);
    console.log(`[testAnnotatedScreenshot] scale factors: scaleX=${scaleX}, scaleY=${scaleY}`);

    await chrome.tabs.create({ url: `data:image/png;base64,${imageBase64}` });
  } finally {
    await detachSession(tab.id);
    console.log(`[testAnnotatedScreenshot] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook for verifying Groq JSON mode against this specific model, using a
// real annotated screenshot rather than a toy image — close enough to what Orient will actually
// send that a pass here is real evidence. Logs the raw response content on success, or the raw
// failed_generation text on failure, since Groq's JSON-mode validation error otherwise gives no
// visibility into what the model actually produced. Removed once Step 0 (Orient) makes this same
// kind of call through real application code.
globalThis.testJsonModeVision = async function testJsonModeVision() {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testJsonModeVision] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  let imageBase64;
  try {
    const candidates = await getAxCandidates(tab.id);
    ({ imageBase64 } = await captureAnnotatedScreenshot(tab.id, candidates));
  } finally {
    await detachSession(tab.id);
    console.log(`[testJsonModeVision] detached from tab ${tab.id}`);
  }

  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "You are looking at a screenshot of a web application, with numbered red boxes " +
            "marking clickable elements. Reply with a JSON object with exactly two keys: " +
            '"screen_description" (a one-sentence description of what this screen shows) and ' +
            '"element_count" (your best count of how many numbered marks you can see). ' +
            "Reply with JSON only.",
        },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    },
  ];

  try {
    const data = await callGroq("qwen/qwen3.6-27b", messages, {
      response_format: { type: "json_object" },
      reasoning_format: "hidden",
      max_tokens: 1500,
    });
    const content = data.choices && data.choices[0] && data.choices[0].message.content;
    console.log("[testJsonModeVision] raw response content:", content);
    console.log("[testJsonModeVision] parsed successfully:", JSON.parse(content));
  } catch (error) {
    console.error("[testJsonModeVision] call failed:", error.message);
    // Print the full error body as a JSON string rather than a collapsed console object, so the
    // actual shape of Groq's error response is visible without needing to click through nested
    // objects in the DevTools console.
    console.error(
      "[testJsonModeVision] full error.data (stringified):",
      JSON.stringify(error.data, null, 2)
    );
  }
};

// Diagnostic-only test hook, not part of the shipped agent. Isolates whether JSON mode works at
// all on this model/account, with no image involved — to determine whether testJsonModeVision's
// failure is about JSON mode itself, or specifically about combining it with an image.
globalThis.testJsonModeTextOnly = async function testJsonModeTextOnly() {
  const messages = [
    {
      role: "user",
      content: 'Reply with a JSON object with exactly one key, "answer", whose value is the number 4. Reply with JSON only.',
    },
  ];

  try {
    const data = await callGroq("qwen/qwen3.6-27b", messages, {
      response_format: { type: "json_object" },
      reasoning_format: "hidden",
    });
    const content = data.choices && data.choices[0] && data.choices[0].message.content;
    console.log("[testJsonModeTextOnly] raw content:", content);
    console.log("[testJsonModeTextOnly] parsed:", JSON.parse(content));
  } catch (error) {
    console.error("[testJsonModeTextOnly] failed:", error.message);
    console.error("[testJsonModeTextOnly] error.data:", JSON.stringify(error.data, null, 2));
  }
};

// Diagnostic-only test hook, not part of the shipped agent. Isolates whether this model can
// process the annotated screenshot at all, with no JSON-mode requirement in the way.
globalThis.testVisionPlainText = async function testVisionPlainText() {
  const tab = await findMockTab();
  if (!tab) return;

  await attachSession(tab.id);
  let imageBase64;
  try {
    const candidates = await getAxCandidates(tab.id);
    ({ imageBase64 } = await captureAnnotatedScreenshot(tab.id, candidates));
  } finally {
    await detachSession(tab.id);
  }

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this screenshot in one plain sentence." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    },
  ];

  try {
    const data = await callGroq("qwen/qwen3.6-27b", messages, { reasoning_format: "hidden" });
    console.log("[testVisionPlainText] content:", data.choices[0].message.content);
  } catch (error) {
    console.error("[testVisionPlainText] failed:", error.message);
    console.error("[testVisionPlainText] error.data:", JSON.stringify(error.data, null, 2));
  }
};

// Diagnostic-only test hook, not part of the shipped agent. Removes max_tokens as a possible
// constraint entirely and logs the full usage breakdown, to get real evidence of how many tokens
// this model actually needs to reason about and describe this specific image — rather than
// continuing to guess at a ceiling.
globalThis.testVisionHighBudget = async function testVisionHighBudget() {
  const tab = await findMockTab();
  if (!tab) return;

  await attachSession(tab.id);
  let imageBase64;
  try {
    const candidates = await getAxCandidates(tab.id);
    ({ imageBase64 } = await captureAnnotatedScreenshot(tab.id, candidates));
  } finally {
    await detachSession(tab.id);
  }

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this screenshot in one plain sentence." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    },
  ];

  try {
    const data = await callGroq("qwen/qwen3.6-27b", messages, {
      reasoning_format: "hidden",
      max_tokens: 4000,
    });
    console.log("[testVisionHighBudget] content:", data.choices[0].message.content);
    console.log("[testVisionHighBudget] full usage:", JSON.stringify(data.usage, null, 2));
  } catch (error) {
    console.error("[testVisionHighBudget] failed:", error.message);
    console.error("[testVisionHighBudget] error.data:", JSON.stringify(error.data, null, 2));
  }
};

// Temporary manual test hook for running Orient in isolation, ahead of it being wired into a real
// "start run" trigger (Phase 6's top-level driver). Removed once that driver calls runOrient
// through real application code instead.
globalThis.testOrient = async function testOrient() {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testOrient] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    await runOrient(tab.id);
    console.log("[testOrient] completed without escalating — screen classified USABLE");
  } catch (error) {
    if (error instanceof OrientEscalatedError) {
      console.warn(`[testOrient] escalated: ${error.reason}`, error.details);
    } else {
      console.error("[testOrient] failed with an unexpected error:", error.message);
      if (error.data) {
        console.error(
          "[testOrient] full error.data (stringified):",
          JSON.stringify(error.data, null, 2)
        );
      }
    }
  } finally {
    await detachSession(tab.id);
    console.log(`[testOrient] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook for verifying locateElement.js in isolation, ahead of it being
// wired into CREATE VISIT. Removed once CREATE VISIT calls locateElement through real
// application code instead.
globalThis.testLocateElement = async function testLocateElement() {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testLocateElement] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const candidates = await getAxCandidates(tab.id);
    console.log(`[testLocateElement] found ${candidates.length} candidates on this screen`);

    const result = await locateElement(
      tab.id,
      candidates,
      "the control that lets a user create a new Visit in a study's visit schedule"
    );
    console.log("[testLocateElement] result:", result);
  } catch (error) {
    console.error("[testLocateElement] failed:", error.message);
    if (error.data) {
      console.error("[testLocateElement] full error.data:", JSON.stringify(error.data, null, 2));
    }
  } finally {
    await detachSession(tab.id);
    console.log(`[testLocateElement] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook for verifying gate.js in isolation, ahead of it being wired into
// CREATE VISIT. Sends a test approval request and waits for a real human click in the side
// panel. Removed once CREATE VISIT calls requestHumanApproval through real application code.
globalThis.testGate = async function testGate() {
  console.log("[testGate] sending a test request — open the side panel and click Approve or Reject");
  const approved = await requestHumanApproval(
    "Test action: approve or reject this to verify the gate mechanism.",
    { example_detail: 42 }
  );
  console.log(`[testGate] human responded: ${approved ? "approved" : "rejected"}`);
};

// Temporary manual test hook for running CREATE VISIT in isolation. Removed once Phase 6's
// top-level driver calls createVisit through real application code instead.
globalThis.testCreateVisit = async function testCreateVisit(visitSpec = {
  name: "Screening",
  windowStartDay: -28,
  windowEndDay: -1,
  irPath: "visit[Screening]",
}) {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testCreateVisit] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const result = await createVisit(tab.id, visitSpec);
    console.log("[testCreateVisit] result:", result);
  } catch (error) {
    if (error instanceof CreateVisitEscalatedError) {
      console.warn(`[testCreateVisit] escalated: ${error.reason}`, error.details);
    } else {
      console.error("[testCreateVisit] failed with an unexpected error:", error.message);
      if (error.data) {
        console.error("[testCreateVisit] full error.data:", JSON.stringify(error.data, null, 2));
      }
    }
  } finally {
    await detachSession(tab.id);
    console.log(`[testCreateVisit] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook — Stage 1 of CREATE FORM only, to observe what Mock A's actual
// "add a form" UI looks like before Stage 2 is designed. Removed/extended once Stage 2 exists.
globalThis.testCreateForm = async function testCreateForm(visitName = "Screening", formSpec = {
  name: "Demographics",
  repeating: false,
  irPath: "visit[Screening].form[Demographics]",
}) {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testCreateForm] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const result = await createForm(tab.id, visitName, formSpec);
    console.log("[testCreateForm] result:", result);
  } catch (error) {
    if (error instanceof CreateFormEscalatedError) {
      console.warn(`[testCreateForm] escalated: ${error.reason}`, error.details);
    } else {
      console.error("[testCreateForm] failed:", error.message);
      if (error.data) console.error("[testCreateForm] full error.data:", JSON.stringify(error.data, null, 2));
    }
  } finally {
    await detachSession(tab.id);
    console.log(`[testCreateForm] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook for running Phase 6.4's activateForm in isolation, on whatever form
// is currently sitting fully built in the mock — no full run needed. Assumes the tab is already
// on (or can freely navigate to) that form's own editor; ensureOnFormEditorOrEscalate's proxy
// check inside activateForm's caller normally handles this, but this isolated hook calls
// activateForm directly, so if the mock isn't already sitting on the target form's editor,
// navigate there by hand first (or use testCreateForm to get there).
globalThis.testActivateForm = async function testActivateForm(formName = "Demographics", irPath = "visit[Screening].form[Demographics]") {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testActivateForm] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const result = await activateForm(tab.id, formName, irPath);
    console.log("[testActivateForm] result:", result);
  } catch (error) {
    if (error instanceof CreateFormEscalatedError) {
      console.warn(`[testActivateForm] escalated: ${error.reason}`, error.details);
    } else {
      console.error("[testActivateForm] failed:", error.message);
      if (error.data) console.error("[testActivateForm] full error.data:", JSON.stringify(error.data, null, 2));
    }
  } finally {
    await detachSession(tab.id);
    console.log(`[testActivateForm] detached from tab ${tab.id}`);
  }
};

// Temporary manual test hook for running Phase 6.6's probeFormReuseOnce in isolation — mirrors
// exactly how driver.js's buildOneForm sequences it: navigate to the visit's documents list
// first (the probe itself does no navigation of its own, by design), then probe. Call this twice
// in a row with the SAME formName/formFields to observe the cache-hit path (second call should
// log "cache_hit" and issue no new locate/Groq call at all).
globalThis.testProbeFormReuse = async function testProbeFormReuse(
  visitName = "Screening",
  formName = "Demographics",
  formFields = [
    { label: "Subject Initials", type: "text" },
    { label: "Date of Birth", type: "date" },
  ],
  irPath = "visit[Screening].form[Demographics]"
) {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testProbeFormReuse] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    await navigateToVisitDocumentsOrEscalate(tab.id, visitName, irPath);
    const result = await probeFormReuseOnce(tab.id, formName, formFields, irPath);
    console.log("[testProbeFormReuse] result:", result);
  } catch (error) {
    if (error instanceof CreateFormEscalatedError) {
      console.warn(`[testProbeFormReuse] navigation escalated: ${error.reason}`, error.details);
    } else {
      console.error("[testProbeFormReuse] failed:", error.message);
      if (error.data) console.error("[testProbeFormReuse] full error.data:", JSON.stringify(error.data, null, 2));
    }
  } finally {
    await detachSession(tab.id);
    console.log(`[testProbeFormReuse] detached from tab ${tab.id}`);
  }
};

globalThis.testCreateFieldStage2 = async function testCreateFieldStage2() {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testCreateFieldStage2] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const result = await createFieldStage2(tab.id, "Demographics", {
      label: "Subject Initials",
      type: "text",
      irPath: "visit[Screening].form[Demographics].field[Subject Initials]",
    });
    console.log("[testCreateFieldStage2] result:", result);
  } catch (error) {
    if (error instanceof CreateFieldEscalatedError) {
      console.warn(`[testCreateFieldStage2] escalated: ${error.reason}`, error.details);
    } else {
      console.error("[testCreateFieldStage2] failed:", error.message);
      if (error.data) console.error("[testCreateFieldStage2] full error.data:", JSON.stringify(error.data, null, 2));
    }
  } finally {
    await detachSession(tab.id);
    console.log(`[testCreateFieldStage2] detached from tab ${tab.id}`);
  }
};

// Diagnostic-only, not part of the shipped agent. Reruns locateElement's exact Tier-2 vision
// call for the current screen, but with reasoning made VISIBLE and a much higher max_tokens
// ceiling, so the model's actual reasoning content and real token usage can be inspected directly
// — rather than continuing to guess at a max_tokens number after two failed attempts (1500, then
// 3000) produced identical empty-output failures, which is itself evidence the problem likely
// isn't a simple budget shortfall.
globalThis.diagnoseLocateFailure = async function diagnoseLocateFailure(intentDescription) {
  const tab = await findMockTab();
  if (!tab) return;

  await attachSession(tab.id);
  let imageBase64, candidates;
  try {
    candidates = await getAxCandidates(tab.id);
    ({ imageBase64 } = await captureAnnotatedScreenshot(tab.id, candidates));
  } finally {
    await detachSession(tab.id);
  }

  const manifest = candidates
    .map((c) => `#${c.markNumber}: role="${c.role}", label="${c.name || "(no label)"}"`)
    .join("\n");

  const promptText =
    "You are looking at a screenshot of a web application screen, with numbered red boxes " +
    "marking every interactive element currently visible.\n\n" +
    `Find the element that best matches this description: ${intentDescription}\n\n` +
    "Judge by what an element plausibly does (its role, its position, its icon, any visible " +
    "text), not by requiring an exact label match.\n\n" +
    `Marked elements on this screen:\n${manifest}\n\n` +
    'Reply with a JSON object with exactly these keys: "found", "mark_number", "confidence", "reasoning". Reply with JSON only.';

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    },
  ];

  try {
    const data = await callGroq("qwen/qwen3.6-27b", messages, {
      reasoning_format: "parsed", // visible, not hidden — we need to actually see it this time
      max_tokens: 6000,
    });
    console.log("[diagnose] full usage:", JSON.stringify(data.usage, null, 2));
    console.log("[diagnose] reasoning:", data.choices[0].message.reasoning);
    console.log("[diagnose] final content:", data.choices[0].message.content);
  } catch (error) {
    console.error("[diagnose] call failed:", error.message);
    console.error("[diagnose] full error.data:", JSON.stringify(error.data, null, 2));
  }
};


// Real Phase 6.1 entry point — the top-level driver. Reads the IR the side panel's upload
// control already validated and stored, then walks the entire hierarchy. Extracted into its own
// named function so both the console hook below and the side panel's Start Build button (see the
// message listener further down) call the exact same implementation, rather than there being two
// separate ways to start a run that could drift apart.
async function startFullBuild() {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[runFullBuild] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    return await driverRunFullBuild(tab.id);
  } catch (error) {
    console.error("[runFullBuild] run ended with an unhandled error:", error.message);
    if (error.data) console.error("[runFullBuild] full error.data:", JSON.stringify(error.data, null, 2));
    throw error;
  } finally {
    await detachSession(tab.id);
    console.log(`[runFullBuild] detached from tab ${tab.id}`);
  }
}
globalThis.runFullBuild = startFullBuild;

// Side-panel control buttons (Start Build, Stop Build, Clear Escalations, Reset Governor State).
// A one-off chrome.runtime.sendMessage per click is enough here — none of these need a
// persistent connection the way the human gate does, and the side panel's existing gate-panel
// port already keeps this service worker alive for as long as the panel stays open, which is
// what actually matters for a run that can take tens of minutes.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "driver:start") {
    (async () => {
      const { driverRunState } = await chrome.storage.local.get("driverRunState");
      if (driverRunState === "running") {
        console.warn("[background] Start Build ignored — a run is already in progress.");
        sendResponse({ started: false, reason: "a run is already in progress" });
        return;
      }
      // Deliberately not awaited: a full run can take tens of minutes, far longer than a
      // message-response round trip should ever be held open for. Progress is surfaced instead
      // through chrome.storage.local (driverRunState, the escalation log, the call counters, and
      // the Last Run Status section) exactly as it already was when a run was only startable
      // from this console.
      startFullBuild().catch((error) => {
        console.error("[background] run started from the side panel ended with an error:", error.message);
      });
      sendResponse({ started: true });
    })();
    return true; // Keep the message channel open for the async work above.
  }

  if (message.type === "driver:stop") {
    requestDriverStop();
    console.log("[background] Stop Build requested — the run will stop at its next loop boundary.");
    sendResponse({ stopping: true });
    return false;
  }

  if (message.type === "escalations:clear") {
    (async () => {
      await chrome.storage.local.set({ escalationLog: [] });
      console.log("[background] Escalation log cleared from the side panel.");
      sendResponse({ cleared: true });
    })();
    return true;
  }

  if (message.type === "governor:reset") {
    resetGovernorState(["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "qwen/qwen3.8-27b"]);
    console.log("[background] Governor state reset from the side panel.");
    sendResponse({ reset: true });
    return false;
  }

  if (message.type === "lastrun:clear") {
    (async () => {
      await chrome.storage.local.remove("lastRunSummary");
      console.log("[background] Last Run Status cleared from the side panel.");
      sendResponse({ cleared: true });
    })();
    return true;
  }

  return false;
});


// Temporary manual test hook for running CREATE FIELD in isolation against any single field
// spec, on any form. Defaults to the original "Subject Initials" / "Demographics" case when
// called with no arguments, so existing invocations (testCreateField()) are unaffected — pass a
// different fieldSpec and/or formName to build a field on any other form, e.g.
// testCreateField({ label: "Exclusionary Conditions", type: "multi_select", ... }, "Eligibility
// Criteria"). Removed once Phase 6's top-level driver calls createField through real application
// code, looping over every field in the IR instead of one at a time by hand.
globalThis.testCreateField = async function testCreateField(fieldSpec = {
  label: "Subject Initials",
  type: "text",
  required: true,
  irPath: "visit[Screening].form[Demographics].field[Subject Initials]",
}, formName = "Demographics") {
  const tab = await findMockTab();
  if (!tab) return;

  console.log(`[testCreateField] attaching to tab ${tab.id} (${tab.url})`);
  await attachSession(tab.id);

  try {
    const result = await createField(tab.id, formName, fieldSpec);
    console.log("[testCreateField] result:", result);
  } catch (error) {
    if (error instanceof CreateFieldEscalatedError) {
      console.warn(`[testCreateField] escalated: ${error.reason}`, error.details);
    } else {
      console.error("[testCreateField] failed:", error.message);
      if (error.data) console.error("[testCreateField] full error.data:", JSON.stringify(error.data, null, 2));
    }
  } finally {
    await detachSession(tab.id);
    console.log(`[testCreateField] detached from tab ${tab.id}`);
  }
};