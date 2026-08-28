#!/usr/bin/env python3
"""
Test manga-ocr on a local image.

Usage:
    # Standalone (loads model directly):
    python test/test-manga-ocr.py [image_path]

    # Via server (requires server to be running):
    python test/test-manga-ocr.py --server [image_path]

Output: only the recognized text, one line.
"""

import sys
import time
from pathlib import Path


def test_standalone(image_path: Path):
    """Load model directly and OCR the image."""
    from manga_ocr import MangaOcr

    t0 = time.time()
    mocr = MangaOcr()
    load_time = time.time() - t0
    print(f"[model loaded in {load_time:.1f}s]", file=sys.stderr)

    t0 = time.time()
    text = mocr(str(image_path))
    infer_time = (time.time() - t0) * 1000
    print(f"[inference: {infer_time:.0f}ms]", file=sys.stderr)

    print(text)


def test_server(image_path: Path, port: int = 54321):
    """Send image to running OCR server via HTTP."""
    import urllib.request
    import json

    url = f"http://127.0.0.1:{port}/ocr"
    image_bytes = image_path.read_bytes()

    t0 = time.time()
    req = urllib.request.Request(
        url,
        data=image_bytes,
        headers={"Content-Type": "application/octet-stream"},
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    total_ms = (time.time() - t0) * 1000

    print(f"[server round-trip: {total_ms:.0f}ms, inference: {result.get('time_ms', '?')}ms]", file=sys.stderr)
    print(result["text"])


def main():
    # Parse --server flag
    use_server = "--server" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--server"]

    if not args:
        image_path = Path("test.webp")
    else:
        image_path = Path(args[0])

    if not image_path.is_file():
        print(f"Error: file not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    if use_server:
        test_server(image_path)
    else:
        test_standalone(image_path)


if __name__ == "__main__":
    main()
