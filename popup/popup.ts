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
const downloadAllBtn = document.getElementById("download-all-btn") as HTMLElement;
const cancelBtn = document.getElementById("cancel-btn") as HTMLElement;
const deleteBtn = document.getElementById("delete-btn") as HTMLElement;
const repairBtn = document.getElementById("repair-btn") as HTMLElement;

// Per-file elements
type FileType = "encoder" | "decoder" | "tokenizer";

interface FileDef {
  key: FileType;
  statusEl: HTMLElement;
  downloadBtn: HTMLElement;
  locateBtn: HTMLElement;
  fileInput: HTMLInputElement;
}

const FILES: FileDef[] = [
  {
    key: "encoder",
    statusEl: document.getElementById("encoder-status")!,
    downloadBtn: document.getElementById("encoder-download")!,
    locateBtn: document.getElementById("encoder-locate")!,
    fileInput: document.getElementById("encoder-file") as HTMLInputElement,
  },
  {
    key: "decoder",
    statusEl: document.getElementById("decoder-status")!,
    downloadBtn: document.getElementById("decoder-download")!,
    locateBtn: document.getElementById("decoder-locate")!,
    fileInput: document.getElementById("decoder-file") as HTMLInputElement,
  },
  {
    key: "tokenizer",
    statusEl: document.getElementById("tokenizer-status")!,
    downloadBtn: document.getElementById("tokenizer-download")!,
    locateBtn: document.getElementById("tokenizer-locate")!,
    fileInput: document.getElementById("tokenizer-file") as HTMLInputElement,
  },
];

interface FileProgress {
  name: string;
  sizeMB: number;
  phase: "pending" | "downloading" | "loading" | "done" | "error";
  percent: number;
}

let currentTabId: number | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let progressPollTimer: ReturnType<typeof setInterval> | null = null;
let lastPhase: string | null = null;
let modelReady = false;
let downloading = false;

// Track per-file status from storage
let fileStatuses: Record<FileType, string> = {
  encoder: "pending",
  decoder: "pending",
  tokenizer: "pending",
};

// ─── Confirm modal ───────────────────────────────────────────────────

function showConfirm(): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    if (!modal) {
      resolve(true);
      return;
    }
    modal.hidden = false;
    function handler(e: Event) {
      const target = e.target as HTMLElement;
      if (target.id === "confirm-ok") {
        modal!.hidden = true;
        modal!.removeEventListener("click", handler);
        resolve(true);
      } else if (target.id === "confirm-cancel") {
        modal!.hidden = true;
        modal!.removeEventListener("click", handler);
        resolve(false);
      }
    }
    modal.addEventListener("click", handler);
  });
}

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

    // Check model status
    const modelStatus = await chrome.runtime
      .sendMessage({ type: "RIKAI_CHECK_MODEL_STATUS" })
      .catch(() => ({ ready: false, files: {} }));
    modelReady = !!modelStatus.ready;

    // Update per-file statuses from storage
    if (modelStatus.files) {
      fileStatuses = { ...fileStatuses, ...modelStatus.files };
    }

    // Clear any stale download progress
    chrome.storage.local.remove("rikaiDownloadProgress").catch(() => {});

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

// ─── Event listeners ─────────────────────────────────────────────────

powerToggle.addEventListener("change", onToggle);
retryBtn.addEventListener("click", () => {
  hideError();
  sendToTab(currentTabId, { type: "RIKAI_ACTIVATE" });
});

downloadAllBtn.addEventListener("click", onDownloadAll);
cancelBtn.addEventListener("click", onCancel);
deleteBtn.addEventListener("click", onDelete);
repairBtn.addEventListener("click", onRepair);

// Per-file button listeners
for (const f of FILES) {
  f.downloadBtn.addEventListener("click", () => onDownloadFile(f.key));
  f.locateBtn.addEventListener("click", () => f.fileInput.click());
  f.fileInput.addEventListener("change", () => onLocateFile(f));
}

// ─── Toggle ───────────────────────────────────────────────────────────

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

// ─── Per-file download ───────────────────────────────────────────────

async function onDownloadFile(fileKey: FileType): Promise<void> {
  if (downloading) return;

  const confirmed = await showConfirm();
  if (!confirmed) return;

  downloading = true;
  downloadAllBtn.setAttribute("hidden", "");
  deleteBtn.setAttribute("hidden", "");
  cancelBtn.removeAttribute("hidden");

  setFileStatus(fileKey, "downloading", "0%");
  updateToggleState();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "RIKAI_DOWNLOAD_FILE",
      fileKey,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Download failed");
    }
    setFileStatus(fileKey, "done", "✓");
  } catch (err: any) {
    setFileStatus(fileKey, "error", "Failed");
  } finally {
    downloading = false;
    cancelBtn.setAttribute("hidden", "");
    updateModelUI();
  }
}

async function onDownloadAll(): Promise<void> {
  if (downloading) return;

  const confirmed = await showConfirm();
  if (!confirmed) return;

  downloading = true;
  downloadAllBtn.setAttribute("hidden", "");
  deleteBtn.setAttribute("hidden", "");
  cancelBtn.removeAttribute("hidden");

  for (const f of FILES) {
    if (fileStatuses[f.key] !== "done") {
      setFileStatus(f.key, "downloading", "0%");
    }
  }
  updateToggleState();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "RIKAI_DOWNLOAD_MODEL",
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Download failed");
    }
    modelReady = true;
    for (const f of FILES) {
      setFileStatus(f.key, "done", "✓");
    }
  } catch (err: any) {
    showError("Download failed", err?.message || "Check your connection.");
    modelReady = false;
  } finally {
    downloading = false;
    stopProgressPolling();
    cancelBtn.setAttribute("hidden", "");
    updateModelUI();
  }
}

// ─── Locate (file picker) ───────────────────────────────────────────

async function onLocateFile(f: FileDef): Promise<void> {
  const file = f.fileInput.files?.[0];
  if (!file) return;

  setFileStatus(f.key, "loading", "Loading…");

  try {
    const arrayBuffer = await file.arrayBuffer();
    const response = await chrome.runtime.sendMessage({
      type: "RIKAI_STORE_FILE",
      fileKey: f.key,
      fileName: file.name,
      data: Array.from(new Uint8Array(arrayBuffer)),
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to store file");
    }
    setFileStatus(f.key, "done", "✓");
  } catch (err: any) {
    setFileStatus(f.key, "error", "Failed");
  } finally {
    f.fileInput.value = "";
    updateModelUI();
  }
}

// ─── Cancel / Delete / Repair ───────────────────────────────────────

async function onCancel(): Promise<void> {
  if (!downloading) return;
  try {
    await chrome.runtime.sendMessage({ type: "RIKAI_CANCEL_DOWNLOAD" });
  } catch {
    // Best effort
  }
  downloading = false;
  stopProgressPolling();
  chrome.storage.local.remove("rikaiDownloadProgress").catch(() => {});
  updateModelUI();
}

async function onDelete(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "RIKAI_DELETE_MODEL" });
    modelReady = false;
    powerToggle.checked = false;
    for (const f of FILES) {
      setFileStatus(f.key, "pending", "—");
    }
    updateModelUI();
  } catch (err: any) {
    showError("Delete failed", err?.message || "Unknown error.");
  }
}

async function onRepair(): Promise<void> {
  if (downloading) return;
  try {
    await chrome.runtime.sendMessage({ type: "RIKAI_DELETE_MODEL" });
    modelReady = false;
    for (const f of FILES) {
      setFileStatus(f.key, "pending", "—");
    }
    updateModelUI();
    await onDownloadAll();
  } catch (err: any) {
    showError("Repair failed", err?.message || "Unknown error.");
    updateModelUI();
  }
}

// ─── File status helpers ────────────────────────────────────────────

function setFileStatus(
  fileKey: FileType,
  phase: string,
  text: string
): void {
  fileStatuses[fileKey] = phase;
  const f = FILES.find((x) => x.key === fileKey);
  if (!f) return;
  f.statusEl.textContent = text;
  f.statusEl.className = `file-status ${phase}`;

  // Update download button appearance
  f.downloadBtn.classList.remove("active", "done");
  if (phase === "downloading") {
    f.downloadBtn.classList.add("active");
    f.downloadBtn.setAttribute("disabled", "");
  } else if (phase === "done") {
    f.downloadBtn.classList.add("done");
    f.downloadBtn.removeAttribute("disabled");
  } else if (phase === "loading") {
    f.downloadBtn.setAttribute("disabled", "");
  } else {
    f.downloadBtn.removeAttribute("disabled");
  }

  updateToggleState();
}

function updateToggleState(): void {
  const allDone = Object.values(fileStatuses).every((s) => s === "done");
  const anyActive = Object.values(fileStatuses).some(
    (s) => s === "downloading" || s === "loading"
  );

  if (!allDone || anyActive) {
    powerToggle.disabled = true;
    powerToggle.checked = false;
  } else {
    powerToggle.disabled = false;
  }
}

function updateModelUI(): void {
  if (downloading) return;

  const allDone = Object.values(fileStatuses).every((s) => s === "done");
  const anyActive = Object.values(fileStatuses).some(
    (s) => s === "downloading" || s === "loading"
  );

  if (allDone) {
    modelIcon.textContent = "✓";
    modelLabel.textContent = "ALL FILES LOADED";
    modelLabel.className = "model-label ready";
    downloadAllBtn.setAttribute("hidden", "");
    deleteBtn.removeAttribute("hidden");
    cancelBtn.setAttribute("hidden", "");
    repairBtn.setAttribute("hidden", "");
    powerToggle.disabled = false;
  } else if (anyActive) {
    // Don't overwrite active states
    return;
  } else {
    modelIcon.textContent = "—";
    modelLabel.textContent = "MODEL NOT DOWNLOADED";
    modelLabel.className = "model-label";
    downloadAllBtn.removeAttribute("hidden");
    downloadAllBtn.textContent = "DOWNLOAD ALL";
    deleteBtn.setAttribute("hidden", "");
    cancelBtn.setAttribute("hidden", "");
    repairBtn.removeAttribute("hidden");
    powerToggle.disabled = true;
    powerToggle.checked = false;
  }

  updateToggleState();
}

// ─── Progress polling ──────────────────────────────────────────────

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
    const progress = result.rikaiDownloadProgress as {
      active: boolean;
      phase: string;
      files?: FileProgress[];
    } | undefined;
    if (!progress) return;

    if (progress.files) {
      for (const fp of progress.files) {
        const key = fp.name.includes("encoder")
          ? "encoder"
          : fp.name.includes("decoder")
          ? "decoder"
          : "tokenizer";
        if (fp.phase === "done") {
          setFileStatus(key, "done", "✓");
        } else if (fp.phase === "downloading") {
          setFileStatus(key, "downloading", `${fp.percent}%`);
        } else if (fp.phase === "loading") {
          setFileStatus(key, "loading", "Loading…");
        }
      }
    }

    if (progress.phase === "done") {
      modelReady = true;
      downloading = false;
      stopProgressPolling();
      for (const f of FILES) setFileStatus(f.key, "done", "✓");
      updateModelUI();
    }
  } catch {
    // Storage access failed
  }
}

// ─── Messaging ─────────────────────────────────────────────────────

function sendToTab(tabId: number | null, message: any): Promise<any> {
  if (typeof tabId !== "number") {
    return Promise.reject(new Error("no tab"));
  }
  return chrome.tabs.sendMessage(tabId, message);
}

// ─── State polling ─────────────────────────────────────────────────

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

// ─── Rendering ─────────────────────────────────────────────────────

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
