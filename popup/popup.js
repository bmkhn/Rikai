// Rikai popup — control panel.
// Sends ACTIVATE/DEACTIVATE to the content script of the active tab and
// mirrors real state. Closing this popup never stops the translator; the
// content script owns the engine.

const powerToggle = document.getElementById("power-toggle");
const statusCore = document.getElementById("status-core");
const statusMain = document.getElementById("status-main");
const ocrStateEl = document.getElementById("ocr-state");
const trStateEl = document.getElementById("tr-state");
const detailEl = document.getElementById("detail");
const retryBtn = document.getElementById("retry-btn");

let currentTabId = null;
let pollTimer = null;
let lastPhase = null;

// ─── Init ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/i.test(tab.url || "")) {
      render("UNSUPPORTED", "Open a normal web page to use Rikai.");
      return;
    }
    currentTabId = tab.id;

    const bgState = await chrome.runtime
      .sendMessage({ type: "RIKAI_GET_TAB_STATE" })
      .catch(() => ({ state: "OFF" }));

    powerToggle.checked = bgState.state !== "OFF";
    await refreshFromTab();
    startPolling();
  } catch (err) {
    render("UNSUPPORTED", String(err?.message || err));
  }
}

powerToggle.addEventListener("change", onToggle);
retryBtn.addEventListener("click", () => {
  hideError();
  sendToTab(currentTabId, { type: "RIKAI_ACTIVATE" });
});

async function onToggle() {
  const turnOn = powerToggle.checked;
  const type = turnOn ? "RIKAI_ACTIVATE" : "RIKAI_DEACTIVATE";

  if (turnOn) {
    render("LOADING", null);
  }

  try {
    await sendToTab(currentTabId, { type });
  } catch (err) {
    powerToggle.checked = false;
    showError(
      "Cannot reach this page.",
      "The page may need a refresh, or Rikai is not allowed here."
    );
  }
  refreshFromTab();
}

function sendToTab(tabId, message) {
  if (typeof tabId !== "number") {
    return Promise.reject(new Error("no tab"));
  }
  return chrome.tabs.sendMessage(tabId, message);
}

// ─── State polling ─────────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refreshFromTab, 900);
  window.addEventListener("unload", stopPolling);
}

function stopPolling() {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshFromTab() {
  let response;
  try {
    response = await sendToTab(currentTabId, { type: "RIKAI_GET_STATUS" });
  } catch {
    // No content script receiver → nothing running here
    if (!powerToggle.checked) {
      render("OFF", null);
    }
    return;
  }
  if (response?.state) {
    syncToggle(response.state);
    render(response.state, response.detail || null);
  }
}

function syncToggle(phase) {
  const shouldBeOn = phase !== "OFF" && phase !== "UNSUPPORTED";
  if (powerToggle.checked !== shouldBeOn) {
    powerToggle.checked = shouldBeOn;
  }
}

// ─── Rendering ─────────────────────────────────────────────────────────

const PHASE_LABELS = {
  OFF: "OFFLINE",
  LOADING: "INITIALIZING",
  READY: "ONLINE",
  PROCESSING: "TRANSLATING",
  ERROR: "ERROR",
  UNSUPPORTED: "UNAVAILABLE",
};

const TONES = {
  OFF: "off",
  LOADING: "loading",
  READY: "on",
  PROCESSING: "on",
  ERROR: "error",
  UNSUPPORTED: "error",
};

const OCR_LABELS = {
  OFF: ["—", ""],
  LOADING: ["LOADING", "warn"],
  READY: ["MangaOCR · READY", "ok"],
  PROCESSING: ["MangaOCR · ACTIVE", "ok"],
  ERROR: ["FAILED", "bad"],
  UNSUPPORTED: ["—", ""],
};

const TR_LABELS = {
  OFF: ["STANDBY", ""],
  LOADING: ["WAITING", "warn"],
  READY: ["READY", "ok"],
  PROCESSING: ["ACTIVE", "ok"],
  ERROR: ["HALTED", "bad"],
  UNSUPPORTED: ["—", ""],
};

function render(phase, detail) {
  const label = PHASE_LABELS[phase] || phase.toUpperCase();
  statusCore.dataset.tone = TONES[phase] || "off";
  statusMain.textContent = label;

  const [ocrText, ocrTone] = OCR_LABELS[phase] || ["—", ""];
  ocrStateEl.textContent = ocrText;
  ocrStateEl.className = `row-value ${ocrTone}`.trim();

  const [trText, trTone] = TR_LABELS[phase] || ["—", ""];
  trStateEl.textContent = trText;
  trStateEl.className = `row-value ${trTone}`.trim();

  // Show detail text only when it adds information
  if (detail && (phase === "ERROR" || phase === "UNSUPPORTED")) {
    detailEl.hidden = false;
    detailEl.textContent = humanize(detail);
    retryBtn.hidden = phase !== "ERROR";
  } else {
    hideError();
  }

  lastPhase = phase;
}

function humanize(text) {
  // Keep console for stack traces; show a short friendly line in the popup.
  if (/Receiving end/i.test(text)) {
    return "Refresh the page, then switch Rikai ON.";
  }
  if (/model|onnx|huggingface/i.test(text)) {
    return "Could not load the Japanese OCR model. Check your connection.";
  }
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function showError(headline, detail) {
  statusCore.dataset.tone = "error";
  statusMain.textContent = headline;
  detailEl.hidden = false;
  detailEl.textContent = detail;
  retryBtn.hidden = false;
  ocrStateEl.textContent = "FAILED";
  ocrStateEl.className = "row-value bad";
}

function hideError() {
  detailEl.hidden = true;
  retryBtn.hidden = true;
}
