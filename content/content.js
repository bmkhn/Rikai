// Rikai Content Script — Translator Engine
//
// Owns the active state of the translator on this tab. The popup merely
// sends ACTIVATE/DEACTIVATE messages; once activated, Rikai keeps running
// here regardless of whether the popup stays open.
//
// Pipeline per manga image:
//   scan → visibility prioritization → [OCR engine: detect regions +
//   recognize Japanese] → translate ja→en → in-page overlay panels
//
// States reported to the background worker (mirrored for the popup):
//   OFF | LOADING | READY | PROCESSING | ERROR

(() => {
  "use strict";

  if (window.__rikaiContentLoaded) return;
  window.__rikaiContentLoaded = true;

  // ─── Modules ─────────────────────────────────────────────────────────

  const extractor = new window.RikaiImageExtractor();
  const ocr = new window.RikaiMangaOcrClient();
  const ocrCache = new window.RikaiOcrCache();
  const queue = new window.RikaiOcrQueue();
  const translator = new window.RikaiTranslator();
  const overlay = new window.RikaiOverlay();

  // ─── State ───────────────────────────────────────────────────────────

  const state = {
    phase: "OFF", // OFF | LOADING | READY | PROCESSING | ERROR
    detail: "",
  };

  /** @type {Set<string>} cache keys currently known */
  const seenImages = new Set();

  let watchIntervalId = null;
  let currentUrl = location.href;

  // ─── Messaging from popup ────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case "RIKAI_ACTIVATE":
        activate().catch((err) => {
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
  });

  function setPhase(phase, detail = "") {
    state.phase = phase;
    state.detail = detail;
    // Mirror state so a reopened popup shows reality
    chrome.runtime
      .sendMessage({
        target: "rikai-bg",
        type: "STATE_UPDATE",
        state: phase,
        detail,
      })
      .catch(() => {});
  }

  function setError(title, detail) {
    setPhase("ERROR", detail);
    overlay.setStatus({
      tone: "error",
      title,
      detail,
      onRetry: () => {
        overlay.hideStatus();
        activate().catch((err) =>
          setError("ACTIVATION FAILED", String(err?.message || err))
        );
      },
    });
  }

  // ─── Activation lifecycle ────────────────────────────────────────────

  async function activate() {
    if (state.phase === "LOADING" || state.phase === "READY" || state.phase === "PROCESSING") {
      return; // already active
    }

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
      // Lazy model load — streams real download progress when available
      await ocr.initialize((p) => {
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
          // First run only: real bytes, real percentage, honest expectations
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
        // fromCache / no-progress → keep the indeterminate panel as-is
      });

      setPhase("READY");
      overlay.setStatus({ tone: "success", title: "SYSTEM READY" });
      setTimeout(() => {
        if (state.phase !== "ERROR") overlay.hideStatus();
      }, 1200);

      startPipeline();
    } catch (err) {
      console.error("[Rikai] OCR init failed:", err);
      setError("OCR INITIALIZATION FAILED", "Unable to load the Japanese OCR model.");
    }
  }

  function deactivate() {
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

  function startPipeline() {
    // Initial scan
    const records = extractor.scan();
    extractor.observe();

    enqueueVisible(records);

    // Watch for new/lazy-loaded images, reader navigation and SPA changes
    watchIntervalId = setInterval(() => {
      if (state.phase === "ERROR") return;

      // SPA / reader navigation: reset per-page tracking, keep the model and
      // URL-keyed cache so nothing is recognized twice.
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

  function stopWatching() {
    if (watchIntervalId != null) {
      clearInterval(watchIntervalId);
      watchIntervalId = null;
    }
  }

  /**
   * Enqueue not-yet-processed images that are near or inside the viewport.
   * Visible pages get top priority; offscreen ones are skipped until they
   * approach (the interval watcher will pick them up later).
   */
  function enqueueVisible(records) {
    const vh = window.innerHeight;
    let enqueuedAny = false;

    for (const record of records) {
      if (!(record.element instanceof HTMLElement)) continue;
      if (!record.element.isConnected) continue;

      const key = ocrCache.key(record);
      if (seenImages.has(key)) continue;
      if (ocrCache.getRegions(key)) continue;

      const rect = record.element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      // Skip anything more than one viewport away
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

  /**
   * Full pipeline for one manga image.
   */
  async function processImageRecord(record, key) {
    const element = record.element;
    if (!element.isConnected || state.phase === "ERROR") return;

    try {
      overlay.setStatus({
        tone: "loading",
        title: "DETECTING TEXT",
        detail: "Scanning manga page",
        indeterminate: true,
      });

      // Cache hit?
      let regions = ocrCache.getRegions(key);

      if (!regions) {
        const imageRef = await buildImageRef(record);
        if (!imageRef) return;

        regions = await ocr.processImage(imageRef);
        ocrCache.setRegions(key, regions);
      }

      // Translate each region and render panels incrementally
      let translatedCount = 0;

      for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const boxKey = `${region.box.x},${region.box.y},${region.box.width},${region.box.height}`;

        let english;
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
        `[Rikai] ${key}: ${regions.length} region(s) detected, ${translatedCount} translated.`
      );
    } catch (err) {
      console.warn(`[Rikai] Failed to process an image:`, err);
    } finally {
      if (queue.pendingCount === 0 && state.phase === "PROCESSING") {
        setPhase("READY");
        overlay.setStatus({ tone: "success", title: "TRANSLATION COMPLETE" });
        setTimeout(() => {
          if (state.phase === "READY") overlay.hideStatus();
        }, 1400);
      }
    }
  }

  /**
   * Build an OCR-engine image reference for a record.
   * - data: URLs pass through directly
   * - blob:/same-origin sources are fetched here into data URLs
   * - http(s) URLs are fetched by the offscreen document (extension permissions)
   */
  async function buildImageRef(record) {
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

  function isSameOrigin(url) {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  function blobToDataUrl(blob) {
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
