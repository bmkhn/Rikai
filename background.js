// Rikai Background Service Worker
// Responsibilities:
//   - Track per-tab Rikai state (the popup reads this when it opens)
//   - Manage the offscreen OCR document lifecycle (created eagerly, kept alive)
//
// The content script owns the *actual* translator engine; this worker only
// mirrors state so the popup can reflect reality after being reopened.

const OFFSCREEN_URL = "offscreen/offscreen.html";

/** @type {Map<number, {state: string, detail?: string}>} tabId -> last reported state */
const tabStates = new Map();

// ─── Eager Offscreen Creation ────────────────────────────────────────
// Create the offscreen document on install / browser startup so the
// content script never pays the creation cost on its first activation.
// Model loading is still deferred to the first INIT message.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // On fresh install or reinstall, wipe any leftover Cache Storage so the
  // extension starts with a clean slate (model weights will re-download).
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  // State updates from content scripts
  if (message.target === "rikai-bg" && message.type === "STATE_UPDATE") {
    const tabId = sender.tab?.id;
    if (typeof tabId === "number") {
      if (message.state === "OFF") {
        tabStates.delete(tabId);
      } else {
        tabStates.set(tabId, { state: message.state, detail: message.detail });
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  // Popup queries
  switch (message.type) {
    case "RIKAI_GET_TAB_STATE":
      handleGetTabState(message, sendResponse);
      return true;

    case "RIKAI_ENSURE_OFFSCREEN":
      ensureOffscreenDocument()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    default:
      return undefined;
  }
});

async function handleGetTabState(message, sendResponse) {
  try {
    let tabId = message.tabId;
    if (typeof tabId !== "number") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }
    if (typeof tabId !== "number") {
      sendResponse({ state: "UNSUPPORTED" });
      return;
    }
    const entry = tabStates.get(tabId);
    sendResponse({ state: entry ? entry.state : "OFF", detail: entry?.detail });
  } catch (err) {
    sendResponse({ state: "UNSUPPORTED" });
  }
}

// ─── Offscreen Document Lifecycle ────────────────────────────────────

async function ensureOffscreenDocument() {
  // chrome.offscreen exists only in MV3 Chrome 109+; we require 116+ in manifest.
  const hasDocument = await chrome.offscreen.hasDocument?.();
  if (hasDocument) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_PARSER"],
    justification:
      "Runs the MangaOCR model (Transformers.js / ONNX Runtime WASM) and image text detection off the page's main thread.",
  });

  // Kick off the first INIT after a short delay so the offscreen's module
  // has time to load.  If the module isn't ready yet the INIT will fail
  // harmlessly and the content script's own INIT will succeed later.
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

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation wipes the content script's in-memory state.
  if (changeInfo.status === "loading") {
    tabStates.delete(tabId);
  }
});
