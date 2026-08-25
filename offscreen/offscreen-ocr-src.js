// Rikai MangaOCR engine (bundled with esbuild into dist/offscreen-ocr.js)
//
// Wraps onnx-community/manga-ocr-base-ONNX via @huggingface/transformers'
// image-to-text pipeline (VisionEncoderDecoder). Runs entirely in the browser
// through ONNX Runtime Web (WASM). Model weights are downloaded from the
// Hugging Face Hub on first use and cached by Transformers.js in Cache Storage.

import { pipeline, env, RawImage } from "@huggingface/transformers";

// Tiny blank image used for a one-shot warm-up inference after load.
const WARMUP_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const MODEL_ID = "onnx-community/manga-ocr-base-ONNX";

// Extension pages are not cross-origin isolated, so WASM threading is off.
env.backends.onnx.wasm.numThreads = 1;
// Load the ORT wasm binaries from the extension itself — no remote code.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/");
env.allowLocalModels = false;
env.useBrowserCache = true;

/** @type {Promise<import('@huggingface/transformers').ImageToTextPipeline> | null} */
let pipePromise = null;

/**
 * Aggregate download progress across model files into one rich progress event.
 * @param {(p: {percent:number, loadedMB:number, totalMB:number, file:string, downloading:boolean}) => void} onProgress
 */
function createProgressTracker(onProgress) {
  const files = new Map(); // file -> { loaded, total }
  let lastPercent = -1;
  const state = { sawDownload: false };

  const callback = (data) => {
    if (!data || typeof data !== "object") return;

    if (data.status === "progress" && data.file && data.total) {
      state.sawDownload = true;
      files.set(data.file, { loaded: data.loaded || 0, total: data.total });
    } else if (data.status === "done" && data.file) {
      const entry = files.get(data.file);
      if (entry && entry.total) entry.loaded = entry.total;
    }

    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }

    if (total > 0) {
      const percent = Math.floor((loaded / total) * 100);
      if (percent !== lastPercent || sawDownload) {
        lastPercent = percent;
        onProgress({
          percent,
          loadedMB: Math.round(loaded / 1048576),
          totalMB: Math.round(total / 1048576),
          file: data.file || "",
          downloading: true,
        });
      }
    }
  };

  callback.didDownload = () => state.sawDownload;
  return callback;
}

async function getPipeline() {
  if (pipePromise) return pipePromise;

  pipePromise = (async () => {
    // Preferred: quantized q8 weights (much smaller download, faster on WASM).
    try {
      return await pipeline("image-to-text", MODEL_ID, {
        dtype: "q8",
        device: "wasm",
      });
    } catch (err) {
      console.warn(
        "[Rikai OCR] Quantized weights unavailable, falling back to fp32:",
        err?.message || err
      );
      return await pipeline("image-to-text", MODEL_ID, {
        device: "wasm",
      });
    }
  })().catch((err) => {
    pipePromise = null; // allow retry after a failure
    throw err;
  });

  return pipePromise;
}

window.RikaiMangaOcr = {
  /**
   * Load (and cache) the MangaOCR model.
   * @param {(p: { percent: number, file?: string }) => void} [onProgress]
   */
  async init(onProgress = () => {}) {
    if (!pipePromise) {
      const tracker = createProgressTracker(onProgress);
      pipePromise = pipeline("image-to-text", MODEL_ID, {
        dtype: "q8",
        device: "wasm",
        progress_callback: tracker,
      })
        .catch((err) => {
          pipePromise = null;
          throw err;
        })
        .then(async (pipe) => {
          // No download events means weights came from Cache Storage.
          // Warm-up inference so the first real crop isn't the slow one.
          onProgress({ phase: "warmup" });
          try {
            const blank = await RawImage.fromURL(WARMUP_PNG);
            await pipe(blank, { max_new_tokens: 2 });
          } catch {
            /* warm-up is best-effort */
          }
          onProgress({ phase: "done", fromCache: !tracker.didDownload() });
          return pipe;
        });
    }
    await pipePromise;
    return true;
  },

  isReady() {
    return pipePromise !== null;
  },

  /**
   * Recognize Japanese text in a single cropped region.
   * @param {string} imageDataUrl - PNG data URL of the crop
   * @returns {Promise<string>} recognized Japanese text
   */
  async recognize(imageDataUrl) {
    const pipe = await getPipeline();
    const output = await pipe(imageDataUrl, { max_new_tokens: 96 });
    const first = Array.isArray(output) ? output[0] : output;
    return String(first?.generated_text ?? "").trim();
  },
};
