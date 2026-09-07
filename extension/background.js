// Intake AI eSource Build Agent — background service worker

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Intake AI Agent] agent loaded");
});

// Clicking the toolbar icon opens the side panel directly (no popup step)
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[Intake AI Agent] setPanelBehavior failed:", error));