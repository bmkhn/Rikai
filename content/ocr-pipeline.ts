// Rikai OCR Pipeline — content-script side
//
// Contains three pieces:
//   - MangaOcrClient : messaging wrapper around the offscreen OCR document
//   - OCRCache       : dedupes recognition per stable image identity
//   - OCRQueue       : serializes work, supports priority
//
// The content script never runs the model itself; it only schedules work.

interface ImageRecord {
  id: string;
  element: HTMLElement;
  src: string;
  width: number;
  height: number;
  rect: DOMRect;
  isLazy: boolean;
  isBackground: boolean;
  source: string;
}

interface OcrRegion {
  box: { x: number; y: number; width: number; height: number };
  japanese: string;
  confidence: number;
}

interface OffscreenMessage {
  source?: string;
  type?: string;
  requestId?: number;
  percent?: number;
  regions?: OcrRegion[];
  error?: string;
}

interface ImageRef {
  kind: "url" | "dataurl";
  value: string;
}

// ─── MangaOcrClient ──────────────────────────────────────────────────

class MangaOcrClient {
  private _pending: Map<number, (msg: OffscreenMessage) => void>;
  private _timers: Map<number, ReturnType<typeof setTimeout>>;
  private _requestCounter: number;
  private _ready: boolean;

  constructor() {
    this._pending = new Map();
    this._timers = new Map();
    this._requestCounter = 0;
    this._ready = false;

    chrome.runtime.onMessage.addListener((message: OffscreenMessage) => {
      if (!message || message.source !== "rikai-offscreen") return;
      if (message.requestId == null) return;

      const resolve = this._pending.get(message.requestId);
      if (!resolve) return;
      this._pending.delete(message.requestId);
      // Clear any associated timeout timer
      const timer = this._timers.get(message.requestId);
      if (timer != null) clearTimeout(timer);
      this._timers.delete(message.requestId);
      resolve(message);
    });
  }

  async initialize(
    onProgress: (p: Record<string, any>) => void = () => {},
    force = false
  ): Promise<void> {
    if (this._ready && !force) return;

    await chrome.runtime.sendMessage({ type: "RIKAI_ENSURE_OFFSCREEN" });

      const response = await this._request("INIT", {});
      if (response.type === "ERROR") {
        throw new Error(response.error || "OCR initialization failed.");
      }
      this._ready = true;
    }

    get isReady(): boolean {
      return this._ready;
    }

    async processImage(imageRef: ImageRef): Promise<OcrRegion[]> {
      const response = await this._request("PROCESS_IMAGE", { image: imageRef });

      if (response.type === "ERROR") {
        throw new Error(response.error || "OCR processing failed.");
      }
      return response.regions || [];
    }

  private _request(type: string, payload: Record<string, any>, timeoutMs = 120_000): Promise<OffscreenMessage> {
    const requestId = ++this._requestCounter;
    return new Promise((resolve) => {
      this._pending.set(requestId, resolve);

      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        this._timers.delete(requestId);
        console.error(`[Rikai OCR] Request ${requestId} (${type}) timed out after ${timeoutMs / 1000}s`);
        resolve({ type: "ERROR", error: `OCR request '${type}' timed out after ${timeoutMs / 1000}s.` });
      }, timeoutMs);
      this._timers.set(requestId, timer);

      chrome.runtime
        .sendMessage({
          target: "rikai-offscreen",
          type,
          requestId,
          payload: { ...payload, requestId },
        })
        .catch(() => {
          clearTimeout(timer);
          this._timers.delete(requestId);
          this._pending.delete(requestId);
          resolve({ type: "ERROR", error: "OCR engine unreachable." });
        });
    });
  }
}

// ─── OCRCache ────────────────────────────────────────────────────────

class OCRCache {
  private _regions: Map<string, OcrRegion[]>;
  private _translations: Map<string, Map<number, { japanese: string; translation: string }>>;
  private _maxEntries: number;

  constructor(maxEntries = 60) {
    this._regions = new Map();
    this._translations = new Map();
    this._maxEntries = maxEntries;
  }

  key(record: ImageRecord): string {
    const src = (record.src || "").split("#")[0];
    return `${record.width || 0}x${record.height || 0}|${src}`;
  }

  getRegions(key: string): OcrRegion[] | null {
    return this._regions.get(key) || null;
  }

  setRegions(key: string, regions: OcrRegion[]): void {
    this._evictIfNeeded(this._regions);
    this._regions.set(key, regions);
  }

  getTranslation(
    imageKey: string,
    boxKey: string
  ): { japanese: string; translation: string } | null {
    return this._translations.get(imageKey)?.get(boxKey as any) || null;
  }

  setTranslation(
    imageKey: string,
    boxKey: string,
    value: { japanese: string; translation: string }
  ): void {
    let inner = this._translations.get(imageKey);
    if (!inner) {
      inner = new Map();
      this._translations.set(imageKey, inner);
    }
    inner.set(boxKey as any, value);
  }

  clear(): void {
    this._regions.clear();
    this._translations.clear();
  }

  private _evictIfNeeded(map: Map<string, any>): void {
    while (map.size >= this._maxEntries) {
      map.delete(map.keys().next().value!);
    }
  }
}

// ─── OCRQueue ────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  priority: number;
  task: () => Promise<void>;
}

class OCRQueue {
  private _queue: QueueItem[];
  private _running: boolean;
  private _cancelled: boolean;
  private _enqueued: Set<string>;

  constructor() {
    this._queue = [];
    this._running = false;
    this._cancelled = false;
    this._enqueued = new Set();
  }

  push(id: string, priority: number, task: () => Promise<void>): boolean {
    if (this._enqueued.has(id)) return false;
    this._enqueued.add(id);
    this._queue.push({ id, priority, task });
    this._queue.sort((a, b) => a.priority - b.priority);
    this._drain();
    return true;
  }

  cancel(): void {
    this._cancelled = true;
    this._queue = [];
    this._enqueued.clear();
  }

  get pendingCount(): number {
    return this._queue.length;
  }

  private async _drain(): Promise<void> {
    if (this._running) return;
    if (this._cancelled) return;
    this._running = true;

    try {
      while (this._queue.length > 0 && !this._cancelled) {
        const item = this._queue.shift()!;
        try {
          await item.task();
        } catch (err) {
          console.warn(`[Rikai] Queued task ${item.id} failed:`, err);
        } finally {
          this._enqueued.delete(item.id);
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this._running = false;
      this._cancelled = false;
    }
  }
}

(window as any).RikaiMangaOcrClient = MangaOcrClient;
(window as any).RikaiOcrCache = OCRCache;
(window as any).RikaiOcrQueue = OCRQueue;
