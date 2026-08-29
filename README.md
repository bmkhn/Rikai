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
│  │  - Drag / resize    │   │  - Auto-spawn     │ │
│  └─────────────────────┘   └──────────────────┘ │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │           Python Subprocess (venv)           │ │
│  │                                              │ │
│  │  - manga_ocr.MangaOcr loaded in memory       │ │
│  │  - Receives image bytes via HTTP             │ │
│  │  - Returns recognized text                   │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Python 3](https://python.org/) (3.10+)

### Setup

```bash
# Install npm dependencies
npm install

# Create Python virtual environment and install dependencies
python -m venv venv
./venv/Scripts/pip install -r server/requirements.txt   # Windows
# source venv/bin/pip install -r server/requirements.txt   # macOS/Linux

# Run in dev mode (starts Python server automatically)
npm start
```

### Building

```bash
# Bundle Python OCR server into standalone exe (requires PyInstaller)
./venv/Scripts/pip install pyinstaller
build/build-python.bat

# Package Electron app (Windows NSIS installer)
npm run build

# Or do both at once
npm run build:all
```

### Testing OCR standalone

```bash
# Activate venv first
./venv/Scripts/activate

# Test via server
python server/ocr_server.py
python test/test-manga-ocr.py --server test.webp

# Or test directly
python test/test-manga-ocr.py test.webp
```

## Tech Stack

| Component | Technology |
|---|---|
| Desktop Framework | [Electron](https://www.electronjs.org/) |
| OCR Model | [kha-white/manga-ocr-base](https://github.com/kha-white/manga-ocr) (PyTorch) |
| Python Bundling | [PyInstaller](https://pyinstaller.org/) |
| Installer | [Electron Builder](https://www.electron.build/) (NSIS) |
| Screen Capture | Electron `desktopCapturer` |
| Language | JavaScript (Electron), Python (OCR) |

## Project Status

> **Phases 1-4 complete. OCR accuracy needs improvement — early testing shows
> problems with accurate text detection, especially with multiple speech bubbles
> and varied manga layouts. Fixes and improvements will be done in a future pass.**

---

## Development Plan

### Phase 1: Python OCR Server (Standalone) ✅

- [x] Create a minimal Python script that loads `manga-ocr` and accepts images
- [x] Define the API contract (input: image bytes, output: text string)
- [x] Fix Windows encoding issues (cp1252 -> UTF-8)
- [ ] Test accuracy on sample manga images (deferred)
- [ ] Measure inference speed (CPU vs GPU) (deferred)

### Phase 2: Electron Shell ✅

- [x] Scaffold Electron project (`src/main.js`, `src/preload.js`, `src/renderer/`)
- [x] Create a frameless, always-on-top window
- [x] Implement screen capture of the region behind the window
- [x] Bridge Electron ↔ Python subprocess (auto-spawn, localhost HTTP)
- [x] Display OCR result in scanning/reading mode
- [x] Custom window dragging and resizing
- [x] Corner accent styling and glow effects
- [x] Global hotkey (`Ctrl+Shift+O`)

### Phase 3: UX Polish ✅

- [x] System tray icon with context menu
- [x] Close-to-tray behavior
- [x] Window position/size persistence across restarts
- [x] Multi-monitor screen capture support

### Phase 4: Packaging & Distribution ✅

- [x] Bundle Python + manga-ocr via PyInstaller (`--onedir` mode)
- [x] Electron Builder config (NSIS installer, cross-platform targets)
- [x] Windows NSIS installer (~240 MB)
- [x] Dev vs production path detection for Python server
- [x] Python venv (no global pip pollution)
- [ ] Code signing (for macOS gatekeeper)
- [ ] Auto-update mechanism
- [ ] macOS / Linux builds

### Phase 5: Translation (Future)

- [ ] Choose translation approach (local model vs API)
- [ ] Display translation alongside OCR text
- [ ] Toggle translation on/off

---

## Known Issues

- **OCR accuracy**: The manga-ocr model struggles with certain text layouts,
  multiple speech bubbles, and stylized fonts. A dedicated accuracy improvement
  pass is planned.
- **Inference speed**: ~1.3s on CPU. GPU support would bring this down to ~50-100ms.
- **Model download**: First launch downloads the model weights from HuggingFace (~400MB).

## Project Structure

```
Rikai/
  src/
    main.js              # Electron main process
    preload.js           # IPC bridge (contextIsolation)
    renderer/
      index.html         # UI
      styles.css         # Styling (scanning/reading modes)
      renderer.js        # Capture, OCR, drag, mode switching
  server/
    ocr_server.py        # Python OCR HTTP server
    requirements.txt     # Python dependencies
  test/
    test-manga-ocr.py    # OCR test script
  build/
    build-python.bat     # PyInstaller build script
  icons/                 # App icons
  venv/                  # Python virtual environment (gitignored)
```
