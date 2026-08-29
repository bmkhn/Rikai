/**
 * Rikai Renderer — handles screen capture, OCR display, mode switching,
 * window dragging, and resizing.
 */

// ── State ────────────────────────────────────────────────────────

let currentMode = 'scanning'; // 'scanning' | 'reading'
let lastOcrText = '';
let isProcessing = false;

// ── DOM Elements ─────────────────────────────────────────────────

const body = document.body;
const scanFrame = document.getElementById('scan-frame');
const readingOverlay = document.getElementById('reading-overlay');
const ocrText = document.getElementById('ocr-text');
const ocrHint = document.getElementById('ocr-hint');
const ocrMeta = document.getElementById('ocr-meta');
const statusIcon = document.getElementById('status-icon');
const statusText = document.getElementById('status-text');
const modeToggle = document.getElementById('mode-toggle');
const capturePreview = document.getElementById('capture-preview');
const previewImg = document.getElementById('preview-img');
const dragHandle = document.getElementById('drag-handle');
const resizeHandle = document.getElementById('resize-handle');

// ── Mode Switching ───────────────────────────────────────────────

function setMode(mode) {
  currentMode = mode;

  if (mode === 'scanning') {
    body.className = 'mode-scanning';
    readingOverlay.classList.add('hidden');
    capturePreview.classList.add('hidden');
  } else if (mode === 'reading') {
    body.className = 'mode-reading';
    readingOverlay.classList.remove('hidden');
    capturePreview.classList.add('hidden');
    if (!lastOcrText) {
      ocrText.textContent = '';
      ocrHint.textContent = 'No text captured yet';
      ocrHint.classList.remove('hidden');
      ocrMeta.textContent = '';
    } else {
      ocrHint.textContent = 'Click anywhere to scan again';
      ocrHint.classList.remove('hidden');
    }
  }
}

function setStatus(text, dotClass) {
  statusText.textContent = text;
  statusIcon.className = `dot ${dotClass}`;
}

// ── OCR Capture ──────────────────────────────────────────────────

async function captureAndOcr() {
  if (isProcessing) return;
  isProcessing = true;

  setStatus('Capturing...', 'dot-yellow');
  scanFrame.classList.add('capturing');

  try {
    const result = await window.rikai.captureAndOcr();

    if (result.error) {
      setStatus('Error', 'dot-red');
      ocrText.textContent = result.error;
      ocrHint.classList.add('hidden');
      ocrMeta.textContent = '';
      setMode('reading');
      console.error('OCR error:', result.error);
    } else if (result.text) {
      lastOcrText = result.text;
      ocrText.textContent = result.text;
      ocrHint.classList.add('hidden');
      ocrMeta.textContent = `${result.ocr_time_ms || result.time_ms || '?'}ms`;
      setStatus('Text found', 'dot-green');
      setMode('reading');
    } else {
      setStatus('No text detected', 'dot-red');
      setTimeout(() => {
        if (!isProcessing) setStatus('Ready', 'dot-green');
      }, 2000);
    }
  } catch (err) {
    setStatus('Error', 'dot-red');
    ocrText.textContent = err.message;
    ocrHint.classList.add('hidden');
    ocrMeta.textContent = '';
    setMode('reading');
    console.error('Capture error:', err);
  } finally {
    isProcessing = false;
    scanFrame.classList.remove('capturing');
  }
}

// ── Window Dragging ──────────────────────────────────────────────
// Custom drag: detect mousedown + movement to distinguish drag from click.

let dragState = null;
const DRAG_THRESHOLD = 4; // pixels before we commit to a drag

function initDrag(e, element) {
  // Only left mouse button
  if (e.button !== 0) return;
  e.preventDefault();

  dragState = {
    startX: e.screenX,
    startY: e.screenY,
    moved: false,
  };

  // Prevent text selection during drag
  document.body.style.cursor = 'grabbing';
}

function onDragMove(e) {
  if (!dragState) return;

  const dx = e.screenX - dragState.startX;
  const dy = e.screenY - dragState.startY;

  if (!dragState.moved) {
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      dragState.moved = true;
    }
  }

  if (dragState.moved) {
    window.rikai.moveWindow(
      e.screenX - (e.clientX || 0),
      e.screenY - (e.clientY || 0)
    );
  }
}

function onDragEnd(e) {
  if (!dragState) return;
  document.body.style.cursor = '';
  dragState = null;
}

// Drag handle (top edge)
dragHandle.addEventListener('mousedown', (e) => {
  initDrag(e, dragHandle);
});

// Also allow drag from status bar (but NOT the toggle button)
document.getElementById('status-bar').addEventListener('mousedown', (e) => {
  if (e.target.closest('#mode-toggle')) return;
  initDrag(e, document.getElementById('status-bar'));
});

document.addEventListener('mousemove', onDragMove);
document.addEventListener('mouseup', onDragEnd);

// ── Window Resizing (bottom-right corner) ────────────────────────

let resizeState = null;

resizeHandle.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  resizeState = {
    startX: e.screenX,
    startY: e.screenY,
  };
  document.body.style.cursor = 'nwse-resize';
});

document.addEventListener('mousemove', async (e) => {
  if (!resizeState) return;

  const dx = e.screenX - resizeState.startX;
  const dy = e.screenY - resizeState.startY;

  const bounds = await window.rikai.getBounds();
  if (bounds) {
    const newWidth = Math.max(200, bounds.width + dx);
    const newHeight = Math.max(100, bounds.height + dy);
    await window.rikai.resizeWindow(newWidth, newHeight);
    resizeState.startX = e.screenX;
    resizeState.startY = e.screenY;
  }
});

document.addEventListener('mouseup', () => {
  if (resizeState) {
    resizeState = null;
    document.body.style.cursor = '';
  }
});

// ── Event Listeners ──────────────────────────────────────────────

// Click the scan frame to capture (in scanning mode)
// Only triggers if no drag happened
scanFrame.addEventListener('click', (e) => {
  // Don't capture if clicking the status bar or drag handle
  if (e.target.closest('#status-bar') || e.target.closest('#drag-handle')) return;

  // Don't capture if we just finished dragging
  if (dragState && dragState.moved) return;

  if (currentMode === 'scanning') {
    captureAndOcr();
  }
});

// Click reading overlay to go back to scanning
readingOverlay.addEventListener('click', () => {
  setMode('scanning');
  setStatus('Ready', 'dot-green');
});

// Mode toggle button
modeToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  if (currentMode === 'scanning' && lastOcrText) {
    setMode('reading');
  } else {
    setMode('scanning');
    setStatus('Ready', 'dot-green');
  }
});

// Global shortcut trigger from main process
window.rikai.onTriggerCapture(() => {
  if (currentMode === 'scanning') {
    captureAndOcr();
  } else {
    setMode('scanning');
    setStatus('Ready', 'dot-green');
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (currentMode === 'reading') {
      setMode('scanning');
      setStatus('Ready', 'dot-green');
    }
  }
});

// ── Init ─────────────────────────────────────────────────────────

async function init() {
  // Check if OCR server is running
  const serverStatus = await window.rikai.checkServer();
  if (serverStatus.running) {
    setStatus('Ready', 'dot-green');
  } else {
    setStatus('Waiting for server...', 'dot-yellow');
    // Retry check after a few seconds
    const retry = async () => {
      const check = await window.rikai.checkServer();
      if (check.running) {
        setStatus('Ready', 'dot-green');
      } else {
        setTimeout(retry, 2000);
      }
    };
    setTimeout(retry, 2000);
  }

  setMode('scanning');
}

init();
