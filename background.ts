// Rikai Background Service Worker

const OFFSCREEN_URL = "offscreen/offscreen.html";

interface TabState {
  state: string;
  detail?: string;
}

const tabStates = new Map<number, TabState>();

// ─── File URLs ─────────────────────────────────────────────────────

const FILE_URLS: Record<string, string> = {
  encoder: "https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model.onnx",
  decoder: "https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/decoder_model.onnx",
  tokenizer: "https://huggingface.co/NorwayFish/manga-ocr/resolve/main/tokenizer.json",
};

const CACHE_NAME = "rikai-models";

// ─── Eager Offscreen Creation ────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    caches
      .keys()
      .then((names) => Promise.all(names.map((n) => caches.delete(n))))
      .catch(() => {});
  }
  ensureOffscreenDocument().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument().catch(() => {});
});

// ─── Message Routing ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ) => {
    if (!message || typeof message !== "object") return undefined;

    // Progress broadcast from offscreen document
    if (message.source === "rikai-offscreen" && message.type === "PROGRESS") {
      try {
        if (message.files) {
          chrome.storage?.local?.set({
            rikaiDownloadProgress: {
              active: message.phase !== "done" && message.phase !== "error",
              phase: message.phase || "download",
              files: message.files,
            },
          });
        }
      } catch {
        // storage unavailable
      }
      return false;
    }

    if (message.target === "rikai-bg" && message.type === "STATE_UPDATE") {
      const tabId = sender.tab?.id;
      if (typeof tabId === "number") {
        if (message.state === "OFF") {
          tabStates.delete(tabId);
        } else {
          tabStates.set(tabId, {
            state: message.state,
            detail: message.detail,
          });
        }
      }
      sendResponse({ ok: true });
      return false;
    }

    switch (message.type) {
      case "RIKAI_GET_TAB_STATE":
        handleGetTabState(message, sendResponse);
        return true;

      case "RIKAI_ENSURE_OFFSCREEN":
        ensureOffscreenDocument()
          .then(() => sendResponse({ ok: true }))
          .catch((err: Error) =>
            sendResponse({ ok: false, error: String(err) })
          );
        return true;

      case "RIKAI_CHECK_MODEL_STATUS":
        handleCheckModelStatus(sendResponse);
        return true;

      case "RIKAI_DELETE_MODEL":
        handleDeleteModel(sendResponse);
        return true;

      case "RIKAI_DOWNLOAD_MODEL":
        handleDownloadModel(sendResponse);
        return true;

      case "RIKAI_DOWNLOAD_FILE":
        handleDownloadFile(message.fileKey, sendResponse);
        return true;

      case "RIKAI_STORE_FILE":
        handleStoreFile(message.fileKey, message.fileName, message.data, sendResponse);
        return true;

      case "RIKAI_CANCEL_DOWNLOAD":
        handleCancelDownload(sendResponse);
        return true;

      default:
        return undefined;
    }
  }
);

async function handleGetTabState(
  message: any,
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    let tabId: number | undefined = message.tabId;
    if (typeof tabId !== "number") {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      tabId = tab?.id;
    }
    if (typeof tabId !== "number") {
      sendResponse({ state: "UNSUPPORTED" });
      return;
    }
    const entry = tabStates.get(tabId);
    sendResponse({
      state: entry ? entry.state : "OFF",
      detail: entry?.detail,
    });
  } catch (err) {
    sendResponse({ state: "UNSUPPORTED" });
  }
}

// ─── Offscreen Document Lifecycle ────────────────────────────────────

async function ensureOffscreenDocument(): Promise<void> {
  const hasDocument = await chrome.offscreen.hasDocument?.();
  if (hasDocument) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_PARSER"],
    justification:
      "Runs the MangaOCR model (ONNX Runtime WASM) and image text detection off the page's main thread.",
  });
}

// ─── Model Status ──────────────────────────────────────────────────

async function handleCheckModelStatus(
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    const result = await chrome.storage.local.get(["rikaiModelReady", "rikaiFileStatuses"]);
    const files: Record<string, string> = (result.rikaiFileStatuses as Record<string, string>) || {};
    sendResponse({ ready: !!result.rikaiModelReady, files });
  } catch (err) {
    sendResponse({ ready: false, files: {} });
  }
}

// ─── Per-file Download ────────────────────────────────────────────

async function handleDownloadFile(
  fileKey: string,
  sendResponse: (response?: any) => void
): Promise<void> {
  const url = FILE_URLS[fileKey];
  if (!url) {
    sendResponse({ ok: false, error: `Unknown file: ${fileKey}` });
    return;
  }

  try {
    // Update file status to downloading
    await updateFileStatus(fileKey, "downloading");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, new Response(buffer, {
      headers: { "Content-Type": "application/octet-stream" },
    }));

    await updateFileStatus(fileKey, "done");
    sendResponse({ ok: true });
  } catch (err) {
    await updateFileStatus(fileKey, "error");
    sendResponse({ ok: false, error: String(err) });
  }
}

// ─── Store file from file picker ──────────────────────────────────

async function handleStoreFile(
  fileKey: string,
  fileName: string,
  data: number[],
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    const url = FILE_URLS[fileKey] || `rikai://local/${fileKey}/${fileName}`;
    const buffer = new Uint8Array(data).buffer;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, new Response(buffer, {
      headers: { "Content-Type": "application/octet-stream" },
    }));

    await updateFileStatus(fileKey, "done");
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
}

// ─── File status tracking ─────────────────────────────────────────

async function updateFileStatus(fileKey: string, status: string): Promise<void> {
  try {
    const result = await chrome.storage.local.get("rikaiFileStatuses");
    const statuses: Record<string, string> = (result.rikaiFileStatuses as Record<string, string>) || {};
    statuses[fileKey] = status;
    await chrome.storage.local.set({ rikaiFileStatuses: statuses });

    // Update ready flag if all done
    const allDone = ["encoder", "decoder", "tokenizer"].every(
      (k) => statuses[k] === "done"
    );
    await chrome.storage.local.set({ rikaiModelReady: allDone });
  } catch {
    // storage unavailable
  }
}

// ─── Delete Model ─────────────────────────────────────────────────

async function handleDeleteModel(
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
    await chrome.storage.local.remove([
      "rikaiModelReady",
      "rikaiDownloadProgress",
      "rikaiFileStatuses",
    ]);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
}

// ─── Cancel Download ──────────────────────────────────────────────

async function handleCancelDownload(
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    await ensureOffscreenDocument();
    chrome.runtime
      .sendMessage({
        target: "rikai-offscreen",
        type: "CANCEL_INIT",
        requestId: 0,
        payload: {},
      })
      .then(async () => {
        try {
          const names = await caches.keys();
          await Promise.all(names.map((n) => caches.delete(n)));
        } catch { /* ignore */ }
        await chrome.storage.local.remove([
          "rikaiDownloadProgress",
          "rikaiModelReady",
          "rikaiFileStatuses",
        ]);
        sendResponse({ ok: true });
      })
      .catch(async (err: Error) => {
        try {
          const names = await caches.keys();
          await Promise.all(names.map((n) => caches.delete(n)));
        } catch { /* ignore */ }
        await chrome.storage.local.remove([
          "rikaiDownloadProgress",
          "rikaiModelReady",
          "rikaiFileStatuses",
        ]).catch(() => {});
        sendResponse({ ok: false, error: String(err) });
      });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
}

// ─── Download All (full model) ────────────────────────────────────

async function handleDownloadModel(
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    await ensureOffscreenDocument();
    chrome.runtime
      .sendMessage({
        target: "rikai-offscreen",
        type: "INIT",
        requestId: 0,
        payload: {},
      })
      .then((response: any) => {
        const progress = response?.type === "READY"
          ? { active: false, phase: "done", percent: 100, detail: "" }
          : { active: false, phase: "error", percent: 0, detail: response?.error || "Failed" };
        try {
          chrome.storage?.local?.set({
            rikaiModelReady: response?.type === "READY",
            rikaiDownloadProgress: progress,
          });
        } catch { /* storage unavailable */ }

        if (response?.type === "READY") {
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: response?.error || "Download failed" });
        }
      })
      .catch((err: Error) => {
        try {
          chrome.storage?.local?.set({
            rikaiDownloadProgress: { active: false, phase: "error", percent: 0, detail: String(err) },
          });
        } catch { /* storage unavailable */ }
        sendResponse({ ok: false, error: String(err) });
      });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
}

// ─── Tab Cleanup ─────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId: number) => {
  tabStates.delete(tabId);
});

chrome.tabs.onUpdated.addListener(
  (tabId: number, changeInfo: { status?: string }) => {
    if (changeInfo.status === "loading") {
      tabStates.delete(tabId);
    }
  }
);
