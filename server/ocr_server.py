#!/usr/bin/env python3
"""
Rikai OCR Server — minimal HTTP server wrapping manga-ocr.

Usage:
    pip install -r server/requirements.txt
    python server/ocr_server.py [--port PORT]
"""

import argparse
import io
import json
import ssl
import sys
import time
import urllib.request
import urllib.parse
from collections import OrderedDict
from http.server import HTTPServer, BaseHTTPRequestHandler

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# ── Model ────────────────────────────────────────────────────────────

mocr = None

def load_model():
    global mocr
    t0 = time.time()
    print("Loading manga-ocr model...")
    from manga_ocr import MangaOcr
    mocr = MangaOcr()
    print(f"Model loaded in {time.time() - t0:.1f}s")


def preprocess_image(img):
    from PIL import Image, ImageEnhance, ImageFilter

    if img.mode not in ("RGB", "L"):
        try:
            img = img.convert("RGB")
        except Exception:
            img = img.convert("L")

    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass

    w, h = img.size
    if w < 200 or h < 200:
        scale = max(200 / max(w, 1), 200 / max(h, 1))
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    if img.mode == "RGB":
        img = ImageEnhance.Contrast(img).enhance(1.3)
        img = img.filter(ImageFilter.SHARPEN)
    else:
        img = ImageEnhance.Contrast(img).enhance(1.4)
        img = img.filter(ImageFilter.SHARPEN)

    return img


def recognize(image_bytes: bytes) -> str:
    from PIL import Image
    img = Image.open(io.BytesIO(image_bytes))
    img = preprocess_image(img)
    return mocr(img)


# ── Translation ──────────────────────────────────────────────────────

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

_ssl_ctx = ssl.create_default_context()

# Simple LRU cache for translations (avoids repeated calls for same text)
_translate_cache = OrderedDict()
_CACHE_MAX = 128


def _cache_get(text, target):
    key = (text, target)
    if key in _translate_cache:
        _translate_cache.move_to_end(key)
        return _translate_cache[key]
    return None


def _cache_set(text, target, result):
    key = (text, target)
    _translate_cache[key] = result
    _translate_cache.move_to_end(key)
    while len(_translate_cache) > _CACHE_MAX:
        _translate_cache.popitem(last=False)


def _try_google_gtx(text, target):
    params = urllib.parse.urlencode({
        "client": "gtx", "sl": "auto", "tl": target,
        "dt": "t", "q": text,
    })
    url = f"https://translate.googleapis.com/translate_a/single?{params}"
    req = urllib.request.Request(url, headers={
        "User-Agent": _USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=10, context=_ssl_ctx) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data and data[0]:
        return "".join(seg[0] for seg in data[0] if seg and seg[0])
    return ""


def _try_google_post(text, target):
    post_data = urllib.parse.urlencode({
        "client": "gtx", "sl": "auto", "tl": target,
        "dt": "t", "q": text,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://translate.googleapis.com/translate_a/single",
        data=post_data,
        headers={
            "User-Agent": _USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=10, context=_ssl_ctx) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data and data[0]:
        return "".join(seg[0] for seg in data[0] if seg and seg[0])
    return ""


def _try_mymemory(text, target):
    """MyMemory free translation API (5000 chars/day, no key needed)."""
    params = urllib.parse.urlencode({
        "q": text,
        "langpair": f"ja|{target}",
    })
    url = f"https://api.mymemory.translated.net/get?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=10, context=_ssl_ctx) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("responseStatus") == 200:
        translated = data.get("responseData", {}).get("translatedText", "")
        if translated:
            return translated
    raise RuntimeError(data.get("responseDetails", "MyMemory error"))


def translate_text(text, target="en", max_retries=3):
    if not text or not text.strip():
        return ""

    cached = _cache_get(text, target)
    if cached is not None:
        return cached

    google_endpoints = [_try_google_gtx, _try_google_post]
    last_error = ""
    google_rate_limited = False

    for attempt in range(max_retries):
        # On first attempt, try Google. On retries after 429, skip straight to MyMemory.
        if google_rate_limited:
            endpoints_to_try = [_try_mymemory]
        else:
            endpoints_to_try = google_endpoints + [_try_mymemory]

        for endpoint in endpoints_to_try:
            try:
                result = endpoint(text, target)
                if result:
                    _cache_set(text, target, result)
                    return result
                last_error = "Empty response"
            except urllib.error.HTTPError as e:
                last_error = str(e)
                if e.code == 429:
                    google_rate_limited = True
                    break  # Skip remaining Google endpoints
                continue
            except Exception as e:
                last_error = str(e)
                continue

        if attempt < max_retries - 1:
            wait = 2 * (2 ** attempt)
            print(f"[translate] Attempt {attempt + 1} failed: {last_error}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)

    raise RuntimeError(f"Translation failed: {last_error}")


# ── HTTP Handler ─────────────────────────────────────────────────────

class OcrHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {"status": "ok", "model": "manga-ocr-base"})
        else:
            self._json_response(404, {"error": "Not found"})

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "Empty request body"})
            return
        raw_body = self.rfile.read(content_length)
        if self.path == "/ocr":
            self._handle_ocr(raw_body)
        elif self.path == "/translate":
            self._handle_translate(raw_body)
        else:
            self._json_response(404, {"error": "Not found"})

    def _handle_ocr(self, raw_body):
        try:
            t0 = time.time()
            text = recognize(raw_body)
            elapsed_ms = (time.time() - t0) * 1000

            if not text or not text.strip():
                from PIL import Image
                raw_img = Image.open(io.BytesIO(raw_body)).convert("RGB")
                t1 = time.time()
                text = mocr(raw_img)
                elapsed_ms += (time.time() - t1) * 1000

            self._json_response(200, {"text": text, "time_ms": round(elapsed_ms, 1)})
        except Exception as e:
            self._json_response(500, {"error": f"OCR failed: {e}"})

    def _handle_translate(self, raw_body):
        try:
            data = json.loads(raw_body.decode("utf-8"))
            text = data.get("text", "")
            target = data.get("target", "en")

            if not text.strip():
                self._json_response(200, {"translation": ""})
                return

            t0 = time.time()
            translation = translate_text(text, target)
            elapsed_ms = (time.time() - t0) * 1000
            self._json_response(200, {
                "translation": translation,
                "time_ms": round(elapsed_ms, 1),
            })
        except Exception as e:
            self._json_response(200, {
                "translation": "",
                "error": str(e),
            })

    def _json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        if args and ("4" in str(args[0])[:1] or "5" in str(args[0])[:1]):
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description="Rikai OCR Server")
    parser.add_argument("--port", type=int, default=54321)
    args = parser.parse_args()

    load_model()

    server = HTTPServer(("127.0.0.1", args.port), OcrHandler)
    print(f"\n  Rikai OCR server running at:")
    print(f"  -> http://127.0.0.1:{args.port}/ocr\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
