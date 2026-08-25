// Rikai Text Detector
// Finds likely text regions in manga images using connected-component labeling.

interface TextDetectorOptions {
  maxAnalysisWidth: number;
  brightnessThreshold: number;
  saturationThreshold: number;
  minRegionPx: number;
  minFillRatio: number;
  minAreaPx: number;
  maxCoverage: number;
  paddingRatio: number;
  mergeOverlap: number;
}

interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULTS: TextDetectorOptions = {
  maxAnalysisWidth: 900,
  brightnessThreshold: 175,
  saturationThreshold: 42,
  minRegionPx: 16,
  minFillRatio: 0.34,
  minAreaPx: 140,
  maxCoverage: 0.72,
  paddingRatio: 0.035,
  mergeOverlap: 0.35,
};

class TextDetector {
  private _opts: TextDetectorOptions;

  constructor(options: Partial<TextDetectorOptions> = {}) {
    this._opts = { ...DEFAULTS, ...options };
  }

  detect(image: HTMLImageElement | ImageBitmap): BBox[] {
    const naturalW = (image as any).naturalWidth || (image as any).width;
    const naturalH = (image as any).naturalHeight || (image as any).height;
    if (!naturalW || !naturalH) return [];

    const scaleDown = Math.min(
      1,
      this._opts.maxAnalysisWidth / Math.max(naturalW, naturalH)
    );
    const w = Math.max(1, Math.round(naturalW * scaleDown));
    const h = Math.max(1, Math.round(naturalH * scaleDown));

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    const mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const r = data[p],
        g = data[p + 1],
        b = data[p + 2];
      const min = Math.min(r, g, b);
      const max = Math.max(r, g, b);
      if (
        min >= this._opts.brightnessThreshold &&
        max - min <= this._opts.saturationThreshold
      ) {
        mask[i] = 1;
      }
    }

    const boxes = this._findComponents(mask, w, h);
    const merged = this._mergeBoxes(boxes, this._opts.mergeOverlap);
    const scaleUp = 1 / scaleDown;

    return merged
      .filter((b) => {
        const coverage = (b.width * b.height) / (w * h);
        return coverage <= this._opts.maxCoverage;
      })
      .map((b) => {
        const padX = b.width * this._opts.paddingRatio;
        const padY = b.height * this._opts.paddingRatio;
        let x = (b.x - padX) * scaleUp;
        let y = (b.y - padY) * scaleUp;
        let bw = (b.width + padX * 2) * scaleUp;
        let bh = (b.height + padY * 2) * scaleUp;

        x = Math.max(0, Math.min(x, naturalW - 1));
        y = Math.max(0, Math.min(y, naturalH - 1));
        bw = Math.max(1, Math.min(bw, naturalW - x));
        bh = Math.max(1, Math.min(bh, naturalH - y));

        return {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(bw),
          height: Math.round(bh),
        };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }

  private _findComponents(mask: Uint8Array, w: number, h: number): BBox[] {
    const visited = new Uint8Array(w * h);
    const boxes: BBox[] = [];
    const stack = new Int32Array(w * h);

    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || visited[start]) continue;

      let sp = 0;
      stack[sp++] = start;
      visited[start] = 1;

      let minX = w,
        minY = h,
        maxX = 0,
        maxY = 0,
        area = 0;

      while (sp > 0) {
        const idx = stack[--sp];
        const x = idx % w;
        const y = (idx / w) | 0;
        area++;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        if (x > 0 && mask[idx - 1] && !visited[idx - 1]) {
          visited[idx - 1] = 1;
          stack[sp++] = idx - 1;
        }
        if (x < w - 1 && mask[idx + 1] && !visited[idx + 1]) {
          visited[idx + 1] = 1;
          stack[sp++] = idx + 1;
        }
        if (y > 0 && mask[idx - w] && !visited[idx - w]) {
          visited[idx - w] = 1;
          stack[sp++] = idx - w;
        }
        if (y < h - 1 && mask[idx + w] && !visited[idx + w]) {
          visited[idx + w] = 1;
          stack[sp++] = idx + w;
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const fill = area / (bw * bh);

      if (
        bw >= this._opts.minRegionPx &&
        bh >= this._opts.minRegionPx &&
        area >= this._opts.minAreaPx &&
        fill >= this._opts.minFillRatio
      ) {
        boxes.push({ x: minX, y: minY, width: bw, height: bh });
      }
    }

    return boxes;
  }

  private _mergeBoxes(boxes: BBox[], overlapThreshold: number): BBox[] {
    if (boxes.length === 0) return boxes;

    let current = boxes.map((b) => ({ ...b }));
    let mergedAny = true;

    while (mergedAny) {
      mergedAny = false;
      const next: BBox[] = [];

      for (const box of current) {
        let absorbed = false;

        for (let i = 0; i < next.length; i++) {
          const target = next[i];
          const inter = this._intersectionRatio(box, target);
          if (inter >= overlapThreshold) {
            next[i] = this._union(target, box);
            absorbed = true;
            mergedAny = true;
            break;
          }
        }

        if (!absorbed) next.push({ ...box });
      }

      current = next;
    }

    return current;
  }

  private _intersectionRatio(a: BBox, b: BBox): number {
    const ix = Math.max(
      0,
      Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    );
    const iy = Math.max(
      0,
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    );
    const inter = ix * iy;
    if (inter === 0) return 0;
    const smaller = Math.min(a.width * a.height, b.width * b.height);
    return inter / smaller;
  }

  private _union(a: BBox, b: BBox): BBox {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x, y, width: right - x, height: bottom - y };
  }
}

(window as any).RikaiTextDetector = TextDetector;
