// Captures a screenshot of the ENTIRE scrollable page — not just whatever's currently visible in
// the viewport — for the plain (non-annotated) vision-fallback calls used by
// confirmFormEditorScreen.js, confirmSourceDocumentsScreen.js, confirmVisitScheduleScreen.js, and
// confirmVisible.js. A viewport-only screenshot can silently omit the exact evidence one of these
// yes/no questions depends on (e.g. an "add new" affordance sitting below the fold on a long
// table), producing a wrong verdict for a reason invisible to anyone reviewing the trace
// afterward — the model isn't wrong, it just was never shown the relevant part of the page.
//
// Kept separate from som-overlay.js's captureAnnotatedScreenshot, which additionally has to
// convert each candidate's bounding box to document-relative coordinates to draw marks correctly
// on a full-page image — these four callers never draw marks, so they only need the plain image.

import { sendCommand } from "./debugger-session.js";

export async function captureFullPageScreenshot(tabId) {
  const metrics = await sendCommand(tabId, "Page.getLayoutMetrics");
  const contentSize = metrics.cssContentSize || metrics.contentSize;

  if (!contentSize || !contentSize.width || !contentSize.height) {
    // Genuinely unexpected — fall back to an ordinary viewport screenshot rather than failing the
    // whole call outright. Degraded evidence (the old behavior) is still better than none.
    const { data } = await sendCommand(tabId, "Page.captureScreenshot", { format: "png" });
    return { imageBase64: data };
  }

  const { data } = await sendCommand(tabId, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 },
  });
  return { imageBase64: data };
}