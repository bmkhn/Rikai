// Rikai MangaOCR engine (bundled with esbuild into dist/offscreen-ocr.js)
//
// Uses Transformers.js ONLY for tokenizer and image processor.
// Encoder + decoder ONNX models are loaded directly via ONNX Runtime Web
// because the `pipeline()` API requires `decoder_model_merged.onnx` which
// doesn't exist in the onnx-community model repo.
//
// Model: onnx-community/manga-ocr-base-ONNX (encoder + decoder)
// Tokenizer/processor: NorwayFish/manga-ocr (has tokenizer.json)

import {
  AutoTokenizer,
  AutoImageProcessor,
  RawImage,
  env,
} from "@huggingface/transformers";
import * as ort from "onnxruntime-web";

// ─── Configuration ──────────────────────────────────────────────────

const TOKENIZER_REPO = "NorwayFish/manga-ocr";
const ENCODER_REPO = "onnx-community/manga-ocr-base-ONNX";
const DECODER_REPO = "onnx-community/manga-ocr-base-ONNX";

// Extension pages are not cross-origin isolated, so WASM threading is off.
ort.env.wasm.numThreads = 1;
// Load the ORT wasm binaries from the extension itself — no remote code.
ort.env.wasm.wasmPaths = chrome.runtime.getURL("dist/");

// Also configure Transformers.js to use our local wasm paths
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/");
env.allowLocalModels = false;
env.useBrowserCache = true;

// ─── State ──────────────────────────────────────────────────────────

/** @type {import("@huggingface/transformers").AutoTokenizer | null} */
let tokenizer = null;

/** @type {import("@huggingface/transformers").AutoImageProcessor | null} */
let imageProcessor = null;

/** @type {ort.InferenceSession | null} */
let encoderSession = null;

/** @type {ort.InferenceSession | null} */
let decoderSession = null;

let ready = false;

// ─── Helpers ────────────────────────────────────────────────────────

function baseUrl(repo, filename) {
  return `https://huggingface.co/${repo}/resolve/main/${filename}`;
}

/**
 * Fetch an ONNX model file, then create an ORT InferenceSession from it.
 */
async function loadOnnxSession(repo, filename, onProgress) {
  const url = baseUrl(repo, filename);

  // Fetch with progress tracking
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${filename}: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length")) || 0;
  if (contentLength > 0 && onProgress) {
    onProgress({
      phase: "download",
      file: filename,
      totalMB: Math.round(contentLength / 1048576),
    });
  }

  const buffer = await response.arrayBuffer();

  if (onProgress) {
    onProgress({ phase: "load", file: filename });
  }

  return ort.InferenceSession.create(buffer, {
    executionProviders: ["wasm"],
  });
}

// ─── Public API ─────────────────────────────────────────────────────

window.RikaiMangaOcr = {
  /**
   * Load tokenizer, image processor, encoder, and decoder.
   * @param {(p: {percent?: number, phase?: string, file?: string, downloading?: boolean, loadedMB?: number, totalMB?: number, fromCache?: boolean}) => void} [onProgress]
   */
  async init(onProgress = () => {}) {
    if (ready) return true;

    const t0 = performance.now();

    // Load tokenizer + image processor from NorwayFish (has tokenizer.json)
    onProgress({ phase: "tokenizer", percent: 0 });
    [tokenizer, imageProcessor] = await Promise.all([
      AutoTokenizer.from_pretrained(TOKENIZER_REPO),
      AutoImageProcessor.from_pretrained(TOKENIZER_REPO),
    ]);
    onProgress({ phase: "tokenizer", percent: 100 });

    // Load encoder and decoder ONNX models in parallel
    onProgress({ phase: "download", percent: 0 });
    let filesDone = 0;
    const totalFiles = 2;

    const trackProgress = (p) => {
      if (p.phase === "load") {
        filesDone++;
        onProgress({
          phase: "model-load",
          percent: Math.round((filesDone / totalFiles) * 100),
          file: p.file,
        });
      }
    };

    const [enc, dec] = await Promise.all([
      loadOnnxSession(ENCODER_REPO, "onnx/encoder_model.onnx", trackProgress),
      loadOnnxSession(DECODER_REPO, "onnx/decoder_model.onnx", trackProgress),
    ]);

    encoderSession = enc;
    decoderSession = dec;

    // Quick sanity: log input/output names
    console.log(
      "[Rikai OCR] Encoder inputs:",
      encoderSession.inputNames,
      "outputs:",
      encoderSession.outputNames
    );
    console.log(
      "[Rikai OCR] Decoder inputs:",
      decoderSession.inputNames,
      "outputs:",
      decoderSession.outputNames
    );

    ready = true;
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    console.log(`[Rikai OCR] Init complete in ${elapsed}s`);
    return true;
  },

  isReady() {
    return ready;
  },

  /**
   * Recognize Japanese text in a single cropped region.
   * @param {string} imageDataUrl - PNG data URL of the crop
   * @returns {Promise<string>} recognized Japanese text
   */
  async recognize(imageDataUrl) {
    if (!ready) throw new Error("Model not initialized. Call init() first.");

    // 1. Process image through Transformers.js image processor
    const image = await RawImage.fromURL(imageDataUrl);
    const processed = await imageProcessor(image);
    const pixel_values = processed.pixel_values;

    // 2. Run encoder
    const encoderInput = {};
    for (const name of encoderSession.inputNames) {
      if (name === "pixel_values") {
        // Convert Transformers.js Tensor to ORT Tensor
        const data = pixel_values.data;
        const dims = pixel_values.dims;
        encoderInput[name] = new ort.Tensor("float32", Float32Array.from(data), dims);
      }
    }

    const encoderOutput = await encoderSession.run(encoderInput);
    const encoderKeyName = encoderSession.outputNames[0]; // typically "last_hidden_state"
    const encoderHiddenStates = encoderOutput[encoderKeyName];

    // 3. Greedy autoregressive decode
    const maxNewTokens = 96;

    // Start token: decoder_start_token_id from config (2) or bos_token_id
    const startTokenId =
      tokenizer.bos_token_id ?? tokenizer.cls_token_id ?? 2;
    const eosTokenId = tokenizer.eos_token_id ?? tokenizer.sep_token_id ?? 3;

    /** @type {number[]} */
    const generatedIds = [startTokenId];

    for (let step = 0; step < maxNewTokens; step++) {
      // Build decoder input tensors
      const inputIdsArray = new BigInt64Array(generatedIds.map((id) => BigInt(id)));
      const seqLen = generatedIds.length;

      const decoderInput = {};

      for (const name of decoderSession.inputNames) {
        switch (name) {
          case "input_ids":
            decoderInput[name] = new ort.Tensor(
              "int64",
              inputIdsArray,
              [1, seqLen]
            );
            break;
          case "attention_mask":
            decoderInput[name] = new ort.Tensor(
              "int64",
              new BigInt64Array(seqLen).fill(1n),
              [1, seqLen]
            );
            break;
          case "encoder_hidden_states":
            decoderInput[name] = encoderHiddenStates;
            break;
          case "encoder_attention_mask": {
            const encSeqLen = encoderHiddenStates.dims[1];
            decoderInput[name] = new ort.Tensor(
              "int64",
              new BigInt64Array(encSeqLen).fill(1n),
              [1, encSeqLen]
            );
            break;
          }
          case "position_ids":
            decoderInput[name] = new ort.Tensor(
              "int64",
              BigInt64Array.from({ length: seqLen }, (_, i) => BigInt(i)),
              [1, seqLen]
            );
            break;
          // Skip optional inputs like past_key_values, use_cache_branch, etc.
          default:
            // If the session requires it, try to provide a sensible default
            if (name.includes("past_key") || name === "use_cache_branch") {
              // Skip — we don't use KV caching
              break;
            }
            console.warn(`[Rikai OCR] Unknown decoder input: ${name}`);
            break;
        }
      }

      const decoderOutput = await decoderSession.run(decoderInput);

      // Get logits for the last token position
      const logitsKey = decoderSession.outputNames.find(
        (n) => n === "logits"
      ) ?? decoderSession.outputNames[0];
      const logits = decoderOutput[logitsKey];

      // logits shape: [1, seqLen, vocabSize]
      const vocabSize = logits.dims[logits.dims.length - 1];
      const lastTokenOffset =
        (seqLen - 1) * vocabSize; // offset to last token's logits

      // Argmax over vocab dimension for the last token
      let maxVal = -Infinity;
      let nextTokenId = 0;
      const logitsData = logits.data;
      for (let v = 0; v < vocabSize; v++) {
        const val = logitsData[lastTokenOffset + v];
        if (val > maxVal) {
          maxVal = val;
          nextTokenId = v;
        }
      }

      // Stop at EOS
      if (nextTokenId === eosTokenId) break;

      generatedIds.push(nextTokenId);
    }

    // 4. Decode token IDs to text
    const text = tokenizer.decode(generatedIds, {
      skip_special_tokens: true,
    });

    return text.trim();
  },
};
