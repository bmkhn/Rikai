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
│   ├── content.js             # Content script (message handler, orchestrator)
│   └── image-extractor.js     # Finds manga/webtoon images on the page
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
- ✅ **Image extraction** — scans for `<img>`, `<picture>`, `<canvas>`, and CSS background images
- ✅ **Lazy-loading support** — resolves `data-src`, `loading="lazy"`, and 10+ lazy-load attributes
- ✅ **Dynamic content** — MutationObserver detects images added after page load
- ✅ **Infinite scroll** — IntersectionObserver + scroll handler catches images as they load
- ✅ **Smart filtering** — skips icons, ads, avatars, favicons, SVGs, and tiny images
- ✅ **Re-scan** — can re-scan the page without restarting observation

## Architecture

Modules are organized by concern. Each is an independent, replaceable unit:

| Concern             | Location                     | Status        |
|---------------------|------------------------------|---------------|
| Message handling    | `content/content.js`         | ✅ Done       |
| Image extraction    | `content/image-extractor.js` | ✅ Done       |
| Reader detection    | `content/reader-detector.js` | 🔲 Planned   |
| OCR                 | `content/ocr.js`             | 🔲 Planned   |
| Language detection  | `content/language.js`        | 🔲 Planned   |
| Translation         | `content/translator.js`      | 🔲 Planned   |
| Text masking        | `content/masker.js`          | 🔲 Planned   |
| Overlay rendering   | `content/overlay.js`         | 🔲 Planned   |
| Translation state   | `content/state.js`           | 🔲 Planned   |

## Technology Choices

- **Plain JavaScript** — no build step needed for the foundation; Chrome extensions run JS natively
- **Chrome Manifest V3** — current standard; uses service workers instead of background pages
- **`activeTab` + `scripting` permissions** — minimal permissions; only interacts with the tab the user clicks on
- **Content script at `document_idle`** — injected after the page DOM is ready
- **No external dependencies** — keeps the extension lightweight and auditable

## What's Next

1. **OCR integration** — detect text regions in images (Tesseract.js or similar)
2. **Translation API** — translate detected Japanese/Korean to English
3. **Text masking** — cover original text in the image
4. **Overlay rendering** — position English text over the masked regions
5. **Toggle mechanism** — show/hide translations without re-processing

## License

TBD
