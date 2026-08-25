// Rikai Translator Module — TranslationService
// Translates Japanese text to English via the MyMemory API.

interface TranslationResult {
  translation: string;
  success: boolean;
}

interface TranslatorConfig {
  apiUrl: string;
  sourceLang: string;
  targetLang: string;
  maxCharsPerRequest: number;
  requestDelay: number;
}

const CONFIG: TranslatorConfig = {
  apiUrl: "https://api.mymemory.translated.net/get",
  sourceLang: "ja",
  targetLang: "en",
  maxCharsPerRequest: 500,
  requestDelay: 150,
};

class Translator {
  private _lastRequestTime: number;
  private _memory: Map<string, string>;

  constructor() {
    this._lastRequestTime = 0;
    this._memory = new Map();
  }

  async translateJapanese(japanese: string): Promise<TranslationResult> {
    const text = (japanese || "").trim();
    if (!text) return { translation: "", success: false };

    if (this._memory.has(text)) {
      return { translation: this._memory.get(text)!, success: true };
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

      const translated = String(data.responseData?.translatedText || "").trim();
      if (!translated) throw new Error("Empty translation.");

      this._remember(text, translated);
      return { translation: translated, success: true };
    } catch (err: any) {
      console.warn(
        `[Rikai] Translation failed for "${text.slice(0, 24)}…":`,
        err?.message || err
      );
      return { translation: "", success: false };
    }
  }

  private _remember(ja: string, en: string): void {
    if (this._memory.size >= 500) this._memory.clear();
    this._memory.set(ja, en);
  }

  private async _rateLimit(): Promise<void> {
    const wait = CONFIG.requestDelay - (Date.now() - this._lastRequestTime);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastRequestTime = Date.now();
  }
}

(window as any).RikaiTranslator = Translator;
