// Rikai Image Extractor
// Scans pages for manga/webtoon images, handles lazy-loading, dynamic content, and infinite scroll.

interface ImageRecord {
  id: string;
  element: HTMLElement;
  src: string;
  width: number;
  height: number;
  rect: DOMRect;
  isLazy: boolean;
  isBackground: boolean;
  source: string;
}

const MIN_IMAGE_AREA = 50_000;
const MIN_DIMENSION = 100;

const SKIP_URL_PATTERNS: RegExp[] = [
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
  /\.svg$/i,
  /1x1/i,
  /transparent/i,
  /ad[s]?[\./]/i,
  /tracking/i,
  /beacon/i,
  /analytics/i,
];

const LAZY_ATTRS: string[] = [
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
  private _images: Map<string, ImageRecord>;
  private _idCounter: number;
  private _observer: MutationObserver | null;
  private _intersectionObserver: IntersectionObserver | null;
  private _scrollHandler: (() => void) | null;
  private _active: boolean;

  constructor() {
    this._images = new Map();
    this._idCounter = 0;
    this._observer = null;
    this._intersectionObserver = null;
    this._scrollHandler = null;
    this._active = false;
  }

  scan(): ImageRecord[] {
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

  observe(): void {
    if (this._active) return;
    this._active = true;

    this._observer = new MutationObserver((mutations) => {
      let changed = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            this._processNewElement(node as HTMLElement);
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

    this._intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this._processNewElement(entry.target as HTMLElement);
          }
        }
      },
      { rootMargin: "200px" }
    );

    this._observeAllImages();

    this._scrollHandler = this._throttle(() => {
      this._checkForNewImages();
    }, 500);

    window.addEventListener("scroll", this._scrollHandler, { passive: true });

    console.log("[Rikai] Image extractor: observation started.");
  }

  disconnect(): void {
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

  getImages(): ImageRecord[] {
    return Array.from(this._images.values());
  }

  private _scanImgElements(): void {
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      this._addImageElement(img, "img");
    }
  }

  private _scanPictureElements(): void {
    const pictures = document.querySelectorAll("picture");
    for (const picture of pictures) {
      const img = picture.querySelector("img");
      if (img) {
        this._addImageElement(img, "picture");
        continue;
      }
      const sources = picture.querySelectorAll("source");
      const bestSource = this._pickBestSource(sources);
      if (bestSource) {
        this._addBackgroundImage(picture, bestSource.srcset || bestSource.src, "picture");
      }
    }
  }

  private _scanBackgroundImages(): void {
    const allElements = document.querySelectorAll(
      "div, section, figure, li, article, span, a"
    );
    for (const el of allElements) {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (!bg || bg === "none") continue;
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

  private _scanCanvasElements(): void {
    const canvases = document.querySelectorAll("canvas");
    for (const canvas of canvases) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width >= MIN_DIMENSION && rect.height >= MIN_DIMENSION) {
        this._addCanvasElement(canvas);
      }
    }
  }

  private _processNewElement(element: HTMLElement): void {
    if (!(element instanceof HTMLElement)) return;

    if (element instanceof HTMLImageElement) {
      this._addImageElement(element, "img");
      return;
    }

    const imgs = element.querySelectorAll("img");
    for (const img of imgs) {
      this._addImageElement(img, "img");
    }

    const pictures = element.querySelectorAll("picture");
    for (const picture of pictures) {
      const img = picture.querySelector("img");
      if (img) {
        this._addImageElement(img, "picture");
      }
    }

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

    const canvases = element.querySelectorAll("canvas");
    for (const canvas of canvases) {
      this._addCanvasElement(canvas);
    }
  }

  private _addImageElement(img: HTMLImageElement, source: string): void {
    const src = this._resolveImgSrc(img);
    if (!src) return;

    const rect = img.getBoundingClientRect();
    const isLazy = this._isLazyLoaded(img);

    if (!this._isValidMangaImage(src, rect.width, rect.height)) {
      if (!isLazy) return;
    }

    const id = this._makeId(img);
    if (this._images.has(id)) {
      const existing = this._images.get(id)!;
      existing.src = src;
      existing.rect = img.getBoundingClientRect();
      existing.width = img.naturalWidth || img.width;
      existing.height = img.naturalHeight || img.height;
      return;
    }

    const record: ImageRecord = {
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

  private _addBackgroundImage(element: Element, url: string, source: string): void {
    const id = this._makeId(element);
    if (this._images.has(id)) return;

    const rect = element.getBoundingClientRect();
    if (!this._isValidMangaImage(url, rect.width, rect.height)) return;

    const record: ImageRecord = {
      id,
      element: element as HTMLElement,
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

  private _addCanvasElement(canvas: HTMLCanvasElement): void {
    const id = this._makeId(canvas);
    if (this._images.has(id)) return;

    const rect = canvas.getBoundingClientRect();

    const record: ImageRecord = {
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

  private _resolveImgSrc(img: HTMLImageElement): string | null {
    const currentSrc = img.currentSrc || img.src;
    if (currentSrc && !this._isPlaceholderSrc(currentSrc)) {
      return currentSrc;
    }

    for (const attr of LAZY_ATTRS) {
      const val = img.getAttribute(attr);
      if (val && !this._isPlaceholderSrc(val)) {
        return val;
      }
    }

    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const best = this._pickBestSrcset(srcset);
      if (best) return best;
    }

    if (currentSrc && currentSrc.startsWith("data:")) {
      for (const attr of LAZY_ATTRS) {
        const val = img.getAttribute(attr);
        if (val) return val;
      }
      return null;
    }

    return currentSrc || null;
  }

  private _isLazyLoaded(img: HTMLImageElement): boolean {
    if (img.loading === "lazy") return true;
    for (const attr of LAZY_ATTRS) {
      if (img.hasAttribute(attr)) return true;
    }
    const classes = img.className || "";
    if (/\b(lazy|lazyload|lazy-load|defer|placeholder)\b/i.test(classes)) {
      return true;
    }
    return false;
  }

  private _isPlaceholderSrc(src: string): boolean {
    if (!src) return true;
    if (src.startsWith("data:image/gif;base64,R0lGOD")) return true;
    if (src.startsWith("data:image/svg")) return true;
    if (/placeholder/i.test(src)) return true;
    if (/blank\.(gif|png)/i.test(src)) return true;
    return false;
  }

  private _updateImageSrc(img: HTMLImageElement): void {
    const id = this._makeId(img);
    const newSrc = this._resolveImgSrc(img);

    if (this._images.has(id)) {
      const record = this._images.get(id)!;
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

  private _isValidMangaImage(url: string, width: number, height: number): boolean {
    if (width < MIN_DIMENSION || height < MIN_DIMENSION) return false;
    if (width * height < MIN_IMAGE_AREA) return false;
    for (const pattern of SKIP_URL_PATTERNS) {
      if (pattern.test(url)) return false;
    }
    return true;
  }

  private _pickBestSrcset(srcset: string): string | null {
    const entries = srcset.split(",").map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      const descriptor = parts[1] || "1x";
      const value = parseFloat(descriptor) || 1;
      return { url, value, isWidth: descriptor.endsWith("w") };
    });

    if (entries.length === 0) return null;

    entries.sort((a, b) => {
      if (a.isWidth !== b.isWidth) return a.isWidth ? -1 : 1;
      return b.value - a.value;
    });

    return entries[0].url;
  }

  private _pickBestSource(sources: NodeListOf<HTMLSourceElement>): HTMLSourceElement | null {
    let best: HTMLSourceElement | null = null;
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

  private _observeAllImages(): void {
    if (!this._intersectionObserver) return;
    for (const record of this._images.values()) {
      if (record.element && record.element instanceof HTMLElement) {
        this._intersectionObserver.observe(record.element);
      }
    }
  }

  private _checkForNewImages(): void {
    const imgs = document.querySelectorAll("img");
    let newCount = 0;

    for (const img of imgs) {
      const id = this._makeId(img);
      if (!this._images.has(id)) {
        this._addImageElement(img, "img");
        newCount++;
      }
    }

    this._scanBackgroundImages();

    if (newCount > 0) {
      console.log(`[Rikai] Image extractor: found ${newCount} new images after scroll.`);
      this._observeAllImages();
    }
  }

  private _makeId(element: Element): string {
    const el = element as any;
    if (!el._rikaiId) {
      el._rikaiId = `rikai-img-${this._idCounter++}`;
    }
    return el._rikaiId;
  }

  private _throttle(fn: () => void, delay: number): () => void {
    let lastCall = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return function (this: any) {
      const now = Date.now();
      if (now - lastCall >= delay) {
        lastCall = now;
        fn.apply(this);
      } else if (!timer) {
        timer = setTimeout(() => {
          lastCall = Date.now();
          timer = null;
          fn.apply(this);
        }, delay - (now - lastCall));
      }
    };
  }
}

(window as any).RikaiImageExtractor = ImageExtractor;
