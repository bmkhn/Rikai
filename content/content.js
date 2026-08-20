// Rikai content script
// Receives messages from the popup and orchestrates extraction, OCR, and translation.

(() => {
  "use strict";

  // ─── State ──────────────────────────────────────────────────────────

  const state = {
    translationActive: false,
    /** @type {import('./image-extractor').ImageRecord[]} */
    extractedImages: [],
    /** @type {import('./ocr').OcrResult[]} */
    ocrResults: [],
    /** @type {Set<string>} IDs of images that have been OCR'd */
    processedImageIds: new Set(),
  };

  // ─── Module Instances ───────────────────────────────────────────────

  /** @type {import('./image-extractor')} */
  const extractor = new window.RikaiImageExtractor();

  /** @type {import('./ocr').OcrEngine} */
  const ocrEngine = new window.RikaiOcrEngine();

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

      default:
        sendResponse({ success: false, message: `Unknown action: ${message.action}` });
    }
  });

  // ─── Handlers ───────────────────────────────────────────────────────

  /**
   * Handle the "translatePage" command.
   * 1. Scans for images
   * 2. Processes OCR on discovered images
   * 3. Reports results (translation pipeline will be added later)
   */
  async function handleTranslatePage(message, sendResponse) {
    console.log("[Rikai] Received 'translatePage' command.");

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
        });
        return;
      }

      // Step 2: Process OCR on all discovered images
      console.log("[Rikai] Starting OCR processing...");
      const imagesToProcess = state.extractedImages.map((img) => ({
        id: img.id,
        src: img.src,
      }));

      state.ocrResults = await ocrEngine.recognizeImages(imagesToProcess, (done, total) => {
        console.log(`[Rikai] OCR progress: ${done}/${total}`);
      });

      // Track which images have been processed
      for (const result of state.ocrResults) {
        state.processedImageIds.add(result.imageId);
      }

      // Step 3: Report results
      const totalRegions = state.ocrResults.reduce((sum, r) => sum + r.regions.length, 0);
      const totalTime = state.ocrResults.reduce((sum, r) => sum + r.processingTime, 0);

      const summary = `${imgCount} images, ${totalRegions} text regions detected (${(totalTime / 1000).toFixed(1)}s)`;

      console.log(`[Rikai] OCR complete: ${summary}`);
      console.log(
        "[Rikai] Text regions:",
        state.ocrResults.flatMap((r) =>
          r.regions.map((reg) => ({
            text: reg.text.substring(0, 30),
            confidence: reg.confidence.toFixed(2),
            lang: reg.lang,
          }))
        )
      );

      state.translationActive = true;

      sendResponse({
        success: true,
        message: `Extracted ${summary}. Translation pipeline not yet implemented.`,
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
      });
    } catch (err) {
      console.error("[Rikai] Translation failed:", err);
      sendResponse({
        success: false,
        message: `Error: ${err.message}`,
      });
    }
  }

  /**
   * Handle "toggleTranslation" — show/hide translation overlay.
   * Placeholder for future overlay toggle.
   */
  function handleToggleTranslation(sendResponse) {
    state.translationActive = !state.translationActive;
    console.log(`[Rikai] Translation toggled: ${state.translationActive ? "ON" : "OFF"}`);

    // Future: toggle visibility of translation overlay elements
    // For now, just log the state

    sendResponse({
      success: true,
      message: `Translation ${state.translationActive ? "enabled" : "disabled"}.`,
      active: state.translationActive,
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
      const imageIds = message.imageIds; // Optional: specific images to process

      let imagesToProcess;
      if (imageIds && imageIds.length > 0) {
        // Process specific images
        imagesToProcess = state.extractedImages
          .filter((img) => imageIds.includes(img.id))
          .map((img) => ({ id: img.id, src: img.src }));
      } else {
        // Process all unprocessed images
        imagesToProcess = state.extractedImages
          .filter((img) => !state.processedImageIds.has(img.id))
          .map((img) => ({ id: img.id, src: img.src }));
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
        // Replace existing result or add new one
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

  console.log("[Rikai] Content script loaded.");
})();
