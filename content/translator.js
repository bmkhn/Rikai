// Rikai Translator Module — TranslationService
// Translates Japanese text to English via the MyMemory API
// (free, no key). Deliberately decoupled from OCR: it accepts plain strings
// and can be swapped for any provider without touching the rest of Rikai.

(() => {
  "use strict";

  const CONFIG = {
    apiUrl: "https://api.mymemory.translated.net/get",
    sourceLang: "ja",
    targetLang: "en",
    maxCharsPerRequest: 500,
    requestDelay: 150, // ms between calls (rate limit)
  };

  class Translator {
    constructor() {
      this._lastRequestTime = 0;
      /** @type {Map<string, string>} */
      this._memory = new Map();
    }

    /**
     * Translate a single Japanese string.
     * @param {string} japanese
     * @returns {Promise<{ translation: string, success: boolean }>}
     */
    async translateJapanese(japanese) {
      const text = (japanese || "").trim();
      if (!text) return { translation: "", success: false };

      // Exact-match memory cache
      if (this._memory.has(text)) {
        return { translation: this._memory.get(text), success: true };
      }

      try {
        await this._rateLimit();

        const params = new URLSearchParams({
          q: text.substring(0, CONFIG.maxCharsPerRequest),
          langpair: `${CONFIG.sourceLang}|${CONFIG.targetLang}`,
        });
        const response = await fetch(`${CONFIG.apiUrl}?${params.toString()}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const status = Number(data.responseStatus);
        if (status !== 200) {
          throw new Error(data.responseDetails || "Translation API error");
        }

        const translated = String(
          data.responseData?.translatedText || ""
        ).trim();
        if (!translated) throw new Error("Empty translation.");

        this._remember(text, translated);
        return { translation: translated, success: true };
      } catch (err) {
        console.warn(
          `[Rikai] Translation failed for "${text.slice(0, 24)}…":`,
          err?.message || err
        );
        return { translation: "", success: false };
      }
    }

    _remember(ja, en) {
      if (this._memory.size >= 500) this._memory.clear();
      this._memory.set(ja, en);
    }

    async _rateLimit() {
      const wait = CONFIG.requestDelay - (Date.now() - this._lastRequestTime);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._lastRequestTime = Date.now();
    }
  }

  window.RikaiTranslator = Translator;
})();
