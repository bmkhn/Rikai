# Rikai

Japanese manga OCR desktop app. Position a scan window over text on screen, get instant recognition.

## What is Rikai?

Rikai is a desktop app that acts as a **screen OCR magnifier for Japanese text**:

1. Click **Scan** in the main window to open a small, transparent scan frame
2. Drag the scan frame over any manga text (browser, image viewer, desktop app — anything)
3. Click the scan frame — it captures the screen region behind it
4. Runs [MangaOCR](https://github.com/kha-white/manga-ocr) (kha-white/manga-ocr-base) on the captured image
5. Auto-translates the Japanese text to English using Google Translate (free, no API key)
6. Displays both the original Japanese text and English translation in the main window

**No Chrome extension. No text detection pipeline. No ONNX conversion.** Just the original PyTorch model for maximum accuracy.

## How It Works

The app uses a **two-window architecture**:

- **Main Window** — a standard dark-themed Electron window that shows OCR results, a Scan button, Copy button, and capture history.
- **Scan Window** — a small, frameless, transparent, always-on-top window. Hold to drag, click to capture. It stays clean with no text or buttons, so you can position it precisely over a single speech bubble.

The Python OCR server runs as a subprocess, auto-started by Electron on launch. Communication happens over localhost HTTP.

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

# Run the app (starts Python server automatically)
npm start
```

First launch downloads the manga-ocr model from HuggingFace (~400MB) and takes about 80 seconds to load on CPU. After that, the status badge turns green and you can scan.

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
| Translation | [deep-translator](https://github.com/nidhaloff/deep-translator) (Google Translate, free) |
| Python Bundling | [PyInstaller](https://pyinstaller.org/) |
| Installer | [Electron Builder](https://www.electron.build/) (NSIS) |
| Screen Capture | Electron `desktopCapturer` |
| Language | JavaScript (Electron), Python (OCR) |

## Project Structure

```
Rikai/
  src/
    main.js              # Electron main process (two-window management, Python bridge)
    preload.js           # IPC bridge (contextIsolation)
    renderer/
      main.html         # Main window UI
      main.css          # Main window styling
      main.js           # Main window logic (results, history, controls)
      index.html        # Scan window UI (clean frame)
      styles.css        # Scan window styling
      renderer.js       # Scan window logic (drag, capture)
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

## History

Rikai started as a Chrome extension using ONNX models in-browser, but accuracy concerns with quantized models led to a pivot to an Electron desktop app using the original PyTorch manga-ocr model. The Python OCR server approach gives maximum accuracy at the cost of a larger install size (~240MB).
