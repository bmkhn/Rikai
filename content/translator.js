// Rikai Translator Module
// Translates detected text regions from Japanese/Korean to English.
// Uses MyMemory API (free, no API key required for basic usage).
// Designed to be replaceable — swap this module for any translation API.

/**
 * @typedef {Object} TranslationResult
 * @property {string} originalText  - The source text
 * @property {string} translatedText - The translated English text
 * @property {string} sourceLang    - Source language code ("ja", "ko")
 * @property {string} targetLang    - Target language code ("en")
 * @property {number} confidence    - Translation confidence (0-1)
 * @property {boolean} success      - Whether translation succeeded
 */

/**
 * @typedef {Object} BatchTranslationResult
 * @property {string} imageId       - ID of the image
 * @property {number} regionIndex   - Index of the text region
 * @property {TranslationResult} translation - The translation result
 */

/**
 * Supported language pairs.
 */
const LANGUAGE_MAP = {
  jpn: "ja",
  jpn_vert: "ja",
  kor: "ko",
  eng: "en",
};

/**
 * Translation API configuration.
 */
const TRANSLATOR_CONFIG = {
  // MyMemory API endpoint (free, no API key required)
  apiUrl: "https://api.mymemory.translated.net/get",

  // Maximum characters per request (MyMemory limit)
  maxCharsPerRequest: 500,

  // Delay between API calls to avoid rate limiting (ms)
  requestDelay: 100,

  // Maximum concurrent requests
  maxConcurrent: 3,

  // Default target language
  targetLang: "en",

  // Email for MyMemory API (optional, improves rate limit)
  // If you have a MyMemory account, add your email here
  email: null,

  // Fallback translation (used when API fails)
  fallbackTranslation: "[translation failed]",
};

class Translator {
  constructor() {
    this._requestQueue = [];
    this._activeRequests = 0;
    this._lastRequestTime = 0;
  }

  /**
   * Translate a single text string.
   * @param {string} text - The text to translate
   * @param {string} sourceLang - Source language code (e.g., "ja", "ko")
   * @returns {Promise<TranslationResult>}
   */
  async translateText(text, sourceLang) {
    if (!text || text.trim().length === 0) {
      return {
        originalText: text,
        translatedText: "",
        sourceLang,
        targetLang: TRANSLATOR_CONFIG.targetLang,
        confidence: 1,
        success: true,
      };
    }

    // Map Tesseract language codes to translation API codes
    const mappedSourceLang = LANGUAGE_MAP[sourceLang] || sourceLang;
    const targetLang = TRANSLATOR_CONFIG.targetLang;

    // Skip if already in target language
    if (mappedSourceLang === targetLang) {
      return {
        originalText: text,
        translatedText: text,
        sourceLang: mappedSourceLang,
        targetLang,
        confidence: 1,
        success: true,
      };
    }

    try {
      const result = await this._callTranslationApi(text, mappedSourceLang, targetLang);

      return {
        originalText: text,
        translatedText: result.text,
        sourceLang: mappedSourceLang,
        targetLang,
        confidence: result.confidence,
        success: true,
      };
    } catch (err) {
      console.error(`[Rikai] Translation failed for "${text.substring(0, 30)}...":`, err);

      return {
        originalText: text,
        translatedText: TRANSLATOR_CONFIG.fallbackTranslation,
        sourceLang: mappedSourceLang,
        targetLang,
        confidence: 0,
        success: false,
      };
    }
  }

  /**
   * Translate multiple text regions from OCR results.
   * @param {Array<{ imageId: string, regions: Array<{ text: string, lang: string }> }>} ocrResults
   * @param {function} [onProgress] - Callback with (completedCount, totalCount)
   * @returns {Promise<BatchTranslationResult[]>}
   */
  async translateOcrResults(ocrResults, onProgress) {
    const allTranslations = [];
    let totalRegions = 0;

    // Count total regions
    for (const result of ocrResults) {
      totalRegions += result.regions.length;
    }

    let completed = 0;

    for (const result of ocrResults) {
      for (let i = 0; i < result.regions.length; i++) {
        const region = result.regions[i];

        // Determine source language
        const sourceLang = region.lang || result.lang || "jpn";

        // Translate the text
        const translation = await this.translateText(region.text, sourceLang);

        allTranslations.push({
          imageId: result.imageId,
          regionIndex: i,
          translation,
        });

        completed++;
        if (onProgress) {
          onProgress(completed, totalRegions);
        }

        // Rate limiting
        await this._rateLimit();
      }
    }

    console.log(
      `[Rikai] Translation complete: ${allTranslations.length} regions processed.`
    );

    return allTranslations;
  }

  /**
   * Translate text regions for a single image.
   * @param {string} imageId
   * @param {Array<{ text: string, lang: string }>} regions
   * @returns {Promise<TranslationResult[]>}
   */
  async translateImageRegions(imageId, regions) {
    const translations = [];

    for (const region of regions) {
      const sourceLang = region.lang || "jpn";
      const translation = await this.translateText(region.text, sourceLang);
      translations.push(translation);

      await this._rateLimit();
    }

    return translations;
  }

  // ─── Private: API Calls ─────────────────────────────────────────────

  /**
   * Call the MyMemory translation API.
   * @param {string} text
   * @param {string} sourceLang
   * @param {string} targetLang
   * @returns {Promise<{ text: string, confidence: number }>}
   */
  async _callTranslationApi(text, sourceLang, targetLang) {
    // Truncate text if too long
    const truncatedText = text.substring(0, TRANSLATOR_CONFIG.maxCharsPerRequest);

    // Build URL with query parameters
    const params = new URLSearchParams({
      q: truncatedText,
      langpair: `${sourceLang}|${targetLang}`,
    });

    // Add email if configured (improves rate limit)
    if (TRANSLATOR_CONFIG.email) {
      params.set("de", TRANSLATOR_CONFIG.email);
    }

    const url = `${TRANSLATOR_CONFIG.apiUrl}?${params.toString()}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Translation API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.responseStatus !== 200 && data.responseStatus !== "200") {
      throw new Error(`Translation API error: ${data.responseDetails || "Unknown error"}`);
    }

    const translatedText = data.responseData?.translatedText || "";
    const confidence = data.responseData?.match || 0;

    return {
      text: translatedText,
      confidence: Math.min(1, Math.max(0, confidence / 100)),
    };
  }

  // ─── Private: Rate Limiting ─────────────────────────────────────────

  /**
   * Simple rate limiter to avoid hitting API limits.
   */
  async _rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this._lastRequestTime;

    if (timeSinceLastRequest < TRANSLATOR_CONFIG.requestDelay) {
      const waitTime = TRANSLATOR_CONFIG.requestDelay - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this._lastRequestTime = Date.now();
  }
}

// Export for use in content.js
if (typeof window !== "undefined") {
  window.RikaiTranslator = Translator;
}
