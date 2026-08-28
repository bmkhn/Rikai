#!/usr/bin/env python3
"""
Minimal test: kha-white/manga-ocr-base on a local image.
No ONNX, no Transformers.js — pure PyTorch + manga_ocr.

Usage:
    pip install manga-ocr
    python test/test-manga-ocr.py [image_path]

Output: only the recognized text, one line.
"""

import sys
from pathlib import Path

def main() -> None:
    image_path = Path(sys.argv[1] if len(sys.argv) > 1 else "test.webp")
    if not image_path.is_file():
        print(f"Error: file not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    from manga_ocr import MangaOcr

    mocr = MangaOcr()
    text = mocr(str(image_path))
    print(text)


if __name__ == "__main__":
    main()
