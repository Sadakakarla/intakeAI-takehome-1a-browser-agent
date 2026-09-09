// Composites numbered Set-of-Mark boxes onto a screenshot, for the vision-model calls that need
// to reference a specific on-screen element by mark number rather than guessing coordinates
// (Orient's classification call, Decide's type-mapping call), and for the human Gate, which needs
// a screenshot too but benefits from a tight crop around the field under review rather than a
// full page shrunk down to a ~320px-wide side panel — at that scale a full-page image's marks
// are too small to read. Three entry points are exported: a low-level pure function for
// standalone testing against an already-captured image, a full-page annotated capture
// (Orient/Decide's own use, unchanged from before), and a cropped annotated capture (the human
// Gate's use, new).

import { sendCommand } from "./debugger-session.js";

// Decodes a base64 PNG string into an ImageBitmap. Using fetch() against a data: URL rather than
// manual atob() decoding, since fetch is available in the service worker and reliably handles the
// full decode-to-Blob step without hand-rolling binary parsing.
async function base64ToImageBitmap(base64) {
  const response = await fetch(`data:image/png;base64,${base64}`);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

// Converts a Blob to a base64 string via its ArrayBuffer. Deliberately chunks the
// byte-array-to-string conversion rather than doing it in one call
// (String.fromCharCode(...bytes)) — spreading a full screenshot's worth of bytes as function
// arguments in one call risks "Maximum call stack size exceeded" on real image sizes, a failure
// that would only surface against an actual screenshot, not a small test payload.
async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

// Draws one candidate's numbered mark: a stroked outline around its bounding box, plus a small
// filled tag showing its mark number. The tag is anchored just above the box's top-left corner
// when there's room, so it never covers the element's own label text. Falls back to the
// inside-corner placement only when the box sits too close to the top edge of the image for the
// tag to fit above it without being clipped off-screen entirely.
function drawMark(ctx, candidate, scaleX, scaleY) {
  const box = candidate.boundingBox;
  const x = box.x * scaleX;
  const y = box.y * scaleY;
  const width = box.width * scaleX;
  const height = box.height * scaleY;

  ctx.strokeStyle = "#ff3366";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, width, height);

  const label = String(candidate.markNumber);
  ctx.font = "bold 13px sans-serif";
  const textWidth = ctx.measureText(label).width;
  const tagWidth = textWidth + 8;
  const tagHeight = 16;

  const fitsAbove = y - tagHeight >= 0;
  const tagX = x;
  const tagY = fitsAbove ? y - tagHeight : y;

  ctx.fillStyle = "#ff3366";
  ctx.fillRect(tagX, tagY, tagWidth, tagHeight);

  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, tagX + 4, tagY + tagHeight / 2);
}

// Draws every candidate's mark onto an already-decoded bitmap and returns the result as a CANVAS
// (not yet encoded to a blob) — kept as a canvas, not a blob, specifically so the cropped entry
// point below can crop a sub-region out of it before ever paying for a PNG encode of the full
// page.
function drawOverlayOnCanvas(bitmap, candidates, scaleX, scaleY) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  for (const candidate of candidates) {
    drawMark(ctx, candidate, scaleX, scaleY);
  }

  return canvas;
}

// Pure-ish entry point: takes an already-captured screenshot and a candidate list, returns a new
// base64 PNG with every candidate's mark drawn on it. Exists separately from the CDP-driving
// entry points below so the drawing logic can be exercised by hand against a saved screenshot
// during testing, without needing a live tab for every check.
export async function drawSoMOverlay(screenshotBase64, candidates, scaleX, scaleY) {
  const bitmap = await base64ToImageBitmap(screenshotBase64);
  const canvas = drawOverlayOnCanvas(bitmap, candidates, scaleX, scaleY);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToBase64(blob);
}

// Shared internal step for both CDP-driving entry points below: captures a full-page screenshot,
// measures the real CSS-pixel-to-screenshot-pixel scale factor directly from the captured image
// (never trusted as an assumed device-pixel-ratio value — a HiDPI display would silently
// misplace every mark otherwise), draws every candidate's mark onto it, and returns the
// annotated canvas plus each candidate's bounding box already converted into that same
// document-relative, scaled pixel space — everything the cropped entry point needs to compute a
// crop region against the same canvas it's about to slice from.
async function captureAndAnnotate(tabId, candidates) {
  const [scrollOffsetResult, metrics] = await Promise.all([
    sendCommand(tabId, "Runtime.evaluate", {
      expression: "({x: window.scrollX, y: window.scrollY})",
      returnByValue: true,
    }),
    sendCommand(tabId, "Page.getLayoutMetrics"),
  ]);
  const scrollOffset = scrollOffsetResult.result.value;

  const contentSize = metrics.cssContentSize || metrics.contentSize;
  if (!contentSize || !contentSize.width || !contentSize.height) {
    throw new Error("captureAndAnnotate: Page.getLayoutMetrics did not return a usable content size");
  }

  const { data: screenshotBase64 } = await sendCommand(tabId, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 },
  });

  const bitmap = await base64ToImageBitmap(screenshotBase64);

  const scaleX = bitmap.width / contentSize.width;
  const scaleY = bitmap.height / contentSize.height;

  // Each candidate's boundingBox was captured by DOM.getBoxModel in viewport-relative CSS
  // pixels. Converted here into document-relative, screenshot-pixel-space coordinates in one
  // step (scroll offset added, then scaled) — the same arithmetic the original single-entry-
  // point version of this file did inside drawMark itself; done here instead so the result is
  // reusable for crop-region math, not just for drawing.
  const documentRelativeCandidates = candidates.map((c) => ({
    ...c,
    boundingBox: {
      x: (c.boundingBox.x + scrollOffset.x) * scaleX,
      y: (c.boundingBox.y + scrollOffset.y) * scaleY,
      width: c.boundingBox.width * scaleX,
      height: c.boundingBox.height * scaleY,
    },
  }));

  // scaleX/scaleY passed as 1 here since documentRelativeCandidates' boxes are already in final
  // canvas-pixel space — scaling was already applied above, not deferred to drawMark this time.
  const canvas = drawOverlayOnCanvas(bitmap, documentRelativeCandidates, 1, 1);

  return { canvas, documentRelativeCandidates, imageWidth: bitmap.width, imageHeight: bitmap.height };
}

// High-level entry point, matching the tabId-in convention already used by
// getAxCandidates/getFallbackCandidates. Captures a full-page screenshot — not just the current
// viewport — and returns a ready-to-send, fully-annotated image. Used by Orient's and Decide's
// vision calls, which need to see every candidate on the whole page, not a cropped subset.
//
// Full-page, not viewport-only: a candidate below the fold is still correctly found by LOCATE
// (the accessibility tree includes it regardless of scroll position), but a viewport-only
// screenshot never showed it to the model at all — forcing positional guesswork on any screen
// taller than one viewport. This was a real, live incident, not a hypothetical risk, on a
// documents table with more rows than fit on screen.
export async function captureAnnotatedScreenshot(tabId, candidates) {
  const { canvas } = await captureAndAnnotate(tabId, candidates);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const imageBase64 = await blobToBase64(blob);
  return { imageBase64 };
}

// Human-Gate entry point: same full-page capture and annotation as captureAnnotatedScreenshot
// above, but returns a CROP around a specific subset of candidates instead of the whole page.
// Exists because a full-page screenshot, shrunk to fit a narrow side panel, renders its SoM
// marks too small to actually read, and shows irrelevant chrome (nav bar, breadcrumbs, other
// panels) the reviewer doesn't need — the reviewer needs a tight, legible view of the one field
// under review.
//
// `allCandidates` is drawn on in full (so the crop can still show nearby context with its own
// marks, if the crop region happens to include any), but the crop REGION itself is computed only
// from `highlightCandidates` — normally the handful of elements this specific field just added —
// expanded by `paddingPx` on every side and clamped to the real image bounds, so a
// near-the-edge field never produces an out-of-bounds crop request.
export async function captureCroppedAnnotatedScreenshot(tabId, allCandidates, highlightCandidates, paddingPx = 160) {
  const { canvas, documentRelativeCandidates, imageWidth, imageHeight } = await captureAndAnnotate(
    tabId,
    allCandidates
  );

  const highlightMarks = new Set(highlightCandidates.map((c) => c.markNumber));
  const relevant = documentRelativeCandidates.filter((c) => highlightMarks.has(c.markNumber));

  // No real elements to crop around (e.g. a field whose Stage-3 build somehow added nothing
  // findable) — fall back to the full page rather than producing a crop with nothing meaningful
  // in it. Disclosed via the returned `cropped: false` flag rather than silently pretending this
  // is a normal crop.
  if (relevant.length === 0) {
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { imageBase64: await blobToBase64(blob), cropped: false };
  }

  const minX = Math.max(0, Math.min(...relevant.map((c) => c.boundingBox.x)) - paddingPx);
  const minY = Math.max(0, Math.min(...relevant.map((c) => c.boundingBox.y)) - paddingPx);
  const maxX = Math.min(imageWidth, Math.max(...relevant.map((c) => c.boundingBox.x + c.boundingBox.width)) + paddingPx);
  const maxY = Math.min(imageHeight, Math.max(...relevant.map((c) => c.boundingBox.y + c.boundingBox.height)) + paddingPx);

  const cropWidth = maxX - minX;
  const cropHeight = maxY - minY;

  const cropCanvas = new OffscreenCanvas(cropWidth, cropHeight);
  cropCanvas.getContext("2d").drawImage(canvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  const blob = await cropCanvas.convertToBlob({ type: "image/png" });
  return { imageBase64: await blobToBase64(blob), cropped: true };
}