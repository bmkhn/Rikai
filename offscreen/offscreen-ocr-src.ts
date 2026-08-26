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
  AutoTokenizer as TokenizerType,
  AutoImageProcessor as ProcessorType,
} from "@huggingface/transformers";
import * as ort from "onnxruntime-web";

// ─── Configuration ──────────────────────────────────────────────────

const TOKENIZER_REPO = "NorwayFish/manga-ocr";
const ENCODER_REPO = "onnx-community/manga-ocr-base-ONNX";
const DECODER_REPO = "onnx-community/manga-ocr-base-ONNX";

// Extension pages are not cross-origin isolated, so WASM threading is off.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = chrome.runtime.getURL("dist/");

// Also configure Transformers.js to use our local wasm paths
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/");
env.allowLocalModels = false;
env.useBrowserCache = true;

// ─── Types ──────────────────────────────────────────────────────────

interface InitProgress {
  percent?: number;
  phase?: string;
  file?: string;
  downloading?: boolean;
  loadedMB?: number;
  totalMB?: number;
  fromCache?: boolean;
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
let initAbortController: AbortController | null = null;

// ─── Helpers ────────────────────────────────────────────────────────

function baseUrl(repo: string, filename: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${filename}`;
}

interface FileProgress {
  name: string;
  sizeMB: number;
  phase: "pending" | "downloading" | "loading" | "done" | "error";
  percent: number;
}

function writeDownloadProgress(files: FileProgress[]): void {
  try {
    const active = files.some((f) => f.phase === "downloading" || f.phase === "loading");
    const done = files.every((f) => f.phase === "done");
    const phase = done ? "done" : "download";
    // Write to storage directly (popup polls this)
    chrome.storage?.local?.set({
      rikaiDownloadProgress: { active, phase, files },
    });
    // Also broadcast so background can forward to popup if open
    chrome.runtime
      .sendMessage({ source: "rikai-offscreen", type: "PROGRESS", phase, files })
      .catch(() => {});
  } catch {
    // storage may not be available in offscreen context
  }
}

async function loadOnnxSession(
  repo: string,
  filename: string,
  onProgress?: (p: { phase: string; file: string; percent?: number }) => void,
  signal?: AbortSignal
): Promise<ort.InferenceSession> {
  const url = baseUrl(repo, filename);

  // Check Cache Storage first (user may have located the file locally)
  let buffer: ArrayBuffer | null = null;
  try {
    const cache = await caches.open("rikai-models");
    const cached = await cache.match(url);
    if (cached) {
      buffer = await cached.arrayBuffer();
      if (onProgress) onProgress({ phase: "download", file: filename, percent: 100 });
    }
  } catch {
    // Cache Storage unavailable
  }

  if (!buffer) {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${filename}: HTTP ${response.status}`);
    }

    // Track download progress via Content-Length + ReadableStream
    const contentLength = Number(response.headers.get("content-length")) || 0;
    const reader = response.body?.getReader();
    let loaded = 0;

    if (reader && contentLength > 0) {
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        const percent = Math.round((loaded / contentLength) * 100);
        if (onProgress) {
          onProgress({ phase: "download", file: filename, percent });
        }
      }
      const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      buffer = merged.buffer;
    } else {
      buffer = await response.arrayBuffer();
    }
  }

  if (onProgress) {
    onProgress({ phase: "load", file: filename });
  }

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

    const t0 = performance.now();

    try {
    // Per-file progress tracking
    const files: FileProgress[] = [
      { name: "Encoder model", sizeMB: 343, phase: "pending", percent: 0 },
      { name: "Decoder model", sizeMB: 117, phase: "pending", percent: 0 },
      { name: "Tokenizer", sizeMB: 0, phase: "pending", percent: 0 },
    ];
    const getIdx = (file: string) =>
      file.includes("encoder") ? 0 : file.includes("decoder") ? 1 : 2;

    // Load tokenizer + image processor from NorwayFish (has tokenizer.json)
    files[2].phase = "downloading";
    writeDownloadProgress(files);
    onProgress({ phase: "tokenizer", percent: 0 });
    const [tok, proc] = await Promise.all([
      AutoTokenizer.from_pretrained(TOKENIZER_REPO) as Promise<TokenizerType>,
      AutoImageProcessor.from_pretrained(TOKENIZER_REPO) as Promise<ProcessorType>,
    ]);
    tokenizer = tok;
    imageProcessor = proc;
    files[2].phase = "done";
    files[2].percent = 100;
    writeDownloadProgress(files);
    onProgress({ phase: "tokenizer", percent: 100 });

    // Load encoder and decoder ONNX models in parallel
    files[0].phase = "downloading";
    files[1].phase = "downloading";
    writeDownloadProgress(files);
    onProgress({ phase: "download", percent: 0 });

    const trackProgress = (p: { phase: string; file: string; percent?: number }) => {
      const idx = getIdx(p.file);
      if (p.phase === "download" && typeof p.percent === "number") {
        files[idx].percent = p.percent;
      }
      if (p.phase === "load") {
        files[idx].phase = "loading";
        files[idx].percent = 100;
      }
      writeDownloadProgress(files);
    };

    initAbortController = new AbortController();
    const signal = initAbortController.signal;

    const [enc, dec] = await Promise.all([
      loadOnnxSession(ENCODER_REPO, "onnx/encoder_model.onnx", trackProgress, signal),
      loadOnnxSession(DECODER_REPO, "onnx/decoder_model.onnx", trackProgress, signal),
    ]);
    initAbortController = null;

    files[0].phase = "done";
    files[1].phase = "done";

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
    // Note: readiness flag is set by the background service worker
    // (offscreen document cannot access chrome.storage)
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    console.log(`[Rikai OCR] Init complete in ${elapsed}s`);
    return true;

    } catch (err) {
      initAbortController = null;
      if ((err as Error)?.name === "AbortError") {
        // Mark all non-done files as cancelled
        for (const f of files) {
          if (f.phase !== "done") f.phase = "pending";
        }
        writeDownloadProgress(files);
      } else {
        for (const f of files) {
          if (f.phase !== "done") f.phase = "error";
        }
        writeDownloadProgress(files);
      }
      throw err;
    }
  },

  cancelInit(): void {
    if (initAbortController) {
      initAbortController.abort();
      initAbortController = null;
    }
  },

  isReady(): boolean {
    return ready;
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
