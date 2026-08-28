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

// Extension pages are not cross-origin isolated, so WASM threading is off.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = chrome.runtime.getURL("dist/");

// Also configure Transformers.js to use our local wasm paths
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/");
env.allowLocalModels = false;
env.useBrowserCache = true;

// ─── Types ──────────────────────────────────────────────────────────

type TokenizerType = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type ProcessorType = Awaited<ReturnType<typeof AutoImageProcessor.from_pretrained>>;

interface InitProgress {
  percent?: number;
  phase?: string;
}

interface ImageRef {
  kind: "url" | "dataurl";
  value: string;
}

// ─── State ──────────────────────────────────────────────────────────

let tokenizer: TokenizerType | null = null;
let imageProcessor: ProcessorType | null = null;
let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;
let ready = false;
let initPromise: Promise<boolean> | null = null;

// ─── Helpers ────────────────────────────────────────────────────────

async function loadOnnxSession(
  filename: string,
  url: string
): Promise<ort.InferenceSession> {
  // Check Cache Storage first (user may have located the file locally)
  let buffer: ArrayBuffer | null = null;
  try {
    const cache = await caches.open("rikai-models");
    const cached = await cache.match(url);
    if (cached) {
      console.log(`[Rikai OCR] ${filename} found in cache`);
      buffer = await cached.arrayBuffer();
    } else {
      console.log(`[Rikai OCR] ${filename} not in cache, will fetch`);
    }
  } catch (err) {
    console.warn(`[Rikai OCR] Cache lookup failed for ${filename}:`, err);
  }

  if (!buffer) {
    console.log(`[Rikai OCR] Fetching ${filename} from network…`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${filename}: HTTP ${response.status}`);
    }
    buffer = await response.arrayBuffer();
  }

  console.log(`[Rikai OCR] Creating ONNX session for ${filename} (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)…`);
  return ort.InferenceSession.create(buffer, {
    executionProviders: ["wasm"],
  });
}

// ─── Public API ─────────────────────────────────────────────────────

interface MangaOcrEngine {
  init(onProgress?: (p: InitProgress) => void): Promise<boolean>;
  isReady(): boolean;
  recognize(imageDataUrl: string): Promise<string>;
}

(window as any).RikaiMangaOcr = {
  async init(onProgress: (p: InitProgress) => void = () => {}): Promise<boolean> {
    if (ready) return true;
    // If init is already in progress, piggyback on the existing load
    // instead of starting a second parallel load (critical for low-RAM devices).
    if (initPromise) return initPromise;

    initPromise = (async () => {
    const t0 = performance.now();

    // Load tokenizer + image processor from NorwayFish (has tokenizer.json)
    onProgress({ phase: "tokenizer", percent: 0 });
    const [tok, proc] = await Promise.all([
      AutoTokenizer.from_pretrained(TOKENIZER_REPO) as Promise<TokenizerType>,
      AutoImageProcessor.from_pretrained(TOKENIZER_REPO) as Promise<ProcessorType>,
    ]);
    tokenizer = tok;
    imageProcessor = proc;
    onProgress({ phase: "tokenizer", percent: 100 });

    // Load encoder and decoder ONNX models from cache
    // Load sequentially to reduce peak memory (~460 MB vs ~920 MB parallel).
    // Critical for low-end devices (e.g. i3, 8 GB RAM, integrated GPU).
    onProgress({ phase: "download", percent: 0 });

    const enc = await loadOnnxSession("encoder_model.onnx", `https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model.onnx`);
    onProgress({ phase: "download", percent: 50 });
    const dec = await loadOnnxSession("decoder_model.onnx", `https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/decoder_model.onnx`);
    onProgress({ phase: "download", percent: 100 });

    encoderSession = enc;
    decoderSession = dec;

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
    })();

    try {
      return await initPromise;
    } finally {
      initPromise = null;
    }
  },

  isReady(): boolean {
    return ready;
  },

  isLoading(): boolean {
    return initPromise !== null && !ready;
  },

  async recognize(imageDataUrl: string): Promise<string> {
    if (!ready) throw new Error("Model not initialized. Call init() first.");
    if (!tokenizer || !imageProcessor || !encoderSession || !decoderSession) {
      throw new Error("Model components not loaded.");
    }

    // 1. Process image through Transformers.js image processor
    const image = await RawImage.fromURL(imageDataUrl);
    const processed = await imageProcessor(image);
    const pixel_values = (processed as any).pixel_values;

    // 2. Run encoder
    const encoderInput: Record<string, ort.Tensor> = {};
    for (const name of encoderSession.inputNames) {
      if (name === "pixel_values") {
        const data = pixel_values.data as Float32Array;
        const dims = pixel_values.dims as readonly number[];
        encoderInput[name] = new ort.Tensor("float32", Float32Array.from(data), dims as number[]);
      }
    }

    const encoderOutput = await encoderSession.run(encoderInput);
    const encoderKeyName = encoderSession.outputNames[0];
    const encoderHiddenStates = encoderOutput[encoderKeyName];

    // 3. Greedy autoregressive decode
    const maxNewTokens = 96;
    const startTokenId = (tokenizer as any).bos_token_id ?? (tokenizer as any).cls_token_id ?? 2;
    const eosTokenId = (tokenizer as any).eos_token_id ?? (tokenizer as any).sep_token_id ?? 3;

    const generatedIds: number[] = [startTokenId];

    for (let step = 0; step < maxNewTokens; step++) {
      const inputIdsArray = new BigInt64Array(generatedIds.map((id) => BigInt(id)));
      const seqLen = generatedIds.length;

      const decoderInput: Record<string, ort.Tensor> = {};

      for (const name of decoderSession.inputNames) {
        switch (name) {
          case "input_ids":
            decoderInput[name] = new ort.Tensor("int64", inputIdsArray, [1, seqLen]);
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
          default:
            if (name.includes("past_key") || name === "use_cache_branch") {
              break;
            }
            console.warn(`[Rikai OCR] Unknown decoder input: ${name}`);
            break;
        }
      }

      const decoderOutput = await decoderSession.run(decoderInput);

      const logitsKey =
        decoderSession.outputNames.find((n) => n === "logits") ??
        decoderSession.outputNames[0];
      const logits = decoderOutput[logitsKey];

      const vocabSize = logits.dims[logits.dims.length - 1];
      const lastTokenOffset = (seqLen - 1) * vocabSize;

      let maxVal = -Infinity;
      let nextTokenId = 0;
      const logitsData = logits.data as Float32Array;
      for (let v = 0; v < vocabSize; v++) {
        const val = logitsData[lastTokenOffset + v];
        if (val > maxVal) {
          maxVal = val;
          nextTokenId = v;
        }
      }

      if (nextTokenId === eosTokenId) break;
      generatedIds.push(nextTokenId);
    }

    const text = (tokenizer as any).decode(generatedIds, {
      skip_special_tokens: true,
    });

    return text.trim();
  },
} satisfies MangaOcrEngine;
