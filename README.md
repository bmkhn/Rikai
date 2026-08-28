# Rikai

Japanese manga OCR desktop app. Move a window over text on screen, get instant recognition.

## What is Rikai?

Rikai is a desktop app that acts as a **screen OCR magnifier for Japanese text**:

1. A small, always-on-top frameless window sits on your screen
2. Drag it over any manga text (browser, image viewer, desktop app — anything)
3. The app captures the screen region behind the window
4. Runs [MangaOCR](https://github.com/kha-white/manga-ocr) (kha-white/manga-ocr-base) on the captured image
5. Displays the recognized Japanese text inside the window

**No Chrome extension. No text detection pipeline. No ONNX conversion.** Just the original PyTorch model for maximum accuracy.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Electron Desktop App                │
│                                                  │
│  ┌─────────────────────┐   ┌──────────────────┐ │
│  │   Renderer Process  │   │  Main Process     │ │
│  │                     │   │                   │ │
│  │  - Frameless window │   │  - Screen capture │ │
│  │  - Always-on-top    │◄─►│  - Python bridge  │ │
│  │  - Text display     │   │  - manga-ocr      │ │
│  │  - Hotkey handling  │   │    inference      │ │
│  └─────────────────────┘   └──────────────────┘ │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │           Python Subprocess                  │ │
│  │                                              │ │
│  │  - manga_ocr.MangaOcr loaded in memory       │ │
│  │  - Receives image bytes via stdin/HTTP       │ │
│  │  - Returns recognized text                   │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Communication Flow

```
1. User positions window over manga text
2. Renderer captures screen region (via desktopCapturer or native API)
3. Sends image bytes to Python subprocess (via stdin or local HTTP)
4. Python runs manga-ocr inference (~50-100ms on GPU)
5. Returns Japanese text to renderer
6. Renderer displays text in the window
```

### Window Modes

| Mode | Window Appearance | Behavior |
|---|---|---|
| **Scanning** | Transparent frame only (border visible) | Captures what's behind it |
| **Reading** | Frame + text overlay | Shows recognized text |

Toggle between modes via hotkey (default: `Ctrl+Shift+O`).

## Tech Stack

| Component | Technology |
|---|---|
| Desktop Framework | [Electron](https://www.electronjs.org/) |
| OCR Model | [kha-white/manga-ocr-base](https://github.com/kha-white/manga-ocr) (PyTorch) |
| Python Runtime | Bundled via [PyInstaller](https://pyinstaller.org/) or [Nuitka](https://nuitka.net/) |
| Screen Capture | Electron `desktopCapturer` + native APIs |
| Language | TypeScript (Electron), Python (OCR) |

## Quick Start (Phase 1)

```bash
# Install Python dependencies
pip install -r server/requirements.txt

# Start the OCR server
python server/ocr_server.py

# Test it (in another terminal)
python test/test-manga-ocr.py --server test.webp

# Or test standalone (no server needed)
python test/test-manga-ocr.py test.webp
```

## Project Status

> **🚧 Phase 1 in progress — Python OCR server built, testing accuracy.**
>
> The previous Chrome extension prototype is in the git history but being replaced.

---

## Development Plan

### Phase 1: Python OCR Server (Standalone)

**Goal:** Prove the Python model works and establish the inference interface.

- [x] Create a minimal Python script that loads `manga-ocr` and accepts images
- [x] Define the API contract (input: image bytes, output: text string)
- [ ] Test accuracy on sample manga images
- [ ] Measure inference speed (CPU vs GPU)

**Deliverable:** `server/ocr_server.py` — run it, POST an image to `http://127.0.0.1:54321/ocr`, get text back.

### Phase 2: Electron Shell

**Goal:** Basic Electron app with screen capture and Python communication.

- [ ] Scaffold Electron project (main process + renderer)
- [ ] Create a frameless, always-on-top window
- [ ] Implement screen capture of the region behind the window
- [ ] Bridge Electron ↔ Python subprocess (stdin/stdout or local HTTP)
- [ ] Display captured image and OCR result in the window

**Deliverable:** An Electron app that captures screen regions and OCRs them via Python.

### Phase 3: UX Polish

**Goal:** Make it feel like a real product.

- [ ] Scanning/Reading mode toggle (hotkey)
- [ ] Transparent window in scanning mode (border only)
- [ ] Text overlay styling in reading mode
- [ ] System tray icon (show/hide window)
- [ ] Auto-start option
- [ ] Window remembers position across restarts

**Deliverable:** A polished, usable desktop OCR tool.

### Phase 4: Packaging & Distribution

**Goal:** Ship it.

- [ ] Bundle Python + manga-ocr via PyInstaller/Nuitka
- [ ] Cross-platform builds (Windows, macOS, Linux)
- [ ] Code signing (for macOS gatekeeper)
- [ ] Auto-update mechanism
- [ ] Installer (Electron Builder / electron-forge)

**Deliverable:** Standalone installers for each platform (~200-400 MB).

### Phase 5: Translation (Future)

**Goal:** Add Japanese → English translation.

- [ ] Choose translation approach (local model vs API)
- [ ] Display translation alongside OCR text
- [ ] Toggle translation on/off

---

## Where We Left Off

**Date:** 2026-08-28

**Last conversation:** Initial planning. We decided to:

1. **Pivot from Chrome extension to Electron desktop app** — the original Chrome extension approach (ONNX in browser) had accuracy concerns with quantized models, and the Python model is the gold standard
2. **Use the "scanner window" UX** — a movable always-on-top window that captures and OCRs whatever is behind it
3. **OCR only for now** — translation will be added later (Phase 5)
4. **Start with Phase 1** — a standalone Python script to prove accuracy before building the Electron shell

**Key decisions made:**
- Use `kha-white/manga-ocr-base` (original PyTorch model, not ONNX)
- Python runs as a subprocess inside Electron (bundled via PyInstaller)
- No Chrome extension — works with any app on screen
- Frameless always-on-top window with hotkey toggle between scanning/reading modes

**Next step:** Test the Phase 1 server — run `python server/ocr_server.py`, POST `test.webp` to it, verify accuracy.

**Test image:** `test.webp` (in repo root)

**Python install needed:**
```bash
pip install manga-ocr
```

**Test files:**
- `test/test-manga-ocr.py` — Python manga-ocr test (relevant for Phase 1)
