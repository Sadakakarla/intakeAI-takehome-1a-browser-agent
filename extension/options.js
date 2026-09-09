// Intake AI eSource Build Agent — Options page

const keyInput = document.getElementById("groqKey");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

function showStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "saved";
}

// Round-trip read-back: populate the field with whatever is already stored.
chrome.storage.local.get(["groqApiKey"], (result) => {
  if (chrome.runtime.lastError) {
    showStatus("Could not read stored key: " + chrome.runtime.lastError.message, true);
    return;
  }
  if (result.groqApiKey) {
    keyInput.value = result.groqApiKey;
    showStatus("Loaded previously saved key.", false);
  }
});

saveBtn.addEventListener("click", () => {
  const value = keyInput.value.trim();
  if (!value) {
    showStatus("Enter a key before saving.", true);
    return;
  }
  chrome.storage.local.set({ groqApiKey: value }, () => {
    if (chrome.runtime.lastError) {
      showStatus("Save failed: " + chrome.runtime.lastError.message, true);
      return;
    }
    // Genuine read-back, not just an assumption that set() succeeded.
    chrome.storage.local.get(["groqApiKey"], (result) => {
      if (result.groqApiKey === value) {
        showStatus("Key saved and verified.", false);
      } else {
        showStatus("Save appeared to succeed but read-back did not match.", true);
      }
    });
  });
});