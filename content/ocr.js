// Rikai OCR Module
// Detects text regions in manga/webtoon images using Tesseract.js.
// Uses canvas drawImage to bypass CORS for cross-origin images.

/**
 * @typedef {Object} TextRegion
 * @property {string} text
 * @property {number} confidence
 * @property {{ x: number, y: number, width: number, height: number }} bbox
 * @property {string} lang
 */

/**
 * @typedef {Object} OcrResult
 * @property {string} imageId
 * @property {TextRegion[]} regions
 * @property {string} imageLang
 * @property {number} processingTime
 */

/**
 * Map from UI language selector to Tesseract language codes.
 */
const LANG_MAP = {
  jpn: "jpn",
  kor: "kor",
  both: "jpn+kor",
};

const OCR_CONFIG = {
  // Lower threshold — manga text is often stylized, so be more lenient
  minConfidence: 0.15,
  maxConcurrent: 1, // Process one at a time for stability
};

class OcrEngine {
  constructor() {
    this._worker = null;
    this._initialized = false;
    this._initializing = false;
    this._initPromise = null;
    /** @type {string} Currently loaded language(s) */
    this._loadedLangs = null;
  }

  async initialize(lang = "jpn") {
    const tesseractLang = LANG_MAP[lang] || lang;

    // If worker exists but with different language, terminate and re-init
    if (this._worker && this._loadedLangs !== tesseractLang) {
      console.log(`[Rikai] OCR: Language changed from ${this._loadedLangs} to ${tesseractLang}, reinitializing...`);
      await this.terminate();
    }

    if (this._initialized) return;
    if (this._initializing) return this._initPromise;
    this._initializing = true;
    this._initPromise = this._doInitialize(tesseractLang);
    try {
      await this._initPromise;
    } finally {
      this._initializing = false;
    }
  }

  async _doInitialize(langs) {
    console.log(`[Rikai] OCR: Initializing worker with languages: ${langs}`);

    if (typeof Tesseract === "undefined") {
      throw new Error("Tesseract.js not loaded.");
    }

    const extensionUrl = chrome.runtime.getURL("lib/tesseract/");

    this._worker = await Tesseract.createWorker(langs, 1, {
      logger: (m) => {
        if (m.status === "loading language traineddata") {
          console.log(`[Rikai] OCR: Downloading trained data: ${m.loadedName || m.progress}`);
        } else if (m.status === "initializing api") {
          console.log("[Rikai] OCR: Initializing Tesseract API...");
        } else if (m.status === "recognizing text") {
          // progress available here if needed
        }
      },
      workerPath: `${extensionUrl}worker.min.js`,
    });

    this._loadedLangs = langs;
    this._initialized = true;
    console.log(`[Rikai] OCR: Worker initialized with languages: ${langs}`);
  }

  /**
   * Process a single image element.
   * @param {HTMLImageElement|HTMLCanvasElement} element
   * @param {string} imageId
   * @returns {Promise<OcrResult>}
   */
  async recognizeImage(element, imageId) {
    await this.initialize();

    const startTime = performance.now();

    try {
      const canvas = this._imageToCanvas(element);
      console.log(`[Rikai] OCR: Processing ${imageId} (${canvas.width}×${canvas.height})`);

      const result = await this._worker.recognize(canvas);

      const regions = this._extractRegions(result.data, imageId);
      const imageLang = this._detectImageLanguage(result.data);

      const processingTime = performance.now() - startTime;
      console.log(
        `[Rikai] OCR: Done ${imageId} in ${processingTime.toFixed(0)}ms — ` +
          `${regions.length} text regions found (lang: ${imageLang})`
      );

      // Debug: log raw words count
      const wordCount = result.data?.words?.length || 0;
      const meanConf = wordCount > 0
        ? (result.data.words.reduce((s, w) => s + w.confidence, 0) / wordCount).toFixed(1)
        : "N/A";
      console.log(`[Rikai] OCR: Raw words: ${wordCount}, mean confidence: ${meanConf}`);

      if (wordCount > 0 && regions.length === 0) {
        console.log("[Rikai] OCR: Words detected but filtered out (below threshold or noise)");
        // Log first few raw words for debugging
        const sample = result.data.words.slice(0, 5).map((w) => `"${w.text}" (${w.confidence.toFixed(1)}, ${w.lang})`);
        console.log("[Rikai] OCR: Sample raw words:", sample);
      }

      return { imageId, regions, imageLang, processingTime };
    } catch (err) {
      console.error(`[Rikai] OCR: Failed to process ${imageId}:`, err);
      return {
        imageId,
        regions: [],
        imageLang: "unknown",
        processingTime: performance.now() - startTime,
      };
    }
  }

  /**
   * Process multiple images.
   * @param {Array<{ id: string, element: HTMLImageElement|HTMLCanvasElement }>} images
   * @param {string} lang - Language selection ("jpn", "kor", or "both")
   * @param {function} [onProgress]
   * @returns {Promise<OcrResult[]>}
   */
  async recognizeImages(images, lang = "jpn", onProgress) {
    await this.initialize(lang);

    const results = [];
    let completed = 0;
    const total = images.length;

    for (let i = 0; i < images.length; i += OCR_CONFIG.maxConcurrent) {
      const batch = images.slice(i, i + OCR_CONFIG.maxConcurrent);
      const batchResults = await Promise.all(
        batch.map((img) => this.recognizeImage(img.element, img.id))
      );
      results.push(...batchResults);
      completed += batch.length;

      if (onProgress) {
        onProgress(completed, total);
      }
    }

    return results;
  }

  async terminate() {
    if (this._worker) {
      await this._worker.terminate();
      this._worker = null;
      this._initialized = false;
      this._loadedLangs = null;
      console.log("[Rikai] OCR: Worker terminated.");
    }
  }

  // ─── Private: CORS Bypass ───────────────────────────────────────────

  _imageToCanvas(element) {
    const canvas = document.createElement("canvas");
    const width = element.naturalWidth || element.width;
    const height = element.naturalHeight || element.height;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(element, 0, 0, width, height);
    return canvas;
  }

  // ─── Private: Region Extraction ─────────────────────────────────────

  _extractRegions(data, imageId) {
    const regions = [];
    if (!data || !data.words) return regions;

    const lines = this._groupWordsIntoLines(data.words);

    for (const line of lines) {
      if (line.text.trim().length === 0) continue;
      if (line.confidence < OCR_CONFIG.minConfidence) continue;
      if (this._isNoiseText(line.text)) continue;

      regions.push({
        text: line.text.trim(),
        confidence: line.confidence,
        bbox: line.bbox,
        lang: line.lang || "unknown",
      });
    }

    regions.sort((a, b) => {
      const yDiff = a.bbox.y - b.bbox.y;
      if (Math.abs(yDiff) > 10) return yDiff;
      return b.bbox.x - a.bbox.x;
    });

    return regions;
  }

  _groupWordsIntoLines(words) {
    if (words.length === 0) return [];

    const lines = [];
    let currentLine = {
      words: [words[0]],
      text: words[0].text,
      confidence: words[0].confidence,
      bbox: { ...words[0].bbox },
      lang: words[0].lang,
    };

    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      const prevWord = currentLine.words[currentLine.words.length - 1];

      if (this._areWordsOnSameLine(prevWord, word)) {
        currentLine.words.push(word);
        currentLine.text += " " + word.text;
        currentLine.confidence =
          (currentLine.confidence * (currentLine.words.length - 1) + word.confidence) /
          currentLine.words.length;
        currentLine.bbox = this._mergeBboxes(currentLine.bbox, word.bbox);
      } else {
        lines.push(currentLine);
        currentLine = {
          words: [word],
          text: word.text,
          confidence: word.confidence,
          bbox: { ...word.bbox },
          lang: word.lang,
        };
      }
    }

    lines.push(currentLine);
    return lines;
  }

  _areWordsOnSameLine(word1, word2) {
    const b1 = word1.bbox;
    const b2 = word2.bbox;
    const overlapY = Math.min(b1.y + b1.height, b2.y + b2.height) - Math.max(b1.y, b2.y);
    const minHeight = Math.min(b1.height, b2.height);
    const verticalOverlap = overlapY / minHeight > 0.5;
    const horizontalGap = Math.abs(b2.x - (b1.x + b1.width));
    const maxGap = Math.max(b1.width, b2.width) * 2;
    return verticalOverlap && horizontalGap < maxGap;
  }

  _mergeBboxes(b1, b2) {
    const x = Math.min(b1.x, b2.x);
    const y = Math.min(b1.y, b2.y);
    const right = Math.max(b1.x + b1.width, b2.x + b2.width);
    const bottom = Math.max(b1.y + b1.height, b2.y + b2.height);
    return { x, y, width: right - x, height: bottom - y };
  }

  _detectImageLanguage(data) {
    if (!data || !data.words || data.words.length === 0) return "unknown";
    const langCounts = {};
    for (const word of data.words) {
      const lang = word.lang || "unknown";
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    }
    let maxCount = 0;
    let primaryLang = "unknown";
    for (const [lang, count] of Object.entries(langCounts)) {
      if (count > maxCount) {
        maxCount = count;
        primaryLang = lang;
      }
    }
    return primaryLang;
  }

  _isNoiseText(text) {
    if (/^\d+[.,]?\d*$/.test(text)) return true;
    if (text.length <= 1 && /[^\w\u3000-\u9FFF\uAC00-\uD7AF]/.test(text)) return true;
    if (/^[.\-_=*#@$%^&]+$/.test(text)) return true;
    return false;
  }
}

if (typeof window !== "undefined") {
  window.RikaiOcrEngine = OcrEngine;
}
