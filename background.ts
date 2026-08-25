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

  setTimeout(() => {
    chrome.runtime
      .sendMessage({
        target: "rikai-offscreen",
        type: "INIT",
        requestId: 0,
        payload: {},
      })
      .catch(() => {});
  }, 3000);
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
