/**
 * Rikai Scan Window — clean capture frame.
 * Hold anywhere to drag, click to scan.
 */

const scanFrame = document.getElementById('scan-frame');

// ── Drag State ───────────────────────────────────────────────────

let dragState = null;
const DRAG_THRESHOLD = 5; // px before we commit to a drag

// ── Window Dragging ──────────────────────────────────────────────
// Hold anywhere on the frame to drag. Quick click = scan.

scanFrame.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // left click only
  e.preventDefault();

  dragState = {
    startX: e.screenX,
    startY: e.screenY,
    moved: false,
  };
});

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;

  const dx = e.screenX - dragState.startX;
  const dy = e.screenY - dragState.startY;

  if (!dragState.moved) {
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      dragState.moved = true;
      document.body.style.cursor = 'grabbing';
    }
  }

  if (dragState.moved) {
    window.rikai.moveWindow(e.screenX - e.clientX, e.screenY - e.clientY);
  }
});

document.addEventListener('mouseup', (e) => {
  if (!dragState) return;

  const wasDragging = dragState.moved;
  dragState = null;
  document.body.style.cursor = '';

  // If we didn't drag, it was a click → scan
  if (!wasDragging) {
    capture();
  }
});

// ── Capture ──────────────────────────────────────────────────────

let isCapturing = false;

async function capture() {
  if (isCapturing) return;
  isCapturing = true;

  scanFrame.classList.add('capturing');

  try {
    await window.rikai.captureAndOcr();
    // Result is relayed to main window via main process IPC
  } catch (err) {
    console.error('Capture error:', err);
  } finally {
    isCapturing = false;
    scanFrame.classList.remove('capturing');
  }
}

// Global shortcut trigger from main process
window.rikai.onTriggerCapture(() => {
  capture();
});
