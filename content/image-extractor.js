// Rikai Image Extractor
// Scans pages for manga/webtoon images, handles lazy-loading, dynamic content, and infinite scroll.

/**
 * @typedef {Object} ImageRecord
 * @property {string} id            - Unique identifier for this image
 * @property {HTMLImageElement|HTMLDivElement} element - The DOM element
 * @property {string} src           - The resolved image URL
 * @property {number} width         - Display width in pixels
 * @property {number} height        - Display height in pixels
 * @property {DOMRect} rect         - Bounding rect on the page
 * @property {boolean} isLazy       - Whether this image was lazy-loaded
 * @property {boolean} isBackground - Whether this is a CSS background image
 * @property {string} source        - How it was found ("img" | "background" | "canvas" | "picture")
 */

/**
 * Minimum area (width × height) in pixels for an image to be considered manga content.
 * Filters out icons, buttons, avatars, etc.
 */
const MIN_IMAGE_AREA = 50_000; // ~224×224

/**
 * Minimum dimension in either axis.
 */
const MIN_DIMENSION = 100;

/**
 * Common URL patterns to skip (non-manga images).
 */
const SKIP_URL_PATTERNS = [
  /gravatar\.com/i,
  /favicon/i,
  /logo\./i,
  /icon\./i,
  /avatar/i,
  /button/i,
  /badge/i,
  /emoji/i,
  /spinner/i,
  /loading\.(gif|svg)/i,
  /pixel\.(gif|png)/i,
  /spacer\.(gif|png)/i,
  /\.svg$/i, // Most SVGs are UI elements
  /1x1/i,
  /transparent/i,
  /ad[s]?[\./]/i,
  /tracking/i,
  /beacon/i,
  /analytics/i,
];

/**
 * Common lazy-loading attribute names used by various libraries and CDNs.
 */
const LAZY_ATTRS = [
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-orig-src",
  "data-lazyload",
  "data-defer-src",
  "data-hi-res-src",
  "data-full-src",
  "data-page-src",
  "data-img-url",
  "data-url",
];

class ImageExtractor {
  constructor() {
    /** @type {Map<string, ImageRecord>} */
    this._images = new Map();
    this._idCounter = 0;
    this._observer = null;
    this._intersectionObserver = null;
    this._scrollHandler = null;
    this._active = false;
  }

  /**
   * Perform a synchronous scan of the current DOM.
   * Returns all discovered ImageRecords.
   * @returns {ImageRecord[]}
   */
  scan() {
    this._images.clear();
    this._idCounter = 0;

    this._scanImgElements();
    this._scanPictureElements();
    this._scanBackgroundImages();
    this._scanCanvasElements();

    const results = Array.from(this._images.values());
    console.log(`[Rikai] Image extraction found ${results.length} manga-image candidates.`);
    return results;
  }

  /**
   * Start observing the DOM for dynamically added/changed images.
   * Handles MutationObserver, IntersectionObserver (for lazy-load triggers), and scroll events.
   */
  observe() {
    if (this._active) return;
    this._active = true;

    // MutationObserver: watch for new/changed elements
    this._observer = new MutationObserver((mutations) => {
      let changed = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            this._processNewElement(node);
            changed = true;
          }
        }
        if (mutation.type === "attributes" && mutation.attributeName) {
          const el = mutation.target;
          if (el instanceof HTMLImageElement) {
            this._updateImageSrc(el);
            changed = true;
          }
        }
      }
      if (changed) {
        console.log(
          `[Rikai] Image extractor: DOM changed, now tracking ${this._images.size} images.`
        );
      }
    });

    this._observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data-src", "data-lazy-src", "data-original", "loading", "style"],
    });

    // IntersectionObserver: detect when off-screen images enter the viewport
    // (triggers lazy-load scripts that replace placeholder URLs)
    this._intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this._processNewElement(entry.target);
          }
        }
      },
      { rootMargin: "200px" } // trigger a bit before images are visible
    );

    // Observe all current and future images for intersection
    this._observeAllImages();

    // Scroll handler: detect infinite scroll / load-more patterns
    this._scrollHandler = this._throttle(() => {
      this._checkForNewImages();
    }, 500);

    window.addEventListener("scroll", this._scrollHandler, { passive: true });

    console.log("[Rikai] Image extractor: observation started.");
  }

  /**
   * Stop all observation and clean up.
   */
  disconnect() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this._intersectionObserver) {
      this._intersectionObserver.disconnect();
      this._intersectionObserver = null;
    }
    if (this._scrollHandler) {
      window.removeEventListener("scroll", this._scrollHandler);
      this._scrollHandler = null;
    }
    this._active = false;
    console.log("[Rikai] Image extractor: observation stopped.");
  }

  /**
   * Get all currently tracked images.
   * @returns {ImageRecord[]}
   */
  getImages() {
    return Array.from(this._images.values());
  }

  // ─── Private: Scanning ──────────────────────────────────────────────

  /**
   * Scan for <img> elements.
   */
  _scanImgElements() {
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      this._addImageElement(img, "img");
    }
  }

  /**
   * Scan for <picture> elements with <source> children.
   */
  _scanPictureElements() {
    const pictures = document.querySelectorAll("picture");
    for (const picture of pictures) {
      // Prefer the <img> inside the <picture>, fall back to the best <source>
      const img = picture.querySelector("img");
      if (img) {
        this._addImageElement(img, "picture");
        continue;
      }

      // No <img> child — try to find the best source
      const sources = picture.querySelectorAll("source");
      const bestSource = this._pickBestSource(sources);
      if (bestSource) {
        this._addBackgroundImage(picture, bestSource.srcset || bestSource.src, "picture");
      }
    }
  }

  /**
   * Scan for elements with CSS background images that look like manga panels.
   */
  _scanBackgroundImages() {
    const allElements = document.querySelectorAll(
      "div, section, figure, li, article, span, a"
    );

    for (const el of allElements) {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (!bg || bg === "none") continue;

      // Extract URL from background-image: url("...")
      const urlMatch = bg.match(/url\(["']?(.*?)["']?\)/);
      if (!urlMatch) continue;

      const url = urlMatch[1];
      if (!url || url.startsWith("data:")) continue;

      const rect = el.getBoundingClientRect();
      if (this._isValidMangaImage(url, rect.width, rect.height)) {
        this._addBackgroundImage(el, url, "background");
      }
    }
  }

  /**
   * Scan for visible <canvas> elements (some readers render to canvas).
   */
  _scanCanvasElements() {
    const canvases = document.querySelectorAll("canvas");
    for (const canvas of canvases) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width >= MIN_DIMENSION && rect.height >= MIN_DIMENSION) {
        const url = canvas.toDataURL ? null : null; // Canvas doesn't have a URL
        this._addCanvasElement(canvas);
      }
    }
  }

  // ─── Private: Element Processing ────────────────────────────────────

  /**
   * Process a newly added DOM element and its children for images.
   */
  _processNewElement(element) {
    if (!(element instanceof HTMLElement)) return;

    // If this element is an img itself
    if (element instanceof HTMLImageElement) {
      this._addImageElement(element, "img");
      return;
    }

    // Check for img descendants
    const imgs = element.querySelectorAll("img");
    for (const img of imgs) {
      this._addImageElement(img, "img");
    }

    // Check for picture descendants
    const pictures = element.querySelectorAll("picture");
    for (const picture of pictures) {
      const img = picture.querySelector("img");
      if (img) {
        this._addImageElement(img, "picture");
      }
    }

    // Check for background images on this element and children
    const bgElements = element.querySelectorAll("div, section, figure, li, article");
    for (const el of [element, ...bgElements]) {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (bg && bg !== "none") {
        const urlMatch = bg.match(/url\(["']?(.*?)["']?\)/);
        if (urlMatch && urlMatch[1] && !urlMatch[1].startsWith("data:")) {
          this._addBackgroundImage(el, urlMatch[1], "background");
        }
      }
    }

    // Check for canvas
    const canvases = element.querySelectorAll("canvas");
    for (const canvas of canvases) {
      this._addCanvasElement(canvas);
    }
  }

  /**
   * Add or update an <img> element to the tracking map.
   */
  _addImageElement(img, source) {
    // Get the actual src, resolving lazy-loaded attributes
    const src = this._resolveImgSrc(img);
    if (!src) return;

    const rect = img.getBoundingClientRect();
    const isLazy = this._isLazyLoaded(img);

    if (!this._isValidMangaImage(src, rect.width, rect.height)) {
      // Even if it's small now, it might be lazy-loaded with a placeholder
      // Still track it if it has lazy attributes — it may load a full image
      if (!isLazy) return;
    }

    const id = this._makeId(img);
    if (this._images.has(id)) {
      // Update existing record
      const existing = this._images.get(id);
      existing.src = src;
      existing.rect = img.getBoundingClientRect();
      existing.width = img.naturalWidth || img.width;
      existing.height = img.naturalHeight || img.height;
      return;
    }

    /** @type {ImageRecord} */
    const record = {
      id,
      element: img,
      src,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      rect,
      isLazy,
      isBackground: false,
      source,
    };

    this._images.set(id, record);
  }

  /**
   * Add a CSS background image to the tracking map.
   */
  _addBackgroundImage(element, url, source) {
    const id = this._makeId(element);
    if (this._images.has(id)) return;

    const rect = element.getBoundingClientRect();
    if (!this._isValidMangaImage(url, rect.width, rect.height)) return;

    /** @type {ImageRecord} */
    const record = {
      id,
      element,
      src: url,
      width: rect.width,
      height: rect.height,
      rect,
      isLazy: false,
      isBackground: true,
      source,
    };

    this._images.set(id, record);
  }

  /**
   * Add a <canvas> element to the tracking map.
   */
  _addCanvasElement(canvas) {
    const id = this._makeId(canvas);
    if (this._images.has(id)) return;

    const rect = canvas.getBoundingClientRect();

    /** @type {ImageRecord} */
    const record = {
      id,
      element: canvas,
      src: "[canvas]",
      width: canvas.width,
      height: canvas.height,
      rect,
      isLazy: false,
      isBackground: false,
      source: "canvas",
    };

    this._images.set(id, record);
  }

  // ─── Private: Lazy-Loading Resolution ───────────────────────────────

  /**
   * Resolve the actual image source from an <img> element,
   * checking lazy-loading attributes if the current src is a placeholder.
   */
  _resolveImgSrc(img) {
    // Check if current src is a real image or a placeholder
    const currentSrc = img.currentSrc || img.src;
    if (currentSrc && !this._isPlaceholderSrc(currentSrc)) {
      return currentSrc;
    }

    // Try lazy-loading attributes
    for (const attr of LAZY_ATTRS) {
      const val = img.getAttribute(attr);
      if (val && !this._isPlaceholderSrc(val)) {
        return val;
      }
    }

    // Try srcset — pick the largest candidate
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const best = this._pickBestSrcset(srcset);
      if (best) return best;
    }

    // If current src is a data URI placeholder, skip it
    if (currentSrc && currentSrc.startsWith("data:")) {
      // Check if there's a non-data-src in attributes
      for (const attr of LAZY_ATTRS) {
        const val = img.getAttribute(attr);
        if (val) return val;
      }
      return null;
    }

    return currentSrc || null;
  }

  /**
   * Check if an <img> element is using lazy-loading.
   */
  _isLazyLoaded(img) {
    // Native lazy loading
    if (img.loading === "lazy") return true;

    // Common lazy-loading attributes
    for (const attr of LAZY_ATTRS) {
      if (img.hasAttribute(attr)) return true;
    }

    // Check for common lazy-loading classes
    const classes = img.className || "";
    if (/\b(lazy|lazyload|lazy-load|defer|placeholder)\b/i.test(classes)) {
      return true;
    }

    return false;
  }

  /**
   * Check if a src value looks like a placeholder (tiny image, data URI, etc.)
   */
  _isPlaceholderSrc(src) {
    if (!src) return true;
    if (src.startsWith("data:image/gif;base64,R0lGOD")) return true; // common 1x1 gif
    if (src.startsWith("data:image/svg")) return true; // SVG placeholder
    if (/placeholder/i.test(src)) return true;
    if (/blank\.(gif|png)/i.test(src)) return true;
    return false;
  }

  /**
   * Update a tracked image's src when its attributes change.
   */
  _updateImageSrc(img) {
    const id = this._makeId(img);
    const newSrc = this._resolveImgSrc(img);

    if (this._images.has(id)) {
      const record = this._images.get(id);
      if (newSrc && newSrc !== record.src) {
        record.src = newSrc;
        record.rect = img.getBoundingClientRect();
        record.width = img.naturalWidth || img.width;
        record.height = img.naturalHeight || img.height;
      }
    } else if (newSrc) {
      this._addImageElement(img, "img");
    }
  }

  // ─── Private: Validation ────────────────────────────────────────────

  /**
   * Check if an image URL and dimensions look like manga content.
   */
  _isValidMangaImage(url, width, height) {
    // Skip if dimensions are too small
    if (width < MIN_DIMENSION || height < MIN_DIMENSION) return false;

    // Skip if area is too small
    if (width * height < MIN_IMAGE_AREA) return false;

    // Skip known non-manga URL patterns
    for (const pattern of SKIP_URL_PATTERNS) {
      if (pattern.test(url)) return false;
    }

    return true;
  }

  // ─── Private: Source Selection ──────────────────────────────────────

  /**
   * Pick the best URL from a srcset string (largest width descriptor).
   */
  _pickBestSrcset(srcset) {
    const entries = srcset.split(",").map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      const descriptor = parts[1] || "1x";
      const value = parseFloat(descriptor) || 1;
      return { url, value, isWidth: descriptor.endsWith("w") };
    });

    if (entries.length === 0) return null;

    // Sort by value descending, prefer width descriptors
    entries.sort((a, b) => {
      if (a.isWidth !== b.isWidth) return a.isWidth ? -1 : 1;
      return b.value - a.value;
    });

    return entries[0].url;
  }

  /**
   * Pick the best <source> element from a <picture>.
   */
  _pickBestSource(sources) {
    let best = null;
    let bestWidth = 0;

    for (const source of sources) {
      const w = parseInt(source.getAttribute("sizes") || "0", 10) || 0;
      if (w > bestWidth || !best) {
        best = source;
        bestWidth = w;
      }
    }

    return best;
  }

  // ─── Private: Observation Helpers ───────────────────────────────────

  /**
   * Set up IntersectionObserver on all tracked image elements.
   */
  _observeAllImages() {
    if (!this._intersectionObserver) return;

    for (const record of this._images.values()) {
      if (record.element && record.element instanceof HTMLElement) {
        this._intersectionObserver.observe(record.element);
      }
    }
  }

  /**
   * On scroll, check if new images have appeared (infinite scroll).
   */
  _checkForNewImages() {
    // Quick scan: look for any new img elements not yet tracked
    const imgs = document.querySelectorAll("img");
    let newCount = 0;

    for (const img of imgs) {
      const id = this._makeId(img);
      if (!this._images.has(id)) {
        this._addImageElement(img, "img");
        newCount++;
      }
    }

    // Also re-scan background images in newly visible areas
    this._scanBackgroundImages();

    if (newCount > 0) {
      console.log(`[Rikai] Image extractor: found ${newCount} new images after scroll.`);
      this._observeAllImages();
    }
  }

  // ─── Private: Utilities ─────────────────────────────────────────────

  /**
   * Generate a stable ID for a DOM element.
   */
  _makeId(element) {
    if (!element._rikaiId) {
      element._rikaiId = `rikai-img-${this._idCounter++}`;
    }
    return element._rikaiId;
  }

  /**
   * Simple throttle utility.
   */
  _throttle(fn, delay) {
    let lastCall = 0;
    let timer = null;
    return function (...args) {
      const now = Date.now();
      if (now - lastCall >= delay) {
        lastCall = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          lastCall = Date.now();
          timer = null;
          fn.apply(this, args);
        }, delay - (now - lastCall));
      }
    };
  }
}

// Export for use in content.js
if (typeof window !== "undefined") {
  window.RikaiImageExtractor = ImageExtractor;
}
