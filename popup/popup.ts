// Rikai popup — control panel.

const powerToggle = document.getElementById("power-toggle") as HTMLInputElement;
const statusCore = document.getElementById("status-core") as HTMLElement;
const statusMain = document.getElementById("status-main") as HTMLElement;
const ocrStateEl = document.getElementById("ocr-state") as HTMLElement;
const trStateEl = document.getElementById("tr-state") as HTMLElement;
const detailEl = document.getElementById("detail") as HTMLElement;
const retryBtn = document.getElementById("retry-btn") as HTMLElement;

let currentTabId: number | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPhase: string | null = null;

// ─── Init ──────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);

async function init(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/i.test(tab.url || "")) {
      render("UNSUPPORTED", "Open a normal web page to use Rikai.");
      return;
    }
    currentTabId = tab.id ?? null;

    const bgState = await chrome.runtime
      .sendMessage({ type: "RIKAI_GET_TAB_STATE" })
      .catch(() => ({ state: "OFF" }));

    powerToggle.checked = bgState.state !== "OFF";
    await refreshFromTab();
    startPolling();
  } catch (err: any) {
    render("UNSUPPORTED", String(err?.message || err));
  }
}

powerToggle.addEventListener("change", onToggle);
retryBtn.addEventListener("click", () => {
  hideError();
  sendToTab(currentTabId, { type: "RIKAI_ACTIVATE" });
});

async function onToggle(): Promise<void> {
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

function sendToTab(tabId: number | null, message: any): Promise<any> {
  if (typeof tabId !== "number") {
    return Promise.reject(new Error("no tab"));
  }
  return chrome.tabs.sendMessage(tabId, message);
}

// ─── State polling ─────────────────────────────────────────────────────

function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(refreshFromTab, 900);
  window.addEventListener("unload", stopPolling);
}

function stopPolling(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshFromTab(): Promise<void> {
  let response: any;
  try {
    response = await sendToTab(currentTabId, { type: "RIKAI_GET_STATUS" });
  } catch {
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

function syncToggle(phase: string): void {
  const shouldBeOn = phase !== "OFF" && phase !== "UNSUPPORTED";
  if (powerToggle.checked !== shouldBeOn) {
    powerToggle.checked = shouldBeOn;
  }
}

// ─── Rendering ─────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  OFF: "OFFLINE",
  LOADING: "INITIALIZING",
  READY: "ONLINE",
  PROCESSING: "TRANSLATING",
  ERROR: "ERROR",
  UNSUPPORTED: "UNAVAILABLE",
};

const TONES: Record<string, string> = {
  OFF: "off",
  LOADING: "loading",
  READY: "on",
  PROCESSING: "on",
  ERROR: "error",
  UNSUPPORTED: "error",
};

const OCR_LABELS: Record<string, [string, string]> = {
  OFF: ["—", ""],
  LOADING: ["LOADING", "warn"],
  READY: ["MangaOCR · READY", "ok"],
  PROCESSING: ["MangaOCR · ACTIVE", "ok"],
  ERROR: ["FAILED", "bad"],
  UNSUPPORTED: ["—", ""],
};

const TR_LABELS: Record<string, [string, string]> = {
  OFF: ["STANDBY", ""],
  LOADING: ["WAITING", "warn"],
  READY: ["READY", "ok"],
  PROCESSING: ["ACTIVE", "ok"],
  ERROR: ["HALTED", "bad"],
  UNSUPPORTED: ["—", ""],
};

function render(phase: string, detail: string | null): void {
  const label = PHASE_LABELS[phase] || phase.toUpperCase();
  statusCore.dataset.tone = TONES[phase] || "off";
  statusMain.textContent = label;

  const [ocrText, ocrTone] = OCR_LABELS[phase] || ["—", ""];
  ocrStateEl.textContent = ocrText;
  ocrStateEl.className = `row-value ${ocrTone}`.trim();

  const [trText, trTone] = TR_LABELS[phase] || ["—", ""];
  trStateEl.textContent = trText;
  trStateEl.className = `row-value ${trTone}`.trim();

  if (detail && (phase === "ERROR" || phase === "UNSUPPORTED")) {
    detailEl.hidden = false;
    detailEl.textContent = humanize(detail);
    retryBtn.hidden = phase !== "ERROR";
  } else {
    hideError();
  }

  lastPhase = phase;
}

function humanize(text: string): string {
  if (/Receiving end/i.test(text)) {
    return "Refresh the page, then switch Rikai ON.";
  }
  if (/model|onnx|huggingface/i.test(text)) {
    return "Could not load the Japanese OCR model. Check your connection.";
  }
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function showError(headline: string, detail: string): void {
  statusCore.dataset.tone = "error";
  statusMain.textContent = headline;
  detailEl.hidden = false;
  detailEl.textContent = detail;
  retryBtn.hidden = false;
  ocrStateEl.textContent = "FAILED";
  ocrStateEl.className = "row-value bad";
}

function hideError(): void {
  detailEl.hidden = true;
  retryBtn.hidden = true;
}
