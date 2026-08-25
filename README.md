# Rikai

Japanese manga OCR + translation, rendered directly on the page.

## What is Rikai?

Rikai is a Chrome extension that:

1. Scans manga pages for images
2. Detects text regions (speech bubbles, captions) in each image
3. Recognizes Japanese text via [MangaOCR](https://github.com/kha-white/manga-ocr) running locally in the browser (ONNX Runtime WASM)
4. Translates Japanese → English via [MyMemory API](https://mymemory.translated.net/) (free, no key)
5. Renders translation overlays pinned to the original text positions
6. Continuously watches for new/lazy-loaded images and re-processes automatically

## Architecture

```
rikai/
├── manifest.json                 # Chrome Manifest V3
├── package.json                  # npm dependencies
├── tsconfig.json                 # TypeScript configuration
├── background.ts                 # Service worker (state tracking, offscreen lifecycle)
├── content/
│   ├── content.ts                # Main content script (activation, pipeline orchestration)
│   ├── image-extractor.ts        # Manga image discovery (img, picture, canvas, CSS bg)
│   ├── ocr-pipeline.ts           # OCR client, cache, and work queue
│   ├── overlay.ts                # In-page translation overlay (Shadow DOM)
│   └── translator.ts             # MyMemory API translation
├── offscreen/
│   ├── offscreen.html            # Offscreen document host
│   ├── offscreen.ts              # OCR orchestration (crop, detect, recognize)
│   ├── offscreen-ocr-src.ts      # MangaOCR engine (ORT direct + Transformers.js tokenizer)
│   └── text-detector.ts          # Connected-component text region detection
├── popup/
│   ├── popup.html                # Extension popup UI
│   ├── popup.ts                  # Popup state management
│   └── popup.css                 # Popup styles
├── scripts/
│   └── build.js                  # esbuild build script (TS → JS + ORT bundling)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── dist/                         # Build output (loaded by Chrome)
    ├── manifest.json
    ├── background.js
    ├── offscreen-ocr.js          # Bundled OCR engine (~857 KB)
    ├── ort-wasm-simd-threaded.jsep.wasm  # ONNX Runtime WASM binary (~21 MB)
    ├── content/*.js
    ├── offscreen/*.js
    └── popup/*.js
```

### How it works

```
User clicks ON in popup
  → content/content.ts activates
    → chrome.runtime → background.ts (ensures offscreen document exists)
      → offscreen/offscreen.html loads
        → offscreen-ocr-src.ts loads MangaOCR engine via ORT
    → Content script starts pipeline:
        scan images → visibility-prioritize → OCR → translate → overlay

Per manga image:
  1. Text detector finds likely text regions (speech bubbles)
  2. Each region is cropped and sent to MangaOCR encoder + decoder
  3. Recognized Japanese text is translated via MyMemory API
  4. Translation overlay is pinned over the original text region
```

## Tech Stack

| Component | Technology |
|---|---|
| OCR Engine | [MangaOCR](https://github.com/kha-white/manga-ocr) (kha-white/manga-ocr-base) via [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) (WASM) |
| Tokenizer | [Transformers.js](https://huggingface.co/docs/transformers.js) AutoTokenizer from [NorwayFish/manga-ocr](https://huggingface.co/NorwayFish/manga-ocr) |
| Image Processor | Transformers.js AutoImageProcessor |
| Text Detection | Custom connected-component labeling (pure JS) |
| Translation | [MyMemory API](https://mymemory.translated.net/) (free, no key) |
| Language | TypeScript, compiled via [esbuild](https://esbuild.github.io/) |
| Platform | Chrome Extension Manifest V3 |

### Why direct ORT instead of Transformers.js pipeline?

Transformers.js's `pipeline("image-to-text")` hardcodes `decoder_model_merged.onnx` as the decoder filename. The [onnx-community/manga-ocr-base-ONNX](https://huggingface.co/onnx-community/manga-ocr-base-ONNX) repo only has `decoder_model.onnx` (without "merged"). Rather than monkey-patching the library, the engine loads encoder + decoder directly via `ort.InferenceSession` and uses Transformers.js only for tokenizer and image processing.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Google Chrome](https://www.google.com/chrome/) 116+

### Build

```bash
# Install dependencies
npm install

# Build (compiles TS → JS, bundles OCR engine, copies assets)
npm run build

# Watch mode (rebuilds on file changes)
npm run build:watch
```

### Load as Unpacked Extension

1. Build the project (`npm run build`)
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the `dist/` folder
5. Pin the extension to your toolbar

### First Use

The first time you activate Rikai on a page, it downloads the MangaOCR model (~460 MB) from HuggingFace. This is cached by the browser and only happens once. Subsequent activations load from cache.

## Model Files

The extension downloads two ONNX files at runtime from [onnx-community/manga-ocr-base-ONNX](https://huggingface.co/onnx-community/manga-ocr-base-ONNX):

| File | Size | Purpose |
|---|---|---|
| `onnx/encoder_model.onnx` | 343 MB | ViT image encoder (fp32) |
| `onnx/decoder_model.onnx` | 117 MB | BERT text decoder (fp32) |
| **Total** | **460 MB** | Downloaded once, cached by browser |

Tokenizer and image processor files are loaded from [NorwayFish/manga-ocr](https://huggingface.co/NorwayFish/manga-ocr) (~150 KB).

## Performance

The first activation is slow (model download + WASM initialization). After that, the model stays in memory and subsequent activations are fast.

| Phase | First Time | Cached |
|---|---|---|
| Offscreen document creation | ~100–200 ms | ~100–200 ms |
| Model download from HuggingFace | ~10–60 s | 0 |
| Model load from Cache Storage | 0 | ~1–5 s |
| WASM warm-up inference | ~1–3 s | Skipped |
| **Total activation** | **~12–65 s** | **~1–5 s** |

## License

TBD
