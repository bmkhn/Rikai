// Rikai OCR Pipeline — content-script side
//
// Contains three pieces:
//   - MangaOcrClient : messaging wrapper around the offscreen OCR document
//   - OCRCache       : dedupes recognition per stable image identity
//   - OCRQueue       : serializes work, supports priority (future eye tracking)
//
// The content script never runs the model itself; it only schedules work.

(() => {
  "use strict";

  // ─── MangaOcrClient ──────────────────────────────────────────────────

  class MangaOcrClient {
    constructor() {
      /** @type {Map<number, (msg: any) => void>} */
      this._pending = new Map();
      this._requestCounter = 0;
      this._ready = false;
      /** @type {(p: { percent: number }) => void} */
      this._progressListener = () => {};

      chrome.runtime.onMessage.addListener((message) => {
        if (!message || message.source !== "rikai-offscreen") return;

        // Streaming progress during model load ({percent, loadedMB, totalMB, phase, ...})
        if (message.type === "PROGRESS") {
          this._progressListener(message.percent != null ? { percent: message.percent } : message);
          return;
        }

        const resolve = message.requestId != null ? this._pending.get(message.requestId) : null;
        if (!resolve) return;
        this._pending.delete(message.requestId);
        resolve(message);
      });
    }

    /**
     * Ensure the offscreen document exists and the model is loaded.
     * @param {(p: { percent: number }) => void} onProgress
     * @param {boolean} [force] re-run init even if marked ready
     */
    async initialize(onProgress = () => {}, force = false) {
      if (this._ready && !force) return;

      this._progressListener = onProgress;

      await chrome.runtime.sendMessage({ type: "RIKAI_ENSURE_OFFSCREEN" });

      const response = await this._request("INIT", {});
      if (response.type === "ERROR") {
        throw new Error(response.error || "OCR initialization failed.");
      }
      this._ready = true;
    }

    get isReady() {
      return this._ready;
    }

    /**
     * Detect text regions and recognize Japanese in one image.
     * @param {{ kind: "url"|"dataurl", value: string }} imageRef
     * @returns {Promise<Array<{ box: {x,y,width,height}, japanese: string, confidence: number }>>}
     */
    async processImage(imageRef) {
      const response = await this._request("PROCESS_IMAGE", { image: imageRef });

      if (response.type === "ERROR") {
        throw new Error(response.error || "OCR processing failed.");
      }
      return response.regions || [];
    }

    _request(type, payload) {
      const requestId = ++this._requestCounter;
      return new Promise((resolve) => {
        this._pending.set(requestId, resolve);
        chrome.runtime
          .sendMessage({
            target: "rikai-offscreen",
            type,
            requestId,
            payload: { ...payload, requestId },
          })
          .catch(() => {
            // sendMessage itself failed (no receiver)
            this._pending.delete(requestId);
            resolve({ type: "ERROR", error: "OCR engine unreachable." });
          });
      });
    }
  }

  // ─── OCRCache ────────────────────────────────────────────────────────

  class OCRCache {
    constructor(maxEntries = 60) {
      /** @type {Map<string, Array<{ box, japanese, confidence }>>} */
      this._regions = new Map();
      /** @type {Map<string, Map<number, { japanese: string, translation: string }>>} */
      this._translations = new Map();
      this._maxEntries = maxEntries;
    }

    /**
     * Stable cache key for an image record — independent of DOM element
     * identity so re-inserted / lazy-swapped nodes still hit.
     */
    key(record) {
      const src = (record.src || "").split("#")[0];
      return `${record.width || 0}x${record.height || 0}|${src}`;
    }

    getRegions(key) {
      return this._regions.get(key) || null;
    }

    setRegions(key, regions) {
      this._evictIfNeeded(this._regions);
      this._regions.set(key, regions);
    }

    getTranslation(imageKey, boxKey) {
      return this._translations.get(imageKey)?.get(boxKey) || null;
    }

    setTranslation(imageKey, boxKey, value) {
      let inner = this._translations.get(imageKey);
      if (!inner) {
        inner = new Map();
        this._translations.set(imageKey, inner);
      }
      inner.set(boxKey, value);
    }

    clear() {
      this._regions.clear();
      this._translations.clear();
    }

    _evictIfNeeded(map) {
      while (map.size >= this._maxEntries) {
        map.delete(map.keys().next().value); // FIFO eviction
      }
    }
  }

  // ─── OCRQueue ────────────────────────────────────────────────────────

  class OCRQueue {
    constructor() {
      /** @type {Array<{ id: string, priority: number, task: () => Promise<void> }>} */
      this._queue = [];
      this._running = false;
      this._cancelled = false;
      /** @type {Set<string>} ids currently queued or running */
      this._enqueued = new Set();
    }

    /**
     * Enqueue a task. Lower priority number runs first.
     * Duplicate ids are ignored until their task completes.
     * @returns {boolean} whether the task was enqueued
     */
    push(id, priority, task) {
      if (this._enqueued.has(id)) return false;
      this._enqueued.add(id);
      this._queue.push({ id, priority, task });
      // Higher priority first on equal insertion order stability
      this._queue.sort((a, b) => a.priority - b.priority);
      this._drain();
      return true;
    }

    cancel() {
      this._cancelled = true;
      this._queue = [];
      this._enqueued.clear();
    }

    get pendingCount() {
      return this._queue.length;
    }

    async _drain() {
      if (this._running) return;
      if (this._cancelled) return;
      this._running = true;

      try {
        while (this._queue.length > 0 && !this._cancelled) {
          const item = this._queue.shift();
          try {
            await item.task();
          } catch (err) {
            console.warn(`[Rikai] Queued task ${item.id} failed:`, err);
          } finally {
            this._enqueued.delete(item.id);
          }
          // Yield to keep the page responsive between images
          await new Promise((r) => setTimeout(r, 0));
        }
      } finally {
        this._running = false;
        this._cancelled = false;
      }
    }
  }

  window.RikaiMangaOcrClient = MangaOcrClient;
  window.RikaiOcrCache = OCRCache;
  window.RikaiOcrQueue = OCRQueue;
})();
