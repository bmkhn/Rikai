// Rikai Background Service Worker

const OFFSCREEN_URL = "offscreen/offscreen.html";

interface TabState {
  state: string;
  detail?: string;
}

const tabStates = new Map<number, TabState>();

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

      case "RIKAI_UPDATE_FILE_STATUS":
        updateFileStatus(message.fileKey, message.status).then(() => {
          sendResponse({ ok: true });
        }).catch((err: Error) => {
          sendResponse({ ok: false, error: String(err) });
        });
        return true;

      case "RIKAI_AUTO_INIT":
        handleAutoInit(sendResponse);
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
}// ─── Auto-Initialize OCR Engine ──────────────────────────────────

async function handleAutoInit(
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    // Ensure offscreen document exists
    await ensureOffscreenDocument();

    // Find active tab and forward auto-init to its content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") {
      sendResponse({ ok: false, error: "No active tab" });
      return;
    }

    await chrome.tabs.sendMessage(tab.id, { type: "RIKAI_AUTO_INIT" });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
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
      "rikaiFileStatuses",
    ]);
    sendResponse({ ok: true });
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
