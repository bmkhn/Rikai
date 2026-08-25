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

// ─── Helpers ────────────────────────────────────────────────────────

function baseUrl(repo: string, filename: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${filename}`;
}

/**
 * Fetch an ONNX model file, then create an ORT InferenceSession from it.
 */
function writeDownloadProgress(
  active: boolean,
  phase: string,
  percent: number,
  detail?: string
): void {
  try {
    chrome.storage?.local?.set({
      rikaiDownloadProgress: { active, phase, percent, detail: detail || "" },
    });
  } catch {
    // storage may not be available in offscreen context
  }
}

async function loadOnnxSession(
  repo: string,
  filename: string,
  onProgress?: (p: { phase: string; file: string; percent?: number }) => void
): Promise<ort.InferenceSession> {
  const url = baseUrl(repo, filename);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${filename}: HTTP ${response.status}`);
  }

  // Track download progress via Content-Length + ReadableStream
  const contentLength = Number(response.headers.get("content-length")) || 0;
  const reader = response.body?.getReader();
  let loaded = 0;

  let buffer: ArrayBuffer;
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
    // Combine chunks into single buffer
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
    // Load tokenizer + image processor from NorwayFish (has tokenizer.json)
    writeDownloadProgress(true, "tokenizer", 0, "Loading tokenizer");
    onProgress({ phase: "tokenizer", percent: 0 });
    const [tok, proc] = await Promise.all([
      AutoTokenizer.from_pretrained(TOKENIZER_REPO) as Promise<TokenizerType>,
      AutoImageProcessor.from_pretrained(TOKENIZER_REPO) as Promise<ProcessorType>,
    ]);
    tokenizer = tok;
    imageProcessor = proc;
    writeDownloadProgress(true, "download", 0, "Downloading models");
    onProgress({ phase: "tokenizer", percent: 100 });

    // Load encoder and decoder ONNX models in parallel
    onProgress({ phase: "download", percent: 0 });
    let filesDone = 0;
    const totalFiles = 2;

    const trackProgress = (p: { phase: string; file: string; percent?: number }) => {
      // Write per-file progress to storage for popup polling
      const fileLabel = p.file?.includes("encoder") ? "Encoder" : "Decoder";
      if (p.phase === "download" && typeof p.percent === "number") {
        // Each file is ~50% of total; combine with files already done
        const base = (filesDone / totalFiles) * 100;
        const share = (1 / totalFiles) * p.percent;
        const total = Math.round(base + share);
        writeDownloadProgress(true, "download", total, `${fileLabel} ${p.percent}%`);
      }
      if (p.phase === "load") {
        filesDone++;
        const total = Math.round((filesDone / totalFiles) * 100);
        writeDownloadProgress(true, "load", total, `Loading ${fileLabel}`);
        onProgress({
          phase: "model-load",
          percent: total,
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
      writeDownloadProgress(false, "error", 0, String((err as Error)?.message || err));
      throw err;
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
