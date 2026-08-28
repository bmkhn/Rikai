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
  percent?: number;
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
  let engineReady = false;

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

        case "RIKAI_AUTO_INIT":
          initEngine().catch((err: Error) => {
            console.error("[Rikai] Auto-init failed:", err);
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

  // ─── Engine initialization (runs regardless of toggle state) ────
  // The OCR model lives in the offscreen document and persists across pages.
  // We check IS_READY first so pages that load after the model is already
  // warm skip the LOADING phase entirely — no flicker in the popup.

  async function initEngine(): Promise<void> {
    if (engineReady) return;
    if (state.phase === "LOADING") return; // already in progress

    // Check if model files are available in storage
    try {
      const result = await chrome.storage.local.get(["rikaiModelReady"]);
      if (!result.rikaiModelReady) {
        console.log("[Rikai] Model files not downloaded yet, skipping engine init.");
        return;
      }
    } catch {
      // storage unavailable — try anyway
    }

    // Fast path: ask the offscreen document if the model is already loaded.
    try {
      await chrome.runtime.sendMessage({ type: "RIKAI_ENSURE_OFFSCREEN" });
      const res = await chrome.runtime.sendMessage({
        target: "rikai-offscreen",
        type: "IS_READY",
        requestId: 0,
      });
      if (res?.ready) {
        engineReady = true;
        setPhase("READY");
        showEngineReadyNotification();
        console.log("[Rikai] Engine already loaded in offscreen — ready immediately.");
        return;
      }
      if (res?.loading) {
        console.log("[Rikai] Engine is loading in offscreen — waiting…");
        setPhase("LOADING");
        // ocr.initialize() will piggyback on the existing offscreen load
      }
    } catch {
      // offscreen not reachable — fall through to full init
    }

    // Slow path: model needs to be loaded from cache/network.
    // If already loading in offscreen, ocr.initialize() will wait on the
    // existing initPromise instead of starting a second parallel load.
    const t0 = performance.now();
    console.log("[Rikai] Initializing OCR engine in background…");
    if (state.phase !== "LOADING") setPhase("LOADING");

    try {
      await ocr.initialize((_p: InitProgress) => {
        // Progress is forwarded to background via STATE_UPDATE
      });

      engineReady = true;
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      console.log(`[Rikai] Engine initialized in ${elapsed}s`);
      setPhase("READY");
      showEngineReadyNotification();
    } catch (err: any) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      console.error(`[Rikai] Engine init failed after ${elapsed}s:`, err);
      setPhase("ERROR", String(err?.message || err));
    }
  }

  // ─── In-page notification ─────────────────────────────────────────
  // Lightweight toast that appears once when the engine becomes ready.
  // Popup already shows the loading state — this just confirms on the page.

  function showEngineReadyNotification(): void {
    try {
      const el = document.createElement("div");
      el.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0">
          <circle cx="8" cy="8" r="7" stroke="#22d3ee" stroke-width="1.5"/>
          <path d="M5 8.5 7 10.5 11 6" stroke="#34d399" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span style="font-weight:700;color:#22d3ee">RIKAI</span>
        <span style="color:#7c89a6;margin:0 4px">—</span>
        <span style="color:#34d399">Engine ready</span>
      `;
      Object.assign(el.style, {
        position: "fixed",
        bottom: "16px",
        right: "16px",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 14px",
        background: "rgba(11, 17, 32, 0.92)",
        border: "1px solid rgba(94, 234, 212, 0.28)",
        borderRadius: "8px",
        color: "#e6edf7",
        fontSize: "12px",
        fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
        letterSpacing: "0.08em",
        zIndex: "2147483000",
        opacity: "0",
        transition: "opacity 300ms ease",
        pointerEvents: "none",
        boxShadow: "0 0 12px rgba(34, 211, 238, 0.22)",
      });
      document.documentElement.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = "1"; });
      setTimeout(() => {
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 350);
      }, 2500);
    } catch {
      // non-critical — ignore
    }
  }

  // ─── Activation lifecycle ────────────────────────────────────────────

  async function activate(): Promise<void> {
    if (state.phase === "PROCESSING") return; // pipeline already running
    if (state.phase === "LOADING") return;    // engine still loading

    // Ensure the engine is initialized first
    if (!engineReady) {
      await initEngine();
      if (!engineReady) {
        setError(
          "INITIALIZATION FAILED",
          "OCR engine could not be initialized."
        );
        return;
      }
    }

    console.log("[Rikai] Activating pipeline…");

    overlay.activate();
    setPhase("READY");
    startPipeline();
    console.log("[Rikai] Pipeline activated.");
  }

  function deactivate(): void {
    console.log("[Rikai] Deactivating pipeline.");
    queue.cancel();
    stopWatching();
    extractor.disconnect();
    overlay.clear();
    overlay.deactivate();
    overlay.hideStatus();
    seenImages.clear();
    // Keep engine loaded — just stop the pipeline
    setPhase(engineReady ? "READY" : "OFF");
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

  // ─── Auto-initialize engine on load (independent of toggle) ────
  // After the engine is ready, check if the toggle was on before navigation
  // and auto-start the pipeline so the translator state persists per-tab.
  console.log("[Rikai] Content script loaded — auto-initializing engine…");
  initEngine()
    .then(() => {
      chrome.runtime
        .sendMessage({ type: "RIKAI_GET_TAB_STATE" })
        .then((tabState: any) => {
          if (tabState?.state === "PROCESSING") {
            console.log("[Rikai] Toggle was on — auto-starting pipeline.");
            activate().catch((err: Error) => {
              console.error("[Rikai] Auto-activate failed:", err);
            });
          }
        })
        .catch(() => {});
    })
    .catch((err) => {
      console.warn("[Rikai] Auto-init failed:", err);
    });
})();
