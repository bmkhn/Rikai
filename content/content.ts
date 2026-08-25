// Rikai Content Script — Translator Engine

interface PhaseState {
  phase: string;
  detail: string;
}

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

interface ImageRef {
  kind: "url" | "dataurl";
  value: string;
}

interface InitProgress {
  phase?: string;
  downloading?: boolean;
  loadedMB?: number;
  totalMB?: number;
  percent?: number;
  fromCache?: boolean;
}

(() => {
  "use strict";

  if ((window as any).__rikaiContentLoaded) return;
  (window as any).__rikaiContentLoaded = true;

  // ─── Modules ─────────────────────────────────────────────────────────

  const extractor = new (window as any).RikaiImageExtractor();
  const ocr = new (window as any).RikaiMangaOcrClient();
  const ocrCache = new (window as any).RikaiOcrCache();
  const queue = new (window as any).RikaiOcrQueue();
  const translator = new (window as any).RikaiTranslator();
  const overlay = new (window as any).RikaiOverlay();

  // ─── State ───────────────────────────────────────────────────────────

  const state: PhaseState = {
    phase: "OFF",
    detail: "",
  };

  const seenImages = new Set<string>();

  let watchIntervalId: ReturnType<typeof setInterval> | null = null;
  let currentUrl = location.href;

  // ─── Messaging from popup ────────────────────────────────────────────

  chrome.runtime.onMessage.addListener(
    (message: any, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
      switch (message?.type) {
        case "RIKAI_ACTIVATE":
          activate().catch((err: Error) => {
            console.error("[Rikai] Activation failed:", err);
            setError("ACTIVATION FAILED", String(err?.message || err));
          });
          sendResponse({ ok: true });
          return false;

        case "RIKAI_DEACTIVATE":
          deactivate();
          sendResponse({ ok: true });
          return false;

        case "RIKAI_GET_STATUS":
          sendResponse({ state: state.phase, detail: state.detail });
          return false;

        default:
          return undefined;
      }
    }
  );

  function setPhase(phase: string, detail = ""): void {
    state.phase = phase;
    state.detail = detail;
    chrome.runtime
      .sendMessage({
        target: "rikai-bg",
        type: "STATE_UPDATE",
        state: phase,
        detail,
      })
      .catch(() => {});
  }

  function setError(title: string, detail: string): void {
    setPhase("ERROR", detail);
    overlay.setStatus({
      tone: "error",
      title,
      detail,
      onRetry: () => {
        overlay.hideStatus();
        activate().catch((err: Error) =>
          setError("ACTIVATION FAILED", String(err?.message || err))
        );
      },
    });
  }

  // ─── Activation lifecycle ────────────────────────────────────────────

  async function activate(): Promise<void> {
    if (
      state.phase === "LOADING" ||
      state.phase === "READY" ||
      state.phase === "PROCESSING"
    ) {
      return;
    }

    const t0 = performance.now();
    console.log("[Rikai] Activating…");

    overlay.activate();
    setPhase("LOADING");
    overlay.setStatus({
      tone: "loading",
      title: "LOADING OCR ENGINE",
      detail: "Japanese MangaOCR",
      indeterminate: true,
    });

    try {
      await ocr.initialize((p: InitProgress) => {
        if (p.phase === "warmup") {
          overlay.setStatus({
            tone: "loading",
            title: "CALIBRATING ENGINE",
            detail: "Preparing the recognizer — one moment",
            indeterminate: true,
          });
          return;
        }
        if (p.downloading) {
          overlay.setStatus({
            tone: "loading",
            title: "FIRST-TIME SETUP",
            detail:
              `Downloading Japanese OCR model · ${p.loadedMB} / ${p.totalMB} MB · ` +
              `this happens once, then it's cached`,
            percent: p.percent,
          });
        } else if (p.percent != null && !p.fromCache) {
          overlay.setStatus({
            tone: "loading",
            title: "LOADING OCR ENGINE",
            detail: "Japanese MangaOCR",
            percent: p.percent,
          });
        }
      });

      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      console.log(`[Rikai] Activation complete in ${elapsed}s`);
      setPhase("READY");
      overlay.setStatus({ tone: "success", title: "SYSTEM READY" });
      setTimeout(() => {
        if (state.phase !== "ERROR") overlay.hideStatus();
      }, 1200);

      startPipeline();
    } catch (err: any) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      console.error(`[Rikai] OCR init failed after ${elapsed}s:`, err);
      setError(
        "OCR INITIALIZATION FAILED",
        "Unable to load the Japanese OCR model."
      );
    }
  }

  function deactivate(): void {
    console.log("[Rikai] Deactivating.");
    queue.cancel();
    stopWatching();
    extractor.disconnect();
    overlay.clear();
    overlay.deactivate();
    overlay.hideStatus();
    seenImages.clear();
    setPhase("OFF");
  }

  // ─── Processing pipeline ─────────────────────────────────────────────

  function startPipeline(): void {
    const records: ImageRecord[] = extractor.scan();
    extractor.observe();
    enqueueVisible(records);

    watchIntervalId = setInterval(() => {
      if (state.phase === "ERROR") return;

      if (location.href !== currentUrl) {
        console.log("[Rikai] Navigation detected — rescanning.");
        currentUrl = location.href;
        seenImages.clear();
        overlay.prune();
      }

      overlay.prune();
      enqueueVisible(extractor.getImages());
    }, 1500);
  }

  function stopWatching(): void {
    if (watchIntervalId != null) {
      clearInterval(watchIntervalId);
      watchIntervalId = null;
    }
  }

  function enqueueVisible(records: ImageRecord[]): void {
    const vh = window.innerHeight;
    let enqueuedAny = false;

    for (const record of records) {
      if (!(record.element instanceof HTMLElement)) continue;
      if (!record.element.isConnected) continue;

      const key: string = ocrCache.key(record);
      if (seenImages.has(key)) continue;
      if (ocrCache.getRegions(key)) continue;

      const rect = record.element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const distance =
        rect.top > vh ? rect.top - vh : rect.bottom < 0 ? -rect.bottom : 0;
      if (distance > vh) continue;

      seenImages.add(key);
      const priority = distance === 0 ? 0 : Math.round(distance);
      enqueuedAny =
        queue.push(key, priority, () => processImageRecord(record, key)) ||
        enqueuedAny;
    }

    if (enqueuedAny && state.phase !== "PROCESSING") {
      setPhase("PROCESSING");
    }
  }

  async function processImageRecord(
    record: ImageRecord,
    key: string
  ): Promise<void> {
    const element = record.element;
    if (!element.isConnected || state.phase === "ERROR") return;

    try {
      overlay.setStatus({
        tone: "loading",
        title: "DETECTING TEXT",
        detail: "Scanning manga page",
        indeterminate: true,
      });

      let regions: OcrRegion[] | null = ocrCache.getRegions(key);

      if (!regions) {
        const imageRef = await buildImageRef(record);
        if (!imageRef) return;

        regions = await ocr.processImage(imageRef);
        ocrCache.setRegions(key, regions);
      }

      const regionList: OcrRegion[] = regions!;
      let translatedCount = 0;

      for (let i = 0; i < regionList.length; i++) {
        const region = regionList[i];
        const boxKey = `${region.box.x},${region.box.y},${region.box.width},${region.box.height}`;

        let english: string;
        const cached = ocrCache.getTranslation(key, boxKey);
        if (cached) {
          english = cached.translation;
        } else {
          overlay.setStatus({
            tone: "loading",
            title: "TRANSLATING",
            detail: "Japanese → English",
            indeterminate: true,
          });

          const result = await translator.translateJapanese(region.japanese);
          english = result.translation;
          ocrCache.setTranslation(key, boxKey, {
            japanese: region.japanese,
            translation: english,
          });
        }

        if (!english || !element.isConnected) continue;

        overlay.addPanel(`${key}#${i}`, element, region.box, english);
        translatedCount++;
      }

      console.log(
        `[Rikai] ${key}: ${regionList.length} region(s) detected, ${translatedCount} translated.`
      );
    } catch (err) {
      console.warn(`[Rikai] Failed to process an image:`, err);
    } finally {
      if (queue.pendingCount === 0 && state.phase === "PROCESSING") {
        setPhase("READY");
        overlay.setStatus({
          tone: "success",
          title: "TRANSLATION COMPLETE",
        });
        setTimeout(() => {
          if (state.phase === "READY") overlay.hideStatus();
        }, 1400);
      }
    }
  }

  async function buildImageRef(record: ImageRecord): Promise<ImageRef | null> {
    const src = record.src || "";

    if (src.startsWith("data:")) {
      return { kind: "dataurl", value: src };
    }

    if (src.startsWith("blob:") || isSameOrigin(src)) {
      try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const dataUrl = await blobToDataUrl(blob);
        return { kind: "dataurl", value: dataUrl };
      } catch (err) {
        console.warn("[Rikai] Local fetch failed, falling back to URL:", err);
      }
    }

    if (/^https?:\/\//i.test(src)) {
      return { kind: "url", value: src };
    }

    return null;
  }

  function isSameOrigin(url: string): boolean {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Failed to read image."));
      reader.readAsDataURL(blob);
    });
  }

  // ─── Page teardown ───────────────────────────────────────────────────

  window.addEventListener("beforeunload", () => {
    queue.cancel();
    stopWatching();
    overlay.deactivate();
  });

  console.log("[Rikai] Content script loaded — waiting for activation.");
})();
