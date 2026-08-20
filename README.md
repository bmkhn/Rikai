# Rikai

Translate raw manga and webtoons directly on the page where you read them.

## What is Rikai?

Rikai is a Chrome extension that:

1. Detects Japanese/Korean text in manga/webtoon images via OCR
2. Translates the text into English
3. Renders the translation directly over the original text on the page
4. Lets you toggle translations on/off without re-processing

## Project Structure

```
rikai/
├── manifest.json              # Chrome Manifest V3
├── package.json               # npm dependencies (tesseract.js)
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.js               # Popup logic (sends commands to content script)
│   └── popup.css              # Popup styles
├── content/
│   ├── content.js             # Content script (message handler, orchestrator)
│   ├── image-extractor.js     # Finds manga/webtoon images on the page
│   ├── ocr.js                 # Text detection using Tesseract.js
│   └── translator.js          # Japanese/Korean → English translation
├── lib/
│   └── tesseract/             # Vendored Tesseract.js files (for Chrome extension)
├── icons/
│   ├── icon16.png             # Extension icon (16x16)
│   ├── icon48.png             # Extension icon (48x48)
│   └── icon128.png            # Extension icon (128x128)
├── scripts/
│   ├── generate-icons.js      # Generates placeholder icons
│   └── setup-ocr.js           # Copies Tesseract.js files to lib/
└── README.md
```

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or later)
- [Google Chrome](https://www.google.com/chrome/) (or Chromium-based browser)

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-username/rikai.git
cd rikai

# 2. Install dependencies and setup OCR
npm install
npm run setup-ocr

# 3. Generate placeholder icons (if needed)
npm run generate-icons
```

### Load as Unpacked Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `rikai/` project folder
5. The Rikai extension should appear in your extensions list
6. Pin the extension to your toolbar for easy access

### Verify It Works

1. Open any webpage (e.g., a manga reader site)
2. Click the Rikai extension icon
3. Click **Translate Page**
4. Open DevTools console (F12) on that page
5. You should see `[Rikai] Found N images.` and OCR results logged

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm install` | Install npm dependencies (tesseract.js) |
| `npm run setup-ocr` | Copy Tesseract.js files to `lib/tesseract/` |
| `npm run generate-icons` | Generate placeholder extension icons |

### OCR Notes

Tesseract.js downloads trained data files (`jpn.traineddata`, `kor.traineddata`) at runtime from a CDN. For offline use, you may need to manually download them and place them in `lib/tesseract/traineddata/`.

See: [Tesseract.js Training Data](https://github.com/naptha/tesseract.js/blob/main/docs/training-data.md)

## How It Works (Current State)

### Communication Flow

```
Popup (popup.js)          Content Script (content.js)
       │                          │
       │  chrome.tabs.sendMessage │
       │ ───────────────────────> │
       │                          │
       │  sendResponse(...)       │
       │ <─────────────────────── │
```

1. User clicks **Translate Page** in the popup
2. Popup sends a `translatePage` message to the content script in the active tab
3. Content script receives the command, logs it, counts images on the page, and responds
4. Popup displays the result

### Current Capabilities

- ✅ Loads as a valid Chrome Manifest V3 extension
- ✅ Shows popup with "Translate Page" button
- ✅ Communicates button click to content script
- ✅ Content script receives and acknowledges the command
- ✅ **Image extraction** — scans for `<img>`, `<picture>`, `<canvas>`, and CSS background images
- ✅ **Lazy-loading support** — resolves `data-src`, `loading="lazy"`, and 10+ lazy-load attributes
- ✅ **Dynamic content** — MutationObserver detects images added after page load
- ✅ **Infinite scroll** — IntersectionObserver + scroll handler catches images as they load
- ✅ **Smart filtering** — skips icons, ads, avatars, favicons, SVGs, and tiny images
- ✅ **OCR** — Tesseract.js detects Japanese/Korean text regions with bounding boxes
- ✅ **Text region extraction** — groups words into lines, filters noise, sorts by position
- ✅ **Translation** — MyMemory API translates Japanese/Korean text to English
- ✅ **Batch translation** — processes all text regions with rate limiting

## Architecture

Modules are organized by concern. Each is an independent, replaceable unit:

| Concern             | Location                     | Status        |
|---------------------|------------------------------|---------------|
| Message handling    | `content/content.js`         | ✅ Done       |
| Image extraction    | `content/image-extractor.js` | ✅ Done       |
| OCR                 | `content/ocr.js`             | ✅ Done       |
| Translation         | `content/translator.js`      | ✅ Done       |
| Reader detection    | `content/reader-detector.js` | 🔲 Planned   |
| Text masking        | `content/masker.js`          | 🔲 Planned   |
| Overlay rendering   | `content/overlay.js`         | 🔲 Planned   |
| Translation state   | `content/state.js`           | 🔲 Planned   |

## Technology Choices

- **Plain JavaScript** — no build step needed for the foundation; Chrome extensions run JS natively
- **Chrome Manifest V3** — current standard; uses service workers instead of background pages
- **`activeTab` + `scripting` permissions** — minimal permissions; only interacts with the tab the user clicks on
- **Content script at `document_idle`** — injected after the page DOM is ready
- **Tesseract.js v5** — client-side OCR for Japanese/Korean text detection (replaceable with cloud API)
- **MyMemory API** — free translation API, no API key required (5000 words/day)
- **Web-accessible resources** — allows content scripts to load Tesseract.js WASM/worker files

## What's Next

1. **Text masking** — cover original text in the image
2. **Overlay rendering** — position English text over the masked regions
3. **Toggle mechanism** — show/hide translations without re-processing
4. **Reader detection** — identify manga/webtoon reader patterns automatically

## License

TBD
