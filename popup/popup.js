// Rikai popup script
// Communicates with the content script via chrome.tabs.sendMessage

const translateBtn = document.getElementById("translate-btn");
const statusEl = document.getElementById("status");
const statusIcon = document.getElementById("status-icon");
const statusText = document.getElementById("status-text");

function setStatus(type, icon, text) {
  statusEl.hidden = false;
  statusEl.className = `status ${type}`;
  statusIcon.textContent = icon;
  statusText.textContent = text;
}

translateBtn.addEventListener("click", async () => {
  translateBtn.disabled = true;
  setStatus("loading", "⏳", "Sending command...");

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      setStatus("error", "❌", "No active tab found.");
      translateBtn.disabled = false;
      return;
    }

    // Send message to the content script
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "translatePage",
    });

    if (response && response.success) {
      setStatus("success", "✅", response.message || "Translation started!");
    } else {
      setStatus("error", "❌", response?.message || "Translation failed.");
    }
  } catch (err) {
    // Content script may not be loaded on this page
    if (err.message?.includes("Receiving end does not exist")) {
      setStatus(
        "error",
        "❌",
        "Cannot connect to page. Try refreshing."
      );
    } else {
      setStatus("error", "❌", `Error: ${err.message}`);
    }
  } finally {
    translateBtn.disabled = false;
  }
});
