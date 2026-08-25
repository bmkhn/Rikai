// Rikai Offscreen Document — OCR orchestration
//
// Receives requests from content scripts, decodes manga images, detects text
// regions (RikaiTextDetector), crops them, and runs each crop through the
// bundled MangaOCR engine (window.RikaiMangaOcr from dist/offscreen-ocr.js).
//
// Message protocol (chrome.runtime):
//   Content -> here:  { target: "rikai-offscreen", type: "INIT"|"PROCESS_IMAGE", requestId, payload }
//   Here -> sender:   { source: "rikai-offscreen", requestId, type: "PROGRESS"|"READY"|"RESULT"|"ERROR", ... }
//
// Inference requests are serialized — the WASM runtime processes one at a time.

(() => {
  "use strict";

  const SOURCE = "rikai-offscreen";
  const detector = new window.RikaiTextDetector();

  /** Serializes PROCESS_IMAGE handling so the model never runs concurrently. */
  let workChain = Promise.resolve();

  // ─── Messaging ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== SOURCE) return undefined;

    const { type, requestId } = message;

    if (type === "INIT") {
      handleInit(requestId, sendResponse);
      return true; // async response
    }

    if (type === "PROCESS_IMAGE") {
      const payload = message.payload || {};
      workChain = workChain
        .then(() => handleProcessImage(payload, sendResponse))
        .catch((err) => {
          console.error("[Rikai OCR] Pipeline error:", err);
          respond(sendResponse, requestId, {
            type: "ERROR",
            phase: "process",
            error: String(err?.message || err),
          });
        });
      return true; // async response
    }

    respond(sendResponse, requestId, {
      type: "ERROR",
      error: `Unknown offscreen request type: ${type}`,
    });
    return false;
  });

  function respond(sendResponse, requestId, extra) {
    try {
      sendResponse({ source: SOURCE, requestId: requestId ?? null, ...extra });
    } catch {
      // Port closed (e.g. page navigated) — nothing to do.
    }
  }

  // ─── INIT ────────────────────────────────────────────────────────────

  async function handleInit(requestId, sendResponse) {
    try {
      if (!window.RikaiMangaOcr) {
        throw new Error("MangaOCR bundle not loaded.");
      }
      await window.RikaiMangaOcr.init((p) =>
        respond(sendResponse, null, { type: "PROGRESS", phase: "model-load", ...p })
      );
      respond(sendResponse, requestId, { type: "READY" });
    } catch (err) {
      console.error("[Rikai OCR] Initialization failed:", err);
      respond(sendResponse, requestId, {
        type: "ERROR",
        phase: "init",
        error: String(err?.message || err),
      });
    }
  }

  // ─── PROCESS_IMAGE ───────────────────────────────────────────────────

  /**
   * Full pipeline for one manga image:
   * decode → detect regions → crop each region → MangaOCR → Japanese text.
   */
  async function handleProcessImage(payload, sendResponse) {
    const requestId = payload.requestId;

    try {
      if (!window.RikaiMangaOcr) {
        throw new Error("MangaOCR bundle not loaded.");
      }

      const image = await loadImage(payload.image);

      // Text detection (where is the text?)
      const boxes = detector.detect(image);

      // Recognition (what does it say?) — one crop at a time
      /** @type {{ box: any, japanese: string, confidence: number }[]} */
      const regions = [];
      for (const box of boxes) {
        try {
          const dataUrl = await cropToDataUrl(image, box);
          const japanese = await window.RikaiMangaOcr.recognize(dataUrl);
          if (!japanese) continue;

          const confidence = japaneseQuality(japanese);
          if (confidence <= 0.5) continue; // mostly non-Japanese noise

          regions.push({ box, japanese, confidence });
        } catch (err) {
          console.warn("[Rikai OCR] Region failed:", err);
        }
      }

      // Release the decoded image promptly
      if (image.close && typeof image.close === "function" && !(image instanceof HTMLImageElement)) {
        image.close();
      }

      respond(sendResponse, requestId, { type: "RESULT", regions });
    } catch (err) {
      console.error("[Rikai OCR] Process failed:", err);
      respond(sendResponse, requestId, {
        type: "ERROR",
        phase: "process",
        error: String(err?.message || err),
      });
    }
  }

  /**
   * Load an image reference into a decodable element.
   * @param {{ kind: "url"|"dataurl", value: string }} ref
   * @returns {Promise<HTMLImageElement>}
   */
  async function loadImage(ref) {
    if (!ref || !ref.value) throw new Error("No image reference provided.");

    let url = ref.value;
    if (ref.kind === "url") {
      // Extension host permissions allow reading cross-origin images here.
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Image fetch failed: HTTP ${response.status}`);
      }
      const blob = await response.blob();
      url = URL.createObjectURL(blob);
    }

    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch (err) {
      URL.revokeObjectURL(url);
      throw new Error(`Image decode failed: ${err?.message || err}`);
    }
    if (url.startsWith("blob:")) {
      // Keep the object URL alive until decoding is done, then release it.
      img.addEventListener("load", () => {}, { once: true });
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    return img;
  }

  /**
   * Crop a region from the image and return a PNG data URL.
   * Small crops are upscaled so the recognizer gets enough pixels to work with
   * (the model's processor resizes to 224×224 internally).
   */
  async function cropToDataUrl(image, box) {
    const naturalW = image.naturalWidth || image.width;
    const naturalH = image.naturalHeight || image.height;

    // Clamp the box defensively
    const x = Math.max(0, Math.min(box.x, naturalW - 1));
    const y = Math.max(0, Math.min(box.y, naturalH - 1));
    const w = Math.max(1, Math.min(box.width, naturalW - x));
    const h = Math.max(1, Math.min(box.height, naturalH - y));

    // Upscale small crops so short text stays legible after processor resize
    const minSide = Math.min(w, h);
    const scale = minSide < 64 ? Math.min(4, 64 / minSide) : 1;

    const canvas = new OffscreenCanvas(
      Math.round(w * scale),
      Math.round(h * scale)
    );
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return blobToDataUrl(blob);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Failed to encode crop."));
      reader.readAsDataURL(blob);
    });
  }

  function url_revokePlaceholder() {}

  /**
   * Rough quality signal: fraction of characters that are actual Japanese.
   * MangaOCR has no native confidence score, so we report how much of its
   * output is kana/kanji. This is NOT a fabricated percentage of accuracy.
   */
  function japaneseQuality(text) {
    if (!text) return 0;
    const jpChars = text.match(/[\u3040-\u30ff\u4e00-\u9fff\u3005\u3006]/g);
    return jpChars.length / text.length;
  }})();
