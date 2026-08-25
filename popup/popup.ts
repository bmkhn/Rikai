// Rikai popup — control panel.

const powerToggle = document.getElementById("power-toggle") as HTMLInputElement;
const statusCore = document.getElementById("status-core") as HTMLElement;
const statusMain = document.getElementById("status-main") as HTMLElement;
const ocrStateEl = document.getElementById("ocr-state") as HTMLElement;
const trStateEl = document.getElementById("tr-state") as HTMLElement;
const detailEl = document.getElementById("detail") as HTMLElement;
const retryBtn = document.getElementById("retry-btn") as HTMLElement;

// Model management elements
const modelIcon = document.getElementById("model-icon") as HTMLElement;
const modelLabel = document.getElementById("model-label") as HTMLElement;
const modelProgress = document.getElementById("model-progress") as HTMLElement;
const modelBarFill = document.getElementById("model-bar-fill") as HTMLElement;
const modelProgressText = document.getElementById("model-progress-text") as HTMLElement;
const downloadBtn = document.getElementById("download-btn") as HTMLElement;
const deleteBtn = document.getElementById("delete-btn") as HTMLElement;
const repairBtn = document.getElementById("repair-btn") as HTMLElement;

let currentTabId: number | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let progressPollTimer: ReturnType<typeof setInterval> | null = null;
let lastPhase: string | null = null;
let modelReady = false;
let downloading = false;

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

    // Check model status + download progress
    const [modelStatus, progressResult] = await Promise.all([
      chrome.runtime
        .sendMessage({ type: "RIKAI_CHECK_MODEL_STATUS" })
        .catch(() => ({ ready: false })),
      chrome.storage.local.get("rikaiDownloadProgress") as Promise<Record<string, any>>,
    ]);
    modelReady = !!modelStatus.ready;

    // Handle download progress state from storage
    const progress = progressResult.rikaiDownloadProgress;
    if (progress) {
      if (progress.phase === "done" || progress.phase === "error") {
        // Download completed or failed while popup was closed — clear stale state
        chrome.storage.local.remove("rikaiDownloadProgress").catch(() => {});
        if (progress.phase === "done") modelReady = true;
      } else if (progress.active && !modelReady) {
        // Download was in progress — show progress UI and resume polling
        downloading = true;
        downloadBtn.setAttribute("hidden", "");
        deleteBtn.setAttribute("hidden", "");
        modelProgress.hidden = false;
        modelBarFill.classList.remove("indeterminate");
        modelBarFill.style.width = `${Math.max(0, Math.min(100, progress.percent || 0))}%`;
        modelProgressText.textContent = progress.detail || `${progress.percent || 0}%`;
        modelLabel.textContent = "DOWNLOADING";
        modelLabel.className = "model-label downloading";
        modelIcon.textContent = "↓";
        startProgressPolling();
      }
    }

    updateModelUI();

    // Check tab state
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

downloadBtn.addEventListener("click", onDownload);
deleteBtn.addEventListener("click", onDelete);
repairBtn.addEventListener("click", onRepair);

async function onToggle(): Promise<void> {
  if (!modelReady) {
    powerToggle.checked = false;
    return;
  }

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

async function onDownload(): Promise<void> {
  if (downloading) return;
  downloading = true;

  downloadBtn.setAttribute("hidden", "");
  deleteBtn.setAttribute("hidden", "");
  modelProgress.hidden = false;
  modelBarFill.style.width = "";
  modelBarFill.classList.add("indeterminate");
  modelLabel.textContent = "DOWNLOADING";
  modelLabel.className = "model-label downloading";
  modelIcon.textContent = "↓";
  modelProgressText.textContent = "Starting…";

  // Persist download state so it survives popup close
  chrome.storage.local
    .set({ rikaiDownloadProgress: { active: true, phase: "download", percent: 0, detail: "Starting…" } })
    .catch(() => {});

  // Start polling progress from storage
  startProgressPolling();

  try {
    const response = await chrome.runtime.sendMessage({ type: "RIKAI_DOWNLOAD_MODEL" });
    if (!response?.ok) {
      throw new Error(response?.error || "Download failed");
    }
    modelReady = true;
  } catch (err: any) {
    showError("Download failed", err?.message || "Check your connection.");
    modelReady = false;
  } finally {
    downloading = false;
    stopProgressPolling();
    updateModelUI();
  }
}

async function onDelete(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "RIKAI_DELETE_MODEL" });
    modelReady = false;
    powerToggle.checked = false;
    updateModelUI();
  } catch (err: any) {
    showError("Delete failed", err?.message || "Unknown error.");
  }
}

async function onRepair(): Promise<void> {
  if (downloading) return;

  try {
    // Step 1: Delete everything
    await chrome.runtime.sendMessage({ type: "RIKAI_DELETE_MODEL" });
    modelReady = false;
    updateModelUI();

    // Step 2: Re-download
    await onDownload();
  } catch (err: any) {
    showError("Repair failed", err?.message || "Unknown error.");
    updateModelUI();
  }
}

function updateModelUI(): void {
  if (downloading) {
    // Already showing progress, don't overwrite
    return;
  }

  if (modelReady) {
    modelIcon.textContent = "✓";
    modelLabel.textContent = "MODEL READY";
    modelLabel.className = "model-label ready";
    modelProgress.hidden = true;
    downloadBtn.removeAttribute("hidden");
    downloadBtn.textContent = "RE-DOWNLOAD";
    deleteBtn.removeAttribute("hidden");
    // Clear stale progress from previous session
    chrome.storage.local.remove("rikaiDownloadProgress").catch(() => {});
    repairBtn.setAttribute("hidden", "");
    powerToggle.disabled = false;
  } else {
    modelIcon.textContent = "—";
    modelLabel.textContent = "MODEL NOT DOWNLOADED";
    modelLabel.className = "model-label";
    modelProgress.hidden = true;
    downloadBtn.removeAttribute("hidden");
    downloadBtn.textContent = "DOWNLOAD";
    deleteBtn.setAttribute("hidden", "");
    repairBtn.removeAttribute("hidden");
    powerToggle.disabled = true;
    powerToggle.checked = false;
  }
}

// ─── Progress polling ──────────────────────────────────────────────────

function startProgressPolling(): void {
  stopProgressPolling();
  progressPollTimer = setInterval(pollDownloadProgress, 500);
}

function stopProgressPolling(): void {
  if (progressPollTimer != null) {
    clearInterval(progressPollTimer);
    progressPollTimer = null;
  }
}

async function pollDownloadProgress(): Promise<void> {
  try {
    const result: Record<string, any> = await chrome.storage.local.get("rikaiDownloadProgress");
    const progress = result.rikaiDownloadProgress as { active: boolean; phase: string; percent: number; detail: string } | undefined;
    if (!progress) return;

    if (progress.active) {
      modelBarFill.classList.remove("indeterminate");
      modelBarFill.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`;
      modelProgressText.textContent = progress.detail || `${progress.percent}%`;
    } else if (progress.phase === "done") {
      modelBarFill.style.width = "100%";
      modelProgressText.textContent = "Complete";
    } else if (progress.phase === "error") {
      modelBarFill.classList.remove("indeterminate");
      modelBarFill.style.width = "0%";
      modelProgressText.textContent = `Failed: ${progress.detail || "unknown error"}`;
    }
  } catch {
    // Storage access failed, ignore
  }
}

// ─── Messaging ─────────────────────────────────────────────────────────

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
  if (!modelReady) return;
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
