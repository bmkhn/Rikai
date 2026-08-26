// Rikai Offscreen Document — OCR orchestration

interface OffscreenMessage {
  target?: string;
  type?: string;
  requestId?: number;
  payload?: {
    image?: { kind: "url" | "dataurl"; value: string };
    requestId?: number;
  };
}

interface OffscreenResponse {
  source: string;
  requestId: number | null;
  type?: string;
  regions?: OcrRegion[];
  error?: string;
  phase?: string;
  percent?: number;
  [key: string]: any;
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

(() => {
  "use strict";

  const SOURCE = "rikai-offscreen";
  const detector = new (window as any).RikaiTextDetector();

  let workChain: Promise<void> = Promise.resolve();

  // ─── Messaging ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener(
    (
      message: OffscreenMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: any) => void
    ) => {
      if (!message || message.target !== SOURCE) return undefined;

      const { type, requestId } = message;

      if (type === "INIT") {
        handleInit(requestId ?? 0, sendResponse);
        return true;
      }

      if (type === "PROCESS_IMAGE") {
        const payload = message.payload || {};
        workChain = workChain
          .then(() => handleProcessImage(payload, sendResponse))
          .catch((err: Error) => {
            console.error("[Rikai OCR] Pipeline error:", err);
            respond(sendResponse, requestId ?? null, {
              type: "ERROR",
              phase: "process",
              error: String(err?.message || err),
            });
          });
        return true;
      }

      respond(sendResponse, requestId ?? null, {
        type: "ERROR",
        error: `Unknown offscreen request type: ${type}`,
      });
      return false;
    }
  );

  function respond(
    sendResponse: (response?: any) => void,
    requestId: number | null,
    extra: Record<string, any>
  ): void {
    try {
      sendResponse({ source: SOURCE, requestId: requestId ?? null, ...extra });
    } catch {
      // Port closed
    }
  }

  // ─── INIT ────────────────────────────────────────────────────────────

  async function handleInit(
    requestId: number,
    sendResponse: (response?: any) => void
  ): Promise<void> {
    const t0 = performance.now();
    try {
      if (!(window as any).RikaiMangaOcr) {
        throw new Error("MangaOCR bundle not loaded.");
      }
      await (window as any).RikaiMangaOcr.init((p: any) => {
        // Broadcast progress so background can write to storage for popup polling
        chrome.runtime
          .sendMessage({ source: SOURCE, type: "PROGRESS", ...p })
          .catch(() => {});
      });
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      console.log(`[Rikai OCR] Model ready in ${elapsed}s`);
      respond(sendResponse, requestId, { type: "READY" });
    } catch (err: any) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      console.error(`[Rikai OCR] Initialization failed after ${elapsed}s:`, err);
      respond(sendResponse, requestId, {
        type: "ERROR",
        phase: "init",
        error: String(err?.message || err),
      });
    }
  }

  // ─── PROCESS_IMAGE ───────────────────────────────────────────────────

  async function handleProcessImage(
    payload: any,
    sendResponse: (response?: any) => void
  ): Promise<void> {
    const requestId = payload.requestId;
    const t0 = performance.now();

    try {
      if (!(window as any).RikaiMangaOcr) {
        throw new Error("MangaOCR bundle not loaded.");
      }

      const image = await loadImage(payload.image);

      const boxes: BBox[] = detector.detect(image);

      const regions: OcrRegion[] = [];
      for (const box of boxes) {
        try {
          const dataUrl = await cropToDataUrl(image, box);
          const japanese: string = await (window as any).RikaiMangaOcr.recognize(dataUrl);
          if (!japanese) continue;

          const confidence = japaneseQuality(japanese);
          if (confidence <= 0.5) continue;

          regions.push({ box, japanese, confidence });
        } catch (err) {
          console.warn("[Rikai OCR] Region failed:", err);
        }
      }

      if (
        image &&
        typeof (image as any).close === "function" &&
        !(image instanceof HTMLImageElement)
      ) {
        (image as any).close();
      }

      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      console.log(
        `[Rikai OCR] Image processed in ${elapsed}s — ${regions.length} region(s)`
      );
      respond(sendResponse, requestId, { type: "RESULT", regions });
    } catch (err: any) {
      console.error("[Rikai OCR] Process failed:", err);
      respond(sendResponse, requestId, {
        type: "ERROR",
        phase: "process",
        error: String(err?.message || err),
      });
    }
  }

  interface BBox {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  async function loadImage(ref: ImageRef): Promise<HTMLImageElement> {
    if (!ref || !ref.value) throw new Error("No image reference provided.");

    let url = ref.value;
    if (ref.kind === "url") {
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
    } catch (err: any) {
      URL.revokeObjectURL(url);
      throw new Error(`Image decode failed: ${err?.message || err}`);
    }
    if (url.startsWith("blob:")) {
      img.addEventListener("load", () => {}, { once: true });
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    return img;
  }

  async function cropToDataUrl(
    image: HTMLImageElement,
    box: BBox
  ): Promise<string> {
    const naturalW = image.naturalWidth || (image as any).width;
    const naturalH = image.naturalHeight || (image as any).height;

    const x = Math.max(0, Math.min(box.x, naturalW - 1));
    const y = Math.max(0, Math.min(box.y, naturalH - 1));
    const w = Math.max(1, Math.min(box.width, naturalW - x));
    const h = Math.max(1, Math.min(box.height, naturalH - y));

    const minSide = Math.min(w, h);
    const scale = minSide < 64 ? Math.min(4, 64 / minSide) : 1;

    const canvas = new OffscreenCanvas(
      Math.round(w * scale),
      Math.round(h * scale)
    );
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return blobToDataUrl(blob);
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Failed to encode crop."));
      reader.readAsDataURL(blob);
    });
  }

  function japaneseQuality(text: string): number {
    if (!text) return 0;
    const jpChars = text.match(/[\u3040-\u30ff\u4e00-\u9fff\u3005\u3006]/g);
    return (jpChars?.length ?? 0) / text.length;
  }
})();
