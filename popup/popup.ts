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
const deleteBtn = document.getElementById("delete-btn") as HTMLElement;

// Per-file elements
type FileType = "encoder" | "decoder" | "tokenizer";

interface FileDef {
  key: FileType;
  statusEl: HTMLElement;
  locateBtn: HTMLElement;
  fileInput: HTMLInputElement;
}

const FILES: FileDef[] = [
  {
    key: "encoder",
    statusEl: document.getElementById("encoder-status")!,
    locateBtn: document.getElementById("encoder-locate")!,
    fileInput: document.getElementById("encoder-file") as HTMLInputElement,
  },
  {
    key: "decoder",
    statusEl: document.getElementById("decoder-status")!,
    locateBtn: document.getElementById("decoder-locate")!,
    fileInput: document.getElementById("decoder-file") as HTMLInputElement,
  },
  {
    key: "tokenizer",
    statusEl: document.getElementById("tokenizer-status")!,
    locateBtn: document.getElementById("tokenizer-locate")!,
    fileInput: document.getElementById("tokenizer-file") as HTMLInputElement,
  },
];

let currentTabId: number | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// Track per-file status from storage
let fileStatuses: Record<FileType, string> = {
  encoder: "pending",
  decoder: "pending",
  tokenizer: "pending",
};

let modelReady = false;
let ocrInitializing = false;
let ocrFailed = false;

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

    // Update per-file statuses from storage and apply to DOM
    if (modelStatus.files) {
      fileStatuses = { ...fileStatuses, ...modelStatus.files };
    }

    // Apply stored statuses to each file's DOM element
    for (const f of FILES) {
      const status = fileStatuses[f.key];
      if (status === "done") {
        f.statusEl.textContent = "✓";
        f.statusEl.className = "file-status done";
      } else if (status === "error") {
        f.statusEl.textContent = "Failed";
        f.statusEl.className = "file-status error";
      } else if (status === "loading") {
        f.statusEl.textContent = "Loading…";
        f.statusEl.className = "file-status loading";
      } else {
        f.statusEl.textContent = "—";
        f.statusEl.className = "file-status pending";
      }
    }

    updateModelUI();

    // Check tab state
    const bgState = await chrome.runtime
      .sendMessage({ type: "RIKAI_GET_TAB_STATE" })
      .catch(() => ({ state: "OFF" }));

    powerToggle.checked = bgState.state !== "OFF";
    await refreshFromTab();

    // Auto-initialize engine if all files loaded but engine not ready
    if (modelReady && !ocrFailed && bgState.state === "OFF") {
      ocrInitializing = true;
      powerToggle.disabled = true;
      render("LOADING", null);
      chrome.runtime.sendMessage({ type: "RIKAI_AUTO_INIT" }).catch(() => {});
    }

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

deleteBtn.addEventListener("click", onDelete);

// Per-file locate button listeners
for (const f of FILES) {
  f.locateBtn.addEventListener("click", () => f.fileInput.click());
  f.fileInput.addEventListener("change", () => onLocateFile(f));
}

// ─── Toggle ───────────────────────────────────────────────────────────

async function onToggle(): Promise<void> {
  if (!modelReady || ocrInitializing || ocrFailed) {
    powerToggle.checked = false;
    return;
  }

  const turnOn = powerToggle.checked;
  const type = turnOn ? "RIKAI_ACTIVATE" : "RIKAI_DEACTIVATE";

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

// ─── Locate (file picker) ───────────────────────────────────────────

const HF_URLS: Record<FileType, string> = {
  encoder: "https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model.onnx",
  decoder: "https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/decoder_model.onnx",
  tokenizer: "https://huggingface.co/NorwayFish/manga-ocr/resolve/main/tokenizer.json",
};
const CACHE_NAME = "rikai-models";

async function onLocateFile(f: FileDef): Promise<void> {
  const file = f.fileInput.files?.[0];
  if (!file) return;

  setFileStatus(f.key, "loading", "Loading…");
  persistFileStatus(f.key, "loading");

  try {
    const arrayBuffer = await file.arrayBuffer();

    // Write directly to Cache Storage (popup shares origin with background)
    const cache = await caches.open(CACHE_NAME);
    await cache.put(HF_URLS[f.key], new Response(arrayBuffer, {
      headers: { "Content-Type": "application/octet-stream" },
    }));

    // Tell background to update status in chrome.storage.local
    await chrome.runtime.sendMessage({
      type: "RIKAI_UPDATE_FILE_STATUS",
      fileKey: f.key,
      status: "done",
    });

    setFileStatus(f.key, "done", "✓");
  } catch (err) {
    console.error("[Rikai] File store failed:", err);
    setFileStatus(f.key, "error", "Failed");
    persistFileStatus(f.key, "error");
  } finally {
    f.fileInput.value = "";
    updateModelUI();
  }
}

async function persistFileStatus(fileKey: FileType, status: string): Promise<void> {
  try {
    const result = await chrome.storage.local.get("rikaiFileStatuses");
    const statuses: Record<string, string> = (result.rikaiFileStatuses as Record<string, string>) || {};
    statuses[fileKey] = status;
    await chrome.storage.local.set({ rikaiFileStatuses: statuses });
  } catch {
    // storage unavailable
  }
}

// ─── Reset Cache ────────────────────────────────────────────────────

async function onDelete(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "RIKAI_DELETE_MODEL" });
    modelReady = false;
    ocrInitializing = false;
    ocrFailed = false;
    powerToggle.checked = false;
    for (const f of FILES) {
      setFileStatus(f.key, "pending", "—");
    }
    hideError();
    updateModelUI();
  } catch (err: any) {
    showError("Reset failed", err?.message || "Unknown error.");
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

  updateToggleState();
}

function updateToggleState(): void {
  const allDone = Object.values(fileStatuses).every((s) => s === "done");
  const anyActive = Object.values(fileStatuses).some(
    (s) => s === "loading"
  );

  if (!allDone || anyActive || ocrInitializing || ocrFailed) {
    powerToggle.disabled = true;
    if (!ocrInitializing) powerToggle.checked = false;
  } else {
    powerToggle.disabled = false;
  }
}

function updateModelUI(): void {
  const allDone = Object.values(fileStatuses).every((s) => s === "done");
  const anyActive = Object.values(fileStatuses).some(
    (s) => s === "loading"
  );

  if (allDone) {
    modelIcon.textContent = "✓";
    modelLabel.textContent = "ALL FILES LOADED";
    modelLabel.className = "model-label ready";
    deleteBtn.removeAttribute("hidden");
    powerToggle.disabled = false;
  } else if (anyActive) {
    // Don't overwrite active states
    return;
  } else {
    modelIcon.textContent = "—";
    modelLabel.textContent = "MODEL NOT DOWNLOADED";
    modelLabel.className = "model-label";
    deleteBtn.setAttribute("hidden", "");
    powerToggle.disabled = true;
    powerToggle.checked = false;
  }

  updateToggleState();
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

  // Handle auto-init completion
  if (ocrInitializing) {
    if (phase === "READY" || phase === "PROCESSING") {
      // Engine initialized successfully
      ocrInitializing = false;
      powerToggle.disabled = false;
    } else if (phase === "ERROR") {
      // Engine failed to initialize
      ocrInitializing = false;
      ocrFailed = true;
      powerToggle.disabled = true;
      powerToggle.checked = false;
    }
  }

  // Only sync toggle position when engine is ready and not initializing
  if (!ocrInitializing && !ocrFailed) {
    const shouldBeOn = phase !== "OFF" && phase !== "UNSUPPORTED";
    if (powerToggle.checked !== shouldBeOn) {
      powerToggle.checked = shouldBeOn;
    }
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
