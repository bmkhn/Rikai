// Rikai Overlay Module
// Renders translation overlays: masks original text and displays English translations.

/**
 * @typedef {Object} OverlayConfig
 * @property {string} maskColor        - Color for masking original text
 * @property {number} maskOpacity      - Opacity of the mask (0-1)
 * @property {string} textColor        - Color of translated text
 * @property {number} fontSize         - Base font size in pixels
 * @property {string} fontFamily       - Font family for translated text
 * @property {string} backgroundColor  - Background behind translated text
 * @property {number} padding          - Padding around text in pixels
 * @property {number} maxWidth         - Max width of text bubble
 * @property {string} zIndex           - CSS z-index for overlays
 */

const DEFAULT_CONFIG = {
  maskColor: "#ffffff",
  maskOpacity: 0.95,
  textColor: "#1a1a1a",
  fontSize: 14,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  backgroundColor: "#ffffffee",
  padding: 4,
  maxWidth: 200,
  zIndex: "2147483647", // Max z-index to stay on top
  borderRadius: 3,
  shadow: "0 1px 3px rgba(0,0,0,0.3)",
};

/**
 * CSS class prefix for Rikai overlay elements.
 */
const CLASS_PREFIX = "rikai-overlay";

class Overlay {
  /**
   * @param {OverlayConfig} [config]
   */
  constructor(config = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };

    /** @type {HTMLElement[]} All created overlay elements */
    this._overlays = [];

    /** @type {HTMLElement|null} Container element */
    this._container = null;

    /** @type {boolean} Whether overlays are currently visible */
    this._visible = false;

    /** @type {CSSStyleSheet|null} Injected stylesheet */
    this._styleSheet = null;
  }

  /**
   * Render translation overlays for all translated regions.
   * @param {Array<{ imageId: string, regionIndex: number, translation: { originalText: string, translatedText: string, success: boolean } }>} translations
   * @param {Array<{ id: string, element: HTMLElement, rect: DOMRect, width: number, height: number }>} images
   * @param {Array<{ imageId: string, regions: Array<{ bbox: { x: number, y: number, width: number, height: number } }> }>} ocrResults
   */
  render(translations, images, ocrResults) {
    this.clear();

    // Create container for all overlays
    this._container = document.createElement("div");
    this._container.className = `${CLASS_PREFIX}-container`;
    this._container.setAttribute("data-rikai", "true");
    document.body.appendChild(this._container);

    // Inject styles
    this._injectStyles();

    // Build a lookup: imageId -> image record
    const imageMap = new Map();
    for (const img of images) {
      imageMap.set(img.id, img);
    }

    // Build a lookup: imageId -> OCR regions
    const ocrMap = new Map();
    for (const ocr of ocrResults) {
      ocrMap.set(ocr.imageId, ocr.regions);
    }

    // Render each translation
    for (const t of translations) {
      if (!t.translation.success || !t.translation.translatedText) continue;

      const image = imageMap.get(t.imageId);
      const ocrRegions = ocrMap.get(t.imageId);
      if (!image || !ocrRegions) continue;

      const region = ocrRegions[t.regionIndex];
      if (!region) continue;

      this._renderRegion(image, region.bbox, t.translation);
    }

    this._visible = true;
    console.log(`[Rikai] Overlay: Rendered ${this._overlays.length} translation overlays.`);
  }

  /**
   * Show all overlays.
   */
  show() {
    if (this._container) {
      this._container.style.display = "";
      this._visible = true;
    }
  }

  /**
   * Hide all overlays without removing them.
   */
  hide() {
    if (this._container) {
      this._container.style.display = "none";
      this._visible = false;
    }
  }

  /**
   * Toggle overlay visibility.
   * @returns {boolean} New visibility state
   */
  toggle() {
    if (this._visible) {
      this.hide();
    } else {
      this.show();
    }
    return this._visible;
  }

  /**
   * Get current visibility state.
   */
  isVisible() {
    return this._visible;
  }

  /**
   * Remove all overlay elements from the DOM.
   */
  clear() {
    for (const overlay of this._overlays) {
      overlay.remove();
    }
    this._overlays = [];

    if (this._container) {
      this._container.remove();
      this._container = null;
    }

    this._visible = false;
  }

  // ─── Private: Rendering ─────────────────────────────────────────────

  /**
   * Render a single translated region.
   * @param {Object} image - Image record
   * @param {{ x: number, y: number, width: number, height: number }} bbox - OCR bounding box
   * @param {{ originalText: string, translatedText: string }} translation
   */
  _renderRegion(image, bbox, translation) {
    const imageRect = image.rect;
    const imageElement = image.element;

    // Calculate the scale between the image's natural size and its displayed size
    // The OCR bbox is relative to the image's coordinate space
    // We need to map it to the page's coordinate space
    const scaleX = imageRect.width / (image.naturalWidth || image.width);
    const scaleY = imageRect.height / (image.naturalHeight || image.height);

    // Calculate position on the page
    // imageRect gives us the image's position on the page
    // bbox gives us the text position within the image
    const pageX = imageRect.left + bbox.x * scaleX;
    const pageY = imageRect.top + bbox.y * scaleY + window.scrollY;
    const pageW = bbox.width * scaleX;
    const pageH = bbox.height * scaleY;

    // Create mask element (covers original text)
    const mask = document.createElement("div");
    mask.className = `${CLASS_PREFIX}-mask`;
    mask.setAttribute("data-rikai", "true");
    mask.style.cssText = `
      position: absolute;
      left: ${pageX}px;
      top: ${pageY}px;
      width: ${pageW}px;
      height: ${pageH}px;
      background-color: ${this._config.maskColor};
      opacity: ${this._config.maskOpacity};
      z-index: ${this._config.zIndex};
      pointer-events: none;
    `;

    // Create text element (shows translation)
    const textEl = document.createElement("div");
    textEl.className = `${CLASS_PREFIX}-text`;
    textEl.setAttribute("data-rikai", "true");

    // Determine font size based on region height
    const fontSize = Math.max(10, Math.min(pageH * 0.7, this._config.fontSize));

    textEl.style.cssText = `
      position: absolute;
      left: ${pageX}px;
      top: ${pageY}px;
      width: ${pageW}px;
      min-height: ${pageH}px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: ${this._config.padding}px;
      background-color: ${this._config.backgroundColor};
      color: ${this._config.textColor};
      font-size: ${fontSize}px;
      font-family: ${this._config.fontFamily};
      line-height: 1.2;
      text-align: center;
      border-radius: ${this._config.borderRadius}px;
      box-shadow: ${this._config.shadow};
      z-index: ${this._config.zIndex};
      pointer-events: none;
      word-break: break-word;
      overflow: hidden;
    `;

    textEl.textContent = translation.translatedText;

    // Add to container
    this._container.appendChild(mask);
    this._container.appendChild(textEl);

    this._overlays.push(mask, textEl);
  }

  // ─── Private: Styles ────────────────────────────────────────────────

  /**
   * Inject a stylesheet for overlay animations and transitions.
   */
  _injectStyles() {
    if (this._styleSheet) return;

    const style = document.createElement("style");
    style.setAttribute("data-rikai", "true");
    style.textContent = `
      .${CLASS_PREFIX}-container {
        pointer-events: none;
      }
      .${CLASS_PREFIX}-mask {
        transition: opacity 0.2s ease;
      }
      .${CLASS_PREFIX}-text {
        transition: opacity 0.2s ease;
      }
    `;
    document.head.appendChild(style);
    this._styleSheet = style;
  }
}

// Export for use in content.js
if (typeof window !== "undefined") {
  window.RikaiOverlay = Overlay;
}
