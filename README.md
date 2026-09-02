# Rikai

Japanese manga OCR desktop app with instant translation. Capture text from anywhere on screen, get recognition and English translation in one click.

Developed a desktop application for real-time Japanese manga text recognition and translation. The app uses a two-window architecture built with Electron: a main window displaying OCR results and translation, and a transparent, always-on-top scan frame for precise screen region capture. Users position the scan frame over manga text anywhere on screen — browser, image viewer, or desktop app — click to capture, and receive both the original Japanese text and an English translation instantly.

Recognition is powered by [manga-ocr](https://github.com/kha-white/manga-ocr) by kha-white — a pre-trained PyTorch model for Japanese manga text, served through a local Python HTTP server that runs as a subprocess. Translation is handled via direct Google Translate API calls (no API key needed), with a MyMemory fallback for reliability. Images are preprocessed (contrast, sharpening, upscaling) before OCR to improve accuracy on small or low-quality source images.

## How It Works

The app uses a **two-window architecture**:

- **Main Window** — a light-themed Electron window that shows OCR results, translation, a Scan button, Copy button, and capture history.
- **Scan Window** — a small, frameless, transparent, always-on-top window. Drag to reposition, click the capture button to scan. Stays clean so you can position it precisely over a single speech bubble.

The Python OCR server runs as a subprocess, auto-started by Electron on launch. Communication happens over localhost HTTP.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Python 3](https://python.org/) (3.10+)

### Install

```bash
npm install
python -m venv venv
./venv/Scripts/pip install -r server/requirements.txt   # Windows
# source venv/bin/pip install -r server/requirements.txt   # macOS/Linux
```

### Run

```bash
npm start
```

First launch downloads the manga-ocr model from HuggingFace (~400MB) and takes about 80 seconds to load on CPU. After that, the status badge turns green and you can scan.

## Tech Stack

| Component | Technology |
|---|---|
| Desktop Framework | [Electron](https://www.electronjs.org/) |
| OCR Model | [kha-white/manga-ocr-base](https://github.com/kha-white/manga-ocr) (PyTorch) |
| Translation | Google Translate API + MyMemory fallback (no API key) |
| Screen Capture | Electron `desktopCapturer` |
| Language | JavaScript (Electron), Python (OCR) |

**Skills:** Electron, JavaScript, Python, PyTorch, Screen Capture, REST APIs, HTTP Server, Desktop Application Development, Translation API, Image Processing, User Interface Design

## Project Structure

```
Rikai/
  src/
    main.js              # Electron main process (two-window management, Python bridge)
    preload.js           # IPC bridge (contextIsolation)
    renderer/
      main.html         # Main window UI
      main.css          # Main window styling (light theme, icon-inspired)
      main.js           # Main window logic (results, translation, history)
      index.html        # Scan window UI (capture button, drag frame)
      styles.css        # Scan window styling (blue accent, -webkit-app-region)
      renderer.js       # Scan window logic (capture, drag)
      logo.png          # App logo for header
  server/
    ocr_server.py        # Python OCR + translation HTTP server
    requirements.txt     # Python dependencies
  test/
    test-manga-ocr.py    # OCR test script
  build/
    build-python.bat     # PyInstaller build script (optional)
  icons/                 # App icons (all sizes + .ico)
  venv/                  # Python virtual environment (gitignored)
```

## Credits

- **OCR Model**: [manga-ocr](https://github.com/kha-white/manga-ocr) by [kha-white](https://github.com/kha-white) — this project provides the desktop UI and translation layer, not the OCR model itself.
- **Translation**: Direct Google Translate API calls with MyMemory fallback — no external translation library required.