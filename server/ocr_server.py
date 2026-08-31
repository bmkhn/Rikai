#!/usr/bin/env python3
"""
Rikai OCR Server — minimal HTTP server wrapping manga-ocr.

Usage:
    pip install -r server/requirements.txt
    python server/ocr_server.py [--port PORT]

Endpoints:
    POST /ocr          Accept image bytes (any format), return JSON {"text": "..."}
    POST /translate    Accept JSON {"text": "...", "target": "en"}, return {"translation": "..."}
    GET  /health       Return {"status": "ok", "model": "manga-ocr-base"}
"""

import argparse
import io
import json
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

# Fix Windows console encoding for UTF-8 output
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# ── Model (loaded once at startup) ──────────────────────────────────

mocr = None

def load_model():
    global mocr
    t0 = time.time()
    print("Loading manga-ocr model...")
    from manga_ocr import MangaOcr
    mocr = MangaOcr()
    elapsed = time.time() - t0
    print(f"Model loaded in {elapsed:.1f}s")


def recognize(image_bytes: bytes) -> str:
    """Run manga-ocr on raw image bytes, return recognized text."""
    from PIL import Image
    img = Image.open(io.BytesIO(image_bytes))
    return mocr(img)


def translate_text(text: str, target: str = "en") -> str:
    """Translate text to target language using Google Translate (free, no API key)."""
    from deep_translator import GoogleTranslator
    if not text or not text.strip():
        return ""
    return GoogleTranslator(source="auto", target=target).translate(text)


# ── HTTP Handler ─────────────────────────────────────────────────────

class OcrHandler(BaseHTTPRequestHandler):
    """Handles POST /ocr, POST /translate, and GET /health."""

    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {"status": "ok", "model": "manga-ocr-base"})
        else:
            self._json_response(404, {"error": "Not found. Use POST /ocr or POST /translate"})

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
            self._json_response(404, {"error": "Not found. Use POST /ocr or POST /translate"})

    def _handle_ocr(self, raw_body: bytes):
        try:
            t0 = time.time()
            text = recognize(raw_body)
            elapsed_ms = (time.time() - t0) * 1000
            self._json_response(200, {
                "text": text,
                "time_ms": round(elapsed_ms, 1),
            })
        except Exception as e:
            self._json_response(500, {"error": str(e)})

    def _handle_translate(self, raw_body: bytes):
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
            self._json_response(500, {"error": str(e)})

    def _json_response(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Quiet logs: only log errors, not every request
        if args and ("4" in str(args[0])[:1] or "5" in str(args[0])[:1]):
            super().log_message(format, *args)


# ── Main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Rikai OCR Server")
    parser.add_argument("--port", type=int, default=54321, help="Port to listen on (default: 54321)")
    args = parser.parse_args()

    load_model()

    server = HTTPServer(("127.0.0.1", args.port), OcrHandler)
    print(f"\n  Rikai OCR server running at:")
    print(f"  -> http://127.0.0.1:{args.port}/ocr\n")
    print(f"  POST an image to get recognized text.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
