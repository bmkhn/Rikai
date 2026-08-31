/**
 * Rikai Scan Window — clean capture frame.
 * Drag the frame to reposition, click the button to scan.
 */

const scanFrame = document.getElementById('scan-frame');
const captureBtn = document.getElementById('capture-btn');
const captureBtnIcon = document.getElementById('capture-btn-icon');

const ICON_SCAN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_LOADER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';

// ── Capture ──────────────────────────────────────────────────────

let isCapturing = false;

async function capture() {
  if (isCapturing) return;
  isCapturing = true;

  captureBtn.classList.add('capturing');
  captureBtnIcon.innerHTML = ICON_LOADER;

  try {
    await window.rikai.captureAndOcr();
  } catch (err) {
    console.error('Capture error:', err);
  } finally {
    isCapturing = false;
    captureBtn.classList.remove('capturing');
    captureBtnIcon.innerHTML = ICON_SCAN;
  }
}

captureBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  capture();
});

// Global shortcut trigger from main process
window.rikai.onTriggerCapture(() => {
  capture();
});
