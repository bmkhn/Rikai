// Rikai OCR Module
// Detects text regions in manga/webtoon images using Tesseract.js.
// Designed to be replaceable — swap this module for a cloud OCR API later.

/**
 * @typedef {Object} TextRegion
 * @property {string} text        - The detected text content
 * @property {number} confidence  - Confidence score (0-1)
 * @property {{ x: number, y: number, width: number, height: number }} bbox
 *                                - Bounding box relative to the image
 * @property {string} lang        - Detected language code ("jpn", "kor", "eng", etc.)
 */

/**
 * @typedef {Object} OcrResult
 * @property {string} imageId     - ID of the image that was processed
 * @property {TextRegion[]} regions - Detected text regions
 * @property {string} imageLang   - Overall detected language for the image
 * @property {number} processingTime - Time taken in milliseconds
 */

/**
 * Supported OCR languages (Tesseract language codes).
 */
const SUPPORTED_LANGS = ["jpn", "jpn_vert", "kor"];

/**
 * OCR engine configuration.
 */
const OCR_CONFIG = {
  // Languages to detect (Tesseract trained data)
  langs: "jpn+kor",

  // Tesseract.js options
  tesseractOptions: {
    // Use LSTM engine for better accuracy
    legacy: false,
    // Enable page segmentation
    rectangle: undefined, // Process entire image
  },

  // Minimum confidence threshold to include a text region
  minConfidence: 0.3,

  // Maximum images to process concurrently
  maxConcurrent: 2,

  // Whether to use vertical Japanese text detection
  useVerticalJapanese: true,
};

class OcrEngine {
  constructor() {
    /** @type {Object|null} Tesseract.js worker */
    this._worker = null;
    this._initialized = false;
    this._initializing = false;
    this._initPromise = null;
  }

  /**
   * Initialize the Tesseract.js worker.
   * Must be called before processing images.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) return;
    if (this._initializing) return this._initPromise;

    this._initializing = true;
    this._initPromise = this._doInitialize();

    try {
      await this._initPromise;
    } finally {
      this._initializing = false;
    }
  }

  async _doInitialize() {
    console.log("[Rikai] OCR: Initializing Tesseract.js worker...");

    // Check if Tesseract.js is available
    if (typeof Tesseract === "undefined") {
      throw new Error(
        "Tesseract.js not loaded. Run 'npm run setup-ocr' and ensure lib/tesseract/ is in the extension."
      );
    }

    try {
      // Create a worker with language configuration
      this._worker = await Tesseract.createWorker(OCR_CONFIG.langs, 1, {
        // Logger for progress updates
        logger: (m) => {
          if (m.status === "recognizing text") {
            // Progress updates — could be used for UI
          }
        },
      });

      this._initialized = true;
      console.log("[Rikai] OCR: Worker initialized successfully.");
    } catch (err) {
      console.error("[Rikai] OCR: Failed to initialize worker:", err);
      throw err;
    }
  }

  /**
   * Process a single image and detect text regions.
   * @param {string} imageUrl - URL of the image to process
   * @param {string} imageId  - ID of the image record
   * @returns {Promise<OcrResult>}
   */
  async recognizeImage(imageUrl, imageId) {
    await this.initialize();

    const startTime = performance.now();

    try {
      // Run OCR on the image
      const result = await this._worker.recognize(imageUrl);

      const regions = this._extractRegions(result.data, imageId);
      const imageLang = this._detectImageLanguage(result.data);

      const processingTime = performance.now() - startTime;

      console.log(
        `[Rikai] OCR: Processed image ${imageId} in ${processingTime.toFixed(0)}ms, ` +
          `found ${regions.length} text regions (lang: ${imageLang}).`
      );

      return {
        imageId,
        regions,
        imageLang,
        processingTime,
      };
    } catch (err) {
      console.error(`[Rikai] OCR: Failed to process image ${imageId}:`, err);
      return {
        imageId,
        regions: [],
        imageLang: "unknown",
        processingTime: performance.now() - startTime,
      };
    }
  }

  /**
   * Process multiple images with concurrency control.
   * @param {Array<{ id: string, src: string }>} images
   * @param {function} [onProgress] - Callback with (completedCount, totalCount)
   * @returns {Promise<OcrResult[]>}
   */
  async recognizeImages(images, onProgress) {
    await this.initialize();

    const results = [];
    let completed = 0;
    const total = images.length;

    // Process in batches for concurrency control
    for (let i = 0; i < images.length; i += OCR_CONFIG.maxConcurrent) {
      const batch = images.slice(i, i + OCR_CONFIG.maxConcurrent);
      const batchResults = await Promise.all(
        batch.map((img) => this.recognizeImage(img.src, img.id))
      );
      results.push(...batchResults);
      completed += batch.length;

      if (onProgress) {
        onProgress(completed, total);
      }
    }

    return results;
  }

  /**
   * Terminate the worker and free resources.
   */
  async terminate() {
    if (this._worker) {
      await this._worker.terminate();
      this._worker = null;
      this._initialized = false;
      console.log("[Rikai] OCR: Worker terminated.");
    }
  }

  // ─── Private: Region Extraction ─────────────────────────────────────

  /**
   * Extract text regions from Tesseract.js recognition data.
   * Converts Tesseract's word/line data into our TextRegion format.
   * @param {Object} data - Tesseract.js recognition result data
   * @param {string} imageId
   * @returns {TextRegion[]}
   */
  _extractRegions(data, imageId) {
    const regions = [];

    if (!data || !data.words) return regions;

    // Group words into lines for better region detection
    const lines = this._groupWordsIntoLines(data.words);

    for (const line of lines) {
      if (line.text.trim().length === 0) continue;

      // Filter by confidence
      if (line.confidence < OCR_CONFIG.minConfidence) continue;

      // Filter out pure numbers/symbols that are likely noise
      if (this._isNoiseText(line.text)) continue;

      // Determine language of this specific region
      const lang = this._detectRegionLanguage(line);

      regions.push({
        text: line.text.trim(),
        confidence: line.confidence,
        bbox: line.bbox,
        lang,
      });
    }

    // Sort by position (top-to-bottom, right-to-left for manga)
    regions.sort((a, b) => {
      // Primary sort: vertical position (top to bottom)
      const yDiff = a.bbox.y - b.bbox.y;
      if (Math.abs(yDiff) > 10) return yDiff;

      // Secondary sort: horizontal position (right to left for manga)
      return b.bbox.x - a.bbox.x;
    });

    return regions;
  }

  /**
   * Group individual words into lines based on spatial proximity.
   */
  _groupWordsIntoLines(words) {
    if (words.length === 0) return [];

    const lines = [];
    let currentLine = {
      words: [words[0]],
      text: words[0].text,
      confidence: words[0].confidence,
      bbox: { ...words[0].bbox },
    };

    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      const prevWord = currentLine.words[currentLine.words.length - 1];

      // Check if this word is on the same line as the previous word
      if (this._areWordsOnSameLine(prevWord, word)) {
        currentLine.words.push(word);
        currentLine.text += " " + word.text;
        currentLine.confidence =
          (currentLine.confidence * (currentLine.words.length - 1) + word.confidence) /
          currentLine.words.length;
        // Expand bbox
        currentLine.bbox = this._mergeBboxes(currentLine.bbox, word.bbox);
      } else {
        lines.push(currentLine);
        currentLine = {
          words: [word],
          text: word.text,
          confidence: word.confidence,
          bbox: { ...word.bbox },
        };
      }
    }

    lines.push(currentLine);
    return lines;
  }

  /**
   * Check if two words are on the same line.
   */
  _areWordsOnSameLine(word1, word2) {
    const bbox1 = word1.bbox;
    const bbox2 = word2.bbox;

    // Vertical overlap check
    const overlapY = Math.min(bbox1.y + bbox1.height, bbox2.y + bbox2.height) - Math.max(bbox1.y, bbox2.y);
    const minHeight = Math.min(bbox1.height, bbox2.height);

    // Words are on the same line if they have significant vertical overlap
    // and are reasonably close horizontally
    const verticalOverlap = overlapY / minHeight > 0.5;
    const horizontalGap = Math.abs(bbox2.x - (bbox1.x + bbox1.width));
    const maxGap = Math.max(bbox1.width, bbox2.width) * 2;

    return verticalOverlap && horizontalGap < maxGap;
  }

  /**
   * Merge two bounding boxes into one.
   */
  _mergeBboxes(b1, b2) {
    const x = Math.min(b1.x, b2.x);
    const y = Math.min(b1.y, b2.y);
    const right = Math.max(b1.x + b1.width, b2.x + b2.width);
    const bottom = Math.max(b1.y + b1.height, b2.y + b2.height);
    return { x, y, width: right - x, height: bottom - y };
  }

  // ─── Private: Language Detection ────────────────────────────────────

  /**
   * Detect the primary language of the entire image.
   * @param {Object} data - Tesseract.js data
   * @returns {string}
   */
  _detectImageLanguage(data) {
    if (!data || !data.words || data.words.length === 0) return "unknown";

    const langCounts = {};
    for (const word of data.words) {
      const lang = word.lang || "unknown";
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    }

    // Find the most common language
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

  /**
   * Detect the language of a specific text region.
   */
  _detectRegionLanguage(word) {
    // Tesseract.js provides language info per word
    return word.lang || "unknown";
  }

  // ─── Private: Text Filtering ────────────────────────────────────────

  /**
   * Check if detected text is likely noise (not real manga text).
   */
  _isNoiseText(text) {
    // Pure numbers
    if (/^\d+[\.,]?\d*$/.test(text)) return true;

    // Very short and likely punctuation
    if (text.length <= 1 && /[^\w\u3000-\u9FFF\uAC00-\uD7AF]/.test(text)) return true;

    // Common OCR noise patterns
    if (/^[.\-_=*#@$%^&]+$/.test(text)) return true;

    return false;
  }
}

// Export for use in content.js
if (typeof window !== "undefined") {
  window.RikaiOcrEngine = OcrEngine;
}
