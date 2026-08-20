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
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.js               # Popup logic (sends commands to content script)
│   └── popup.css              # Popup styles
├── content/
│   └── content.js             # Content script (runs on web pages)
├── icons/
│   ├── icon16.png             # Extension icon (16x16)
│   ├── icon48.png             # Extension icon (48x48)
│   └── icon128.png            # Extension icon (128x128)
├── scripts/
│   └── generate-icons.js      # Generates placeholder icons
└── README.md
```

## Setup

### Load as Unpacked Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `rikai/` project folder
5. The Rikai extension should appear in your extensions list

### Regenerate Icons

```bash
node scripts/generate-icons.js
```

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
- ✅ Content script counts `<img>` elements on the page

## Architecture (Planned)

Future modules will be organized by concern:

| Concern             | Future Location              |
|---------------------|------------------------------|
| Reader detection    | `content/reader-detector.js` |
| Image extraction    | `content/image-extractor.js` |
| OCR                 | `content/ocr.js`             |
| Language detection  | `content/language.js`        |
| Translation         | `content/translator.js`      |
| Text masking        | `content/masker.js`          |
| Overlay rendering   | `content/overlay.js`         |
| Translation state   | `content/state.js`           |

## Technology Choices

- **Plain JavaScript** — no build step needed for the foundation; Chrome extensions run JS natively
- **Chrome Manifest V3** — current standard; uses service workers instead of background pages
- **`activeTab` + `scripting` permissions** — minimal permissions; only interacts with the tab the user clicks on
- **Content script at `document_idle`** — injected after the page DOM is ready
- **No external dependencies** — keeps the extension lightweight and auditable

## What's Next

1. **Image extraction** — find and extract manga/webtoon images from the page
2. **OCR integration** — detect text regions in images (Tesseract.js or similar)
3. **Translation API** — translate detected Japanese/Korean to English
4. **Text masking** — cover original text in the image
5. **Overlay rendering** — position English text over the masked regions
6. **Toggle mechanism** — show/hide translations without re-processing

## License

TBD
