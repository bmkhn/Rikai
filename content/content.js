// Rikai content script
// Receives messages from the popup and performs actions on the page.

(() => {
  "use strict";

  // ─── State ──────────────────────────────────────────────────────────

  const state = {
    translationActive: false,
    /** @type {import('./image-extractor').ImageRecord[]} */
    extractedImages: [],
  };

  /** @type {import('./image-extractor')} */
  const extractor = new window.RikaiImageExtractor();

  // ─── Message Listener ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {
      case "translatePage":
        handleTranslatePage(sendResponse);
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

      default:
        sendResponse({ success: false, message: `Unknown action: ${message.action}` });
    }
  });

  // ─── Handlers ───────────────────────────────────────────────────────

  /**
   * Handle the "translatePage" command.
   * Scans for images, sets up observation, and reports results.
   */
  function handleTranslatePage(sendResponse) {
    console.log("[Rikai] Received 'translatePage' command.");

    // Scan for images
    state.extractedImages = extractor.scan();

    // Start observing for dynamic content
    extractor.observe();

    state.translationActive = true;

    // Report summary
    const imgCount = state.extractedImages.filter((i) => i.source === "img" || i.source === "picture").length;
    const bgCount = state.extractedImages.filter((i) => i.source === "background").length;
    const canvasCount = state.extractedImages.filter((i) => i.source === "canvas").length;

    const parts = [];
    if (imgCount > 0) parts.push(`${imgCount} img`);
    if (bgCount > 0) parts.push(`${bgCount} background`);
    if (canvasCount > 0) parts.push(`${canvasCount} canvas`);

    const summary = parts.length > 0 ? parts.join(", ") : "no manga images found";

    console.log(`[Rikai] Extraction summary: ${summary}`);
    console.log(
      "[Rikai] All extracted images:",
      state.extractedImages.map((img) => ({
        src: img.src?.substring(0, 80),
        size: `${Math.round(img.width)}×${Math.round(img.height)}`,
        source: img.source,
        lazy: img.isLazy,
      }))
    );

    sendResponse({
      success: true,
      message: `Extracted ${state.extractedImages.length} images (${summary}). Translation pipeline not yet implemented.`,
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
   * Handle "toggleTranslation" — show/hide translation overlay.
   * Placeholder for future overlay toggle.
   */
  function handleToggleTranslation(sendResponse) {
    state.translationActive = !state.translationActive;
    console.log(`[Rikai] Translation toggled: ${state.translationActive ? "ON" : "OFF"}`);

    sendResponse({
      success: true,
      message: `Translation ${state.translationActive ? "enabled" : "disabled"}.`,
    });
  }

  /**
   * Handle "scanImages" — re-scan without starting observation.
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

  console.log("[Rikai] Content script loaded.");
})();
