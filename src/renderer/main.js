/**
 * Rikai Main Window — displays OCR results, controls the scan window.
 */

// ── State ────────────────────────────────────────────────────────

let lastOcrText = '';
let history = [];
let scanWindowActive = false;

// ── DOM Elements ─────────────────────────────────────────────────

const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const resultPlaceholder = document.getElementById('result-placeholder');
const resultText = document.getElementById('result-text');
const resultTranslation = document.getElementById('result-translation');
const resultMeta = document.getElementById('result-meta');
const btnScan = document.getElementById('btn-scan');
const btnScanIcon = document.getElementById('btn-scan-icon');
const btnScanLabel = document.getElementById('btn-scan-label');
const btnCopy = document.getElementById('btn-copy');
const historySection = document.getElementById('history');
const historyList = document.getElementById('history-list');
const btnClearHistory = document.getElementById('btn-clear-history');

// ── Status ───────────────────────────────────────────────────────

function setStatus(text, dotClass) {
  statusLabel.textContent = text;
  statusDot.className = `dot ${dotClass}`;
}

// ── Result Display ───────────────────────────────────────────────

function showResult(text, translation, meta) {
  lastOcrText = text;
  resultPlaceholder.classList.add('hidden');
  resultText.classList.remove('hidden');
  resultMeta.classList.remove('hidden');
  resultText.textContent = text;
  resultMeta.textContent = meta;
  resultText.classList.add('fade-in');
  btnCopy.disabled = false;

  // Show translation if available
  if (translation && translation.trim()) {
    resultTranslation.textContent = translation;
    resultTranslation.classList.remove('hidden');
    resultTranslation.classList.add('fade-in');
  } else {
    resultTranslation.classList.add('hidden');
    resultTranslation.textContent = '';
  }

  // Add to history
  if (text && text.trim()) {
    addToHistory(text);
  }
}

function showPlaceholder() {
  resultPlaceholder.classList.remove('hidden');
  resultText.classList.add('hidden');
  resultTranslation.classList.add('hidden');
  resultMeta.classList.add('hidden');
  btnCopy.disabled = true;
}

// ── History ──────────────────────────────────────────────────────

function addToHistory(text) {
  // Avoid duplicates at the top
  if (history.length > 0 && history[0] === text) return;

  history.unshift(text);
  if (history.length > 20) history.pop();
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) {
    historySection.classList.add('hidden');
    return;
  }

  historySection.classList.remove('hidden');
  historyList.innerHTML = '';

  for (const item of history) {
    const el = document.createElement('div');
    el.className = 'history-item';
    el.textContent = item;
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(item);
      // Brief feedback
      el.style.color = '#34d399';
      setTimeout(() => { el.style.color = ''; }, 300);
    });
    historyList.appendChild(el);
  }
}

// ── SVG Icons ───────────────────────────────────────────────────

const ICON_SCAN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

// ── Scan Window Control ──────────────────────────────────────────

async function toggleScanWindow() {
  if (scanWindowActive) {
    await window.rikai.closeScanWindow();
    scanWindowActive = false;
    btnScanLabel.textContent = 'Scan';
    btnScanIcon.innerHTML = ICON_SCAN;
    btnScan.classList.remove('scanning');
  } else {
    await window.rikai.openScanWindow();
    scanWindowActive = true;
    btnScanLabel.textContent = 'Close Scanner';
    btnScanIcon.innerHTML = ICON_CLOSE;
    btnScan.classList.add('scanning');
  }
}

// ── Event Listeners ──────────────────────────────────────────────

btnScan.addEventListener('click', toggleScanWindow);

btnCopy.addEventListener('click', () => {
  if (lastOcrText) {
    navigator.clipboard.writeText(lastOcrText);
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1500);
  }
});

btnClearHistory.addEventListener('click', () => {
  history = [];
  renderHistory();
});

// Listen for OCR results from scan window (relayed via main process)
window.rikai.onOcrResult((result) => {
  if (result.error) {
    setStatus('Scan error', 'dot-red');
    showPlaceholder();
    resultText.textContent = result.error;
    resultText.classList.remove('hidden');
    resultPlaceholder.classList.add('hidden');
    setTimeout(() => {
      if (!scanWindowActive) setStatus('Ready', 'dot-green');
    }, 3000);
  } else if (result.text) {
    const meta = `${result.ocr_time_ms || '?'}ms OCR` + (result.translate_time_ms ? ` + ${result.translate_time_ms}ms translate` : '');
    showResult(result.text, result.translation || '', meta);
    setStatus('Text found', 'dot-green');
  } else {
    setStatus('No text detected', 'dot-red');
    setTimeout(() => setStatus('Ready', 'dot-green'), 2000);
  }
});

// Listen for scan window closed
window.rikai.onScanWindowClosed(() => {
  scanWindowActive = false;
  btnScanLabel.textContent = 'Scan';
  btnScanIcon.innerHTML = ICON_SCAN;
  btnScan.classList.remove('scanning');
});

// ── Init ─────────────────────────────────────────────────────────

async function init() {
  const serverStatus = await window.rikai.checkServer();
  if (serverStatus.running) {
    setStatus('Ready', 'dot-green');
    btnScan.disabled = false;
  } else {
    setStatus('Loading model...', 'dot-yellow');
    const retry = async () => {
      try {
        const check = await window.rikai.checkServer();
        if (check.running) {
          setStatus('Ready', 'dot-green');
          btnScan.disabled = false;
          return;
        }
      } catch {}
      setTimeout(retry, 3000);
    };
    setTimeout(retry, 3000);
  }
}

init();
