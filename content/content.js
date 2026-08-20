// Rikai content script
// Receives messages from the popup and orchestrates extraction, OCR, translation, and overlay.

(() => {
  "use strict";

  // ─── State ──────────────────────────────────────────────────────────

  const state = {
    translationActive: false,
    /** @type {string} Selected language: "jpn", "kor", or "both" */
    lang: "jpn",
    /** @type {import('./image-extractor').ImageRecord[]} */
    extractedImages: [],
    /** @type {import('./ocr').OcrResult[]} */
    ocrResults: [],
    /** @type {import('./translator').BatchTranslationResult[]} */
    translations: [],
    /** @type {Set<string>} IDs of images that have been OCR'd */
    processedImageIds: new Set(),
  };

  // ─── Module Instances ───────────────────────────────────────────────

  /** @type {import('./image-extractor')} */
  const extractor = new window.RikaiImageExtractor();

  /** @type {import('./ocr').OcrEngine} */
  const ocrEngine = new window.RikaiOcrEngine();

  /** @type {import('./translator').Translator} */
  const translator = new window.RikaiTranslator();

  /** @type {import('./overlay').Overlay} */
  const overlay = new window.RikaiOverlay();

  // ─── Message Listener ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {
      case "translatePage":
        handleTranslatePage(message, sendResponse);
        return true;

      case "toggleTranslation":
        handleToggleTranslation(sendResponse);
        return true;

      case "scanImages":
        handleScanImages(sendResponse);
        return true;

      case "getExtractedImages":
        handleGetExtractedImages(sendResponse);
        return true;

      case "processOcr":
        handleProcessOcr(message, sendResponse);
        return true;

      case "getOcrResults":
        handleGetOcrResults(sendResponse);
        return true;

      case "processTranslation":
        handleProcessTranslation(message, sendResponse);
        return true;

      case "getTranslations":
        handleGetTranslations(sendResponse);
        return true;

      default:
        sendResponse({ success: false, message: `Unknown action: ${message.action}` });
    }
  });

  // ─── Handlers ───────────────────────────────────────────────────────

  /**
   * Handle the "translatePage" command.
   * Full pipeline: scan images → OCR → translate → render overlay.
   */
  async function handleTranslatePage(message, sendResponse) {
    console.log("[Rikai] Received 'translatePage' command.");

    // Store language selection
    state.lang = message.lang || "jpn";
    console.log(`[Rikai] Language: ${state.lang}`);

    try {
      // Step 1: Scan for images
      state.extractedImages = extractor.scan();
      extractor.observe();

      const imgCount = state.extractedImages.length;
      console.log(`[Rikai] Found ${imgCount} images.`);

      if (imgCount === 0) {
        sendResponse({
          success: true,
          message: "No manga images found on this page.",
          images: [],
          ocrResults: [],
          translations: [],
        });
        return;
      }

      // Step 2: Process OCR on all discovered images
      // Pass DOM elements (not URLs) so we can draw them to canvas and bypass CORS
      console.log("[Rikai] Starting OCR processing...");
      const imagesToProcess = state.extractedImages
        .filter((img) => img.element && img.element instanceof HTMLElement)
        .map((img) => ({
          id: img.id,
          element: img.element,
        }));

      state.ocrResults = await ocrEngine.recognizeImages(
        imagesToProcess,
        state.lang,
        (done, total) => {
          console.log(`[Rikai] OCR progress: ${done}/${total}`);
        }
      );

      // Track which images have been processed
      for (const result of state.ocrResults) {
        state.processedImageIds.add(result.imageId);
      }

      const totalRegions = state.ocrResults.reduce((sum, r) => sum + r.regions.length, 0);
      console.log(`[Rikai] OCR complete: ${totalRegions} text regions found.`);

      // Step 3: Translate all detected text
      if (totalRegions > 0) {
        console.log("[Rikai] Starting translation...");
        state.translations = await translator.translateOcrResults(
          state.ocrResults,
          (done, total) => {
            console.log(`[Rikai] Translation progress: ${done}/${total}`);
          }
        );

        const successfulTranslations = state.translations.filter((t) => t.translation.success);
        console.log(
          `[Rikai] Translation complete: ${successfulTranslations.length}/${state.translations.length} successful.`
        );

        // Step 4: Render overlays
        if (successfulTranslations.length > 0) {
          console.log("[Rikai] Rendering translation overlays...");
          overlay.render(
            state.translations,
            state.extractedImages,
            state.ocrResults
          );
          state.translationActive = true;
        }
      } else {
        state.translations = [];
        console.log("[Rikai] No text regions to translate.");
      }

      // Build summary
      const ocrTime = state.ocrResults.reduce((sum, r) => sum + r.processingTime, 0);
      const overlayCount = overlay.isVisible() ? state.translations.filter((t) => t.translation.success).length : 0;
      const summary = `${imgCount} images, ${totalRegions} text regions, ${state.translations.length} translations, ${overlayCount} overlays`;

      sendResponse({
        success: true,
        message: summary,
        images: state.extractedImages.map((img) => ({
          id: img.id,
          src: img.src,
          width: img.width,
          height: img.height,
          source: img.source,
        })),
        ocrResults: state.ocrResults.map((r) => ({
          imageId: r.imageId,
          regionCount: r.regions.length,
          regions: r.regions,
          lang: r.imageLang,
        })),
        translations: state.translations.map((t) => ({
          imageId: t.imageId,
          regionIndex: t.regionIndex,
          original: t.translation.originalText,
          translated: t.translation.translatedText,
          success: t.translation.success,
          confidence: t.translation.confidence,
        })),
      });
    } catch (err) {
      console.error("[Rikai] Translation pipeline failed:", err);
      sendResponse({
        success: false,
        message: `Error: ${err.message}`,
      });
    }
  }

  /**
   * Handle "toggleTranslation" — show/hide translation overlay.
   * Does NOT re-run OCR or translation — just toggles visibility.
   */
  function handleToggleTranslation(sendResponse) {
    const isVisible = overlay.toggle();
    state.translationActive = isVisible;

    console.log(`[Rikai] Translation toggled: ${isVisible ? "ON" : "OFF"}`);

    sendResponse({
      success: true,
      message: `Translation ${isVisible ? "enabled" : "disabled"}.`,
      active: isVisible,
    });
  }

  /**
   * Handle "scanImages" — re-scan without OCR.
   */
  function handleScanImages(sendResponse) {
    console.log("[Rikai] Received 'scanImages' command.");
    state.extractedImages = extractor.scan();

    sendResponse({
      success: true,
      message: `Found ${state.extractedImages.length} images.`,
      images: state.extractedImages.map((img) => ({
        id: img.id,
        src: img.src,
        width: img.width,
        height: img.height,
        source: img.source,
        isLazy: img.isLazy,
        isBackground: img.isBackground,
      })),
    });
  }

  /**
   * Handle "getExtractedImages" — return currently tracked images.
   */
  function handleGetExtractedImages(sendResponse) {
    const images = extractor.getImages();
    sendResponse({
      success: true,
      images: images.map((img) => ({
        id: img.id,
        src: img.src,
        width: img.width,
        height: img.height,
        source: img.source,
        isLazy: img.isLazy,
        isBackground: img.isBackground,
      })),
    });
  }

  /**
   * Handle "processOcr" — run OCR on specific images or re-process all.
   */
  async function handleProcessOcr(message, sendResponse) {
    console.log("[Rikai] Received 'processOcr' command.");

    try {
      const imageIds = message.imageIds;

      let imagesToProcess;
      if (imageIds && imageIds.length > 0) {
        imagesToProcess = state.extractedImages
          .filter((img) => imageIds.includes(img.id) && img.element instanceof HTMLElement)
          .map((img) => ({ id: img.id, element: img.element }));
      } else {
        imagesToProcess = state.extractedImages
          .filter((img) => !state.processedImageIds.has(img.id) && img.element instanceof HTMLElement)
          .map((img) => ({ id: img.id, element: img.element }));
      }

      if (imagesToProcess.length === 0) {
        sendResponse({
          success: true,
          message: "No new images to process.",
          ocrResults: [],
        });
        return;
      }

      const results = await ocrEngine.recognizeImages(imagesToProcess);

      // Update state
      for (const result of results) {
        state.processedImageIds.add(result.imageId);
        const existingIdx = state.ocrResults.findIndex((r) => r.imageId === result.imageId);
        if (existingIdx >= 0) {
          state.ocrResults[existingIdx] = result;
        } else {
          state.ocrResults.push(result);
        }
      }

      sendResponse({
        success: true,
        message: `Processed ${results.length} images.`,
        ocrResults: results.map((r) => ({
          imageId: r.imageId,
          regionCount: r.regions.length,
          regions: r.regions,
          lang: r.imageLang,
        })),
      });
    } catch (err) {
      console.error("[Rikai] OCR processing failed:", err);
      sendResponse({
        success: false,
        message: `Error: ${err.message}`,
      });
    }
  }

  /**
   * Handle "getOcrResults" — return cached OCR results.
   */
  function handleGetOcrResults(sendResponse) {
    sendResponse({
      success: true,
      ocrResults: state.ocrResults.map((r) => ({
        imageId: r.imageId,
        regionCount: r.regions.length,
        regions: r.regions,
        lang: r.imageLang,
      })),
    });
  }

  /**
   * Handle "processTranslation" — translate OCR results (re-translate or specific regions).
   */
  async function handleProcessTranslation(message, sendResponse) {
    console.log("[Rikai] Received 'processTranslation' command.");

    try {
      const imageIds = message.imageIds;

      let ocrResultsToTranslate;
      if (imageIds && imageIds.length > 0) {
        ocrResultsToTranslate = state.ocrResults.filter((r) =>
          imageIds.includes(r.imageId)
        );
      } else {
        ocrResultsToTranslate = state.ocrResults;
      }

      if (ocrResultsToTranslate.length === 0) {
        sendResponse({
          success: true,
          message: "No OCR results to translate.",
          translations: [],
        });
        return;
      }

      const translations = await translator.translateOcrResults(ocrResultsToTranslate);

      // Update state
      for (const t of translations) {
        const existingIdx = state.translations.findIndex(
          (existing) =>
            existing.imageId === t.imageId && existing.regionIndex === t.regionIndex
        );
        if (existingIdx >= 0) {
          state.translations[existingIdx] = t;
        } else {
          state.translations.push(t);
        }
      }

      // Re-render overlays with updated translations
      const successfulTranslations = state.translations.filter((t) => t.translation.success);
      if (successfulTranslations.length > 0) {
        overlay.render(state.translations, state.extractedImages, state.ocrResults);
        state.translationActive = true;
      }

      sendResponse({
        success: true,
        message: `Translated ${translations.length} text regions.`,
        translations: translations.map((t) => ({
          imageId: t.imageId,
          regionIndex: t.regionIndex,
          original: t.translation.originalText,
          translated: t.translation.translatedText,
          success: t.translation.success,
          confidence: t.translation.confidence,
        })),
      });
    } catch (err) {
      console.error("[Rikai] Translation processing failed:", err);
      sendResponse({
        success: false,
        message: `Error: ${err.message}`,
      });
    }
  }

  /**
   * Handle "getTranslations" — return cached translations.
   */
  function handleGetTranslations(sendResponse) {
    sendResponse({
      success: true,
      translations: state.translations.map((t) => ({
        imageId: t.imageId,
        regionIndex: t.regionIndex,
        original: t.translation.originalText,
        translated: t.translation.translatedText,
        success: t.translation.success,
        confidence: t.translation.confidence,
      })),
    });
  }

  // ─── Cleanup ────────────────────────────────────────────────────────

  // Clean up overlays when the page unloads
  window.addEventListener("beforeunload", () => {
    overlay.clear();
    ocrEngine.terminate();
  });

  console.log("[Rikai] Content script loaded.");
})();
