// Rikai Overlay Module — OverlayRenderer
//
// All in-page Rikai UI lives inside a single fixed-position root element with
// a Shadow DOM, so website CSS can never bleed in and vice versa.

interface OverlayBinding {
  el: HTMLElement;
  img: HTMLImageElement | Element;
  box: { x: number; y: number; width: number; height: number };
  naturalW: number;
  naturalH: number;
}

interface StatusOptions {
  tone?: "loading" | "info" | "success" | "error";
  title: string;
  detail?: string;
  percent?: number | null;
  indeterminate?: boolean;
  onRetry?: () => void;
}

const TOKENS = `
  --rikai-bg:            #070b16;
  --rikai-panel:         rgba(11, 17, 32, 0.92);
  --rikai-panel-soft:    rgba(13, 20, 38, 0.78);
  --rikai-border:        rgba(94, 234, 212, 0.28);
  --rikai-border-strong: rgba(34, 211, 238, 0.55);
  --rikai-accent:        #22d3ee;
  --rikai-accent-2:      #818cf8;
  --rikai-text:          #e6edf7;
  --rikai-muted:         #7c89a6;
  --rikai-success:       #34d399;
  --rikai-warning:       #fbbf24;
  --rikai-error:         #f87171;
  --rikai-glow:          0 0 12px rgba(34, 211, 238, 0.22), 0 0 32px rgba(129, 140, 248, 0.10);
  --rikai-shadow:        0 10px 32px rgba(2, 6, 16, 0.55);
`;

const STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :host { all: initial; }
  .root {
    ${TOKENS}
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    pointer-events: none;
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto,
                 "Helvetica Neue", Arial, sans-serif;
  }
  .panel {
    position: absolute;
    max-width: 360px;
    padding: 8px 12px;
    background: linear-gradient(160deg, var(--rikai-panel), var(--rikai-panel-soft));
    border: 1px solid var(--rikai-border);
    border-radius: 8px;
    color: var(--rikai-text);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    box-shadow: var(--rikai-shadow), var(--rikai-glow);
    overflow-wrap: break-word;
    line-height: 1.35;
    letter-spacing: 0.01em;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 180ms ease, transform 180ms ease;
    will-change: left, top, width;
  }
  .panel.visible { opacity: 1; transform: translateY(0); }
  .status {
    position: absolute;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    min-width: 230px;
    max-width: 320px;
    background: linear-gradient(160deg, var(--rikai-panel), var(--rikai-panel-soft));
    border: 1px solid var(--rikai-border-strong);
    border-radius: 10px;
    box-shadow: var(--rikai-shadow), var(--rikai-glow);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    padding: 12px 16px 14px;
    color: var(--rikai-text);
    transition: opacity 220ms ease, transform 220ms ease;
  }
  .status.hidden { opacity: 0; transform: translate(-50%, -8px); visibility: hidden; }
  .status-brand { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .brand-mark { font-size: 12px; font-weight: 700; letter-spacing: 0.42em; color: var(--rikai-accent); text-transform: uppercase; }
  .brand-sub { font-size: 9px; letter-spacing: 0.24em; color: var(--rikai-muted); text-transform: uppercase; }
  .status-title { font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 8px; }
  .status-detail { font-size: 11px; color: var(--rikai-muted); line-height: 1.45; }
  .bar { position: relative; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.08); overflow: hidden; margin-top: 9px; }
  .bar-fill { position: absolute; inset: 0; width: 0%; border-radius: 2px; background: linear-gradient(90deg, var(--rikai-accent), var(--rikai-accent-2)); box-shadow: 0 0 8px rgba(34,211,238,0.5); transition: width 200ms ease; }
  .bar-fill.indeterminate { width: 36%; animation: rikai-sweep 1.15s ease-in-out infinite; }
  @keyframes rikai-sweep { 0% { left: -36%; } 100% { left: 100%; } }
  .status[data-tone="error"] .status-title { color: var(--rikai-error); }
  .status[data-tone="error"] { border-color: rgba(248, 113, 113, 0.5); }
  .status[data-tone="success"] .status-title { color: var(--rikai-success); }
  .status[data-tone="loading"] .status-title { color: var(--rikai-warning); }
  .retry-btn {
    pointer-events: auto;
    cursor: pointer;
    margin-top: 10px;
    padding: 6px 18px;
    float: right;
    background: transparent;
    border: 1px solid var(--rikai-border-strong);
    border-radius: 6px;
    color: var(--rikai-accent);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    transition: background 150ms ease, box-shadow 150ms ease;
  }
  .retry-btn:hover { background: rgba(34, 211, 238, 0.12); box-shadow: var(--rikai-glow); }
`;

const VIEWPORT_MARGIN = 8;

class OverlayRenderer {
  private _root: HTMLElement | null;
  private _shadow: ShadowRoot | null;
  private _layer: HTMLElement | null;
  private _bindings: Map<string, OverlayBinding>;
  private _rafId: number | null;
  private _dirty: boolean;
  private _resizeObserver: ResizeObserver | null;
  private _intervalId: ReturnType<typeof setInterval> | null;
  private _listeners: [EventTarget, string, EventListener][];
  private _visible: boolean;
  private _statusEl: HTMLElement | null;
  private _retryBtn: HTMLElement | null;
  private _onRetry: (() => void) | null;

  constructor() {
    this._root = null;
    this._shadow = null;
    this._layer = null;
    this._bindings = new Map();
    this._rafId = null;
    this._dirty = true;
    this._resizeObserver = null;
    this._intervalId = null;
    this._listeners = [];
    this._visible = false;
    this._statusEl = null;
    this._retryBtn = null;
    this._onRetry = null;
  }

  get isActive(): boolean {
    return this._root !== null;
  }

  activate(): void {
    if (this._root) return;

    const root = document.createElement("div");
    root.id = "rikai-overlay-root";
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "2147483000";
    root.style.pointerEvents = "none";
    document.documentElement.appendChild(root);

    const shadow = root.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    shadow.appendChild(style);

    const layer = document.createElement("div");
    layer.className = "root";
    shadow.appendChild(layer);

    this._root = root;
    this._shadow = shadow;
    this._layer = layer;
    this._visible = true;

    this._startTracking();
  }

  deactivate(): void {
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this._intervalId != null) clearInterval(this._intervalId);
    this._intervalId = null;

    for (const [target, type, fn] of this._listeners) {
      target.removeEventListener(type, fn);
    }
    this._listeners = [];

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    this._bindings.clear();
    if (this._root) {
      this._root.remove();
      this._root = null;
      this._shadow = null;
      this._layer = null;
    }
    this._hideStatusInternal();
    this._visible = false;
  }

  setPanelsVisible(visible: boolean): void {
    this._visible = visible;
    if (!this._layer) return;
    for (const binding of this._bindings.values()) {
      binding.el.classList.toggle("visible", visible);
    }
  }

  get isVisible(): boolean {
    return this._visible;
  }

  addPanel(
    regionId: string,
    imgElement: HTMLImageElement | Element,
    box: { x: number; y: number; width: number; height: number },
    translation: string
  ): void {
    if (!this._layer || !translation) return;

    let binding = this._bindings.get(regionId);
    if (!binding) {
      const el = document.createElement("div");
      el.className = "panel";
      this._layer.appendChild(el);
      binding = { el } as unknown as OverlayBinding;
      this._bindings.set(regionId, binding);

      if (this._resizeObserver && imgElement instanceof Element) {
        this._resizeObserver.observe(imgElement);
      }
    }

    if (binding) {
      binding.img = imgElement;
      binding.box = box;
      binding.naturalW = (imgElement as any).naturalWidth || (imgElement as any).width || 1;
      binding.naturalH = (imgElement as any).naturalHeight || (imgElement as any).height || 1;

      binding.el.textContent = translation;
      this._dirty = true;
    }
  }

  prune(): void {
    for (const [id, binding] of this._bindings) {
      if (!binding.img || !(binding.img as any).isConnected) {
        binding.el.remove();
        this._bindings.delete(id);
      }
    }
  }

  clear(): void {
    for (const binding of this._bindings.values()) binding.el.remove();
    this._bindings.clear();
  }

  setStatus(opts: StatusOptions): void {
    if (!this._layer) return;

    if (!this._statusEl) {
      this._statusEl = document.createElement("div");
      this._statusEl.className = "status";
      this._statusEl.innerHTML = `
        <div class="status-brand">
          <span class="brand-mark">Rikai</span>
          <span class="brand-sub">Translation System</span>
        </div>
        <div class="status-title"></div>
        <div class="status-detail" hidden></div>
        <div class="bar"><div class="bar-fill"></div></div>
        <button class="retry-btn" hidden>RETRY</button>
      `;
      this._layer.appendChild(this._statusEl);
      this._retryBtn = this._statusEl.querySelector(".retry-btn");
    }

    const s = this._statusEl;
    s.dataset.tone = opts.tone || "info";
    s.querySelector(".status-title")!.textContent = opts.title || "";
    s.querySelector(".brand-mark")!.textContent = "RIKAI";
    (s.querySelector(".brand-mark") as HTMLElement).style.color =
      s.dataset.tone === "error" ? "var(--rikai-error)" : "";

    const detail = s.querySelector(".status-detail") as HTMLElement;
    if (opts.detail) {
      detail.hidden = false;
      detail.textContent = opts.detail;
    } else {
      detail.hidden = true;
    }

    const fill = s.querySelector(".bar-fill") as HTMLElement;
    if (s.dataset.tone === "error") {
      (s.querySelector(".bar") as HTMLElement).hidden = true;
    } else {
      (s.querySelector(".bar") as HTMLElement).hidden = false;
      if (opts.indeterminate || typeof opts.percent !== "number") {
        fill.classList.add("indeterminate");
        fill.style.width = "";
      } else {
        fill.classList.remove("indeterminate");
        fill.style.width = `${Math.max(0, Math.min(100, opts.percent))}%`;
      }
    }

    if (!this._retryBtn) return;
    this._retryBtn.hidden = !opts.onRetry;
    this._onRetry = opts.onRetry || null;
    this._retryBtn.onclick = () => this._onRetry?.();

    s.classList.remove("hidden");
  }

  hideStatus(): void {
    this._hideStatusInternal();
  }

  private _hideStatusInternal(): void {
    this._statusEl?.classList.add("hidden");
  }

  private _startTracking(): void {
    const markDirty = () => {
      this._dirty = true;
    };

    const onScroll = () => markDirty();
    const onResize = () => markDirty();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    this._listeners.push(
      [window, "scroll", onScroll as EventListener],
      [window, "resize", onResize as EventListener]
    );

    this._resizeObserver = new ResizeObserver(markDirty);
    this._intervalId = setInterval(markDirty, 800);

    const tick = () => {
      if (this._dirty) {
        this._dirty = false;
        this._updatePositions();
      }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  private _updatePositions(): void {
    if (!this._layer) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (const binding of this._bindings.values()) {
      const { el, img, box } = binding;
      if (!img || !(img as any).isConnected) continue;

      const rect = (img as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const naturalW = binding.naturalW || (img as any).naturalWidth || 1;
      const naturalH = binding.naturalH || (img as any).naturalHeight || 1;
      const scaleX = rect.width / naturalW;
      const scaleY = rect.height / naturalH;

      const bx = rect.left + box.x * scaleX;
      const by = rect.top + box.y * scaleY;
      const bw = Math.max(box.width * scaleX, 40);

      const targetWidth = Math.min(
        Math.max(bw + 24, 90),
        360,
        vw - VIEWPORT_MARGIN * 2
      );
      el.style.width = `${Math.round(targetWidth)}px`;
      el.style.maxHeight = `${Math.round(Math.max(vh - VIEWPORT_MARGIN * 2, 60))}px`;

      const panelRect = el.getBoundingClientRect();
      let px = bx + bw / 2 - panelRect.width / 2;
      let py = by - panelRect.height - 6;

      if (py < VIEWPORT_MARGIN) py = by + box.height * scaleY + 6;
      px = Math.max(VIEWPORT_MARGIN, Math.min(px, vw - panelRect.width - VIEWPORT_MARGIN));
      py = Math.max(VIEWPORT_MARGIN, Math.min(py, vh - panelRect.height - VIEWPORT_MARGIN));

      el.style.left = `${Math.round(px)}px`;
      el.style.top = `${Math.round(py)}px`;
      el.classList.toggle("visible", this._visible);
    }
  }
}

(window as any).RikaiOverlay = OverlayRenderer;
