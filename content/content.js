// Rikai content script
// Receives messages from the popup and performs actions on the page.

(() => {
  "use strict";

  // State for the current tab
  const state = {
    translationActive: false,
  };

  // Listen for messages from the popup (or background script)
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "translatePage") {
      handleTranslatePage(sendResponse);
      return true; // Keep the message channel open for async sendResponse
    }

    if (message.action === "toggleTranslation") {
      handleToggleTranslation(sendResponse);
      return true;
    }

    // Unknown action
    sendResponse({ success: false, message: `Unknown action: ${message.action}` });
  });

  /**
   * Handle the "translatePage" command from the popup.
   * For now, this is a skeleton that proves the communication works.
   */
  function handleTranslatePage(sendResponse) {
    console.log("[Rikai] Received 'translatePage' command.");

    // Placeholder: detect images on the page
    const images = document.querySelectorAll("img");
    console.log(`[Rikai] Found ${images.length} <img> elements on the page.`);

    state.translationActive = true;

    sendResponse({
      success: true,
      message: `Found ${images.length} images. Translation pipeline not yet implemented.`,
    });
  }

  /**
   * Handle the "toggleTranslation" command.
   * For now, just toggles state and logs.
   */
  function handleToggleTranslation(sendResponse) {
    state.translationActive = !state.translationActive;
    console.log(`[Rikai] Translation toggled: ${state.translationActive ? "ON" : "OFF"}`);

    sendResponse({
      success: true,
      message: `Translation ${state.translationActive ? "enabled" : "disabled"}.`,
    });
  }

  console.log("[Rikai] Content script loaded.");
})();
