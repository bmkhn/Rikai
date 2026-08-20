// Rikai popup script
// Communicates with the content script via chrome.tabs.sendMessage

const translateBtn = document.getElementById("translate-btn");
const toggleContainer = document.getElementById("toggle-container");
const toggleCheckbox = document.getElementById("toggle-checkbox");
const statusEl = document.getElementById("status");
const statusIcon = document.getElementById("status-icon");
const statusText = document.getElementById("status-text");

function setStatus(type, icon, text) {
  statusEl.hidden = false;
  statusEl.className = `status ${type}`;
  statusIcon.textContent = icon;
  statusText.textContent = text;
}

// ─── Translate Button ────────────────────────────────────────────────

translateBtn.addEventListener("click", async () => {
  translateBtn.disabled = true;
  toggleContainer.hidden = true;
  setStatus("loading", "⏳", "Sending command...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      setStatus("error", "❌", "No active tab found.");
      translateBtn.disabled = false;
      return;
    }

    // Get selected language
    const langRadio = document.querySelector('input[name="lang"]:checked');
    const lang = langRadio ? langRadio.value : "jpn";

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "translatePage",
      lang,
    });

    if (response && response.success) {
      setStatus("success", "✅", response.message || "Translation started!");
      // Show toggle slider after successful translation
      toggleContainer.hidden = false;
      toggleCheckbox.checked = true;
    } else {
      setStatus("error", "❌", response?.message || "Translation failed.");
    }
  } catch (err) {
    if (err.message?.includes("Receiving end does not exist")) {
      setStatus("error", "❌", "Cannot connect to page. Try refreshing.");
    } else {
      setStatus("error", "❌", `Error: ${err.message}`);
    }
  } finally {
    translateBtn.disabled = false;
  }
});

// ─── Toggle Slider ──────────────────────────────────────────────────

toggleCheckbox.addEventListener("change", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      setStatus("error", "❌", "No active tab found.");
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "toggleTranslation",
    });

    if (response && response.success) {
      setStatus("success", "✅", response.message);
    } else {
      setStatus("error", "❌", response?.message || "Toggle failed.");
    }
  } catch (err) {
    setStatus("error", "❌", `Error: ${err.message}`);
  }
});
