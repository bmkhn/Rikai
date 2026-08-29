const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rikai', {
  // ── Scan Window Control ──────────────────────────────────────
  openScanWindow: () => ipcRenderer.invoke('open-scan-window'),
  closeScanWindow: () => ipcRenderer.invoke('close-scan-window'),

  // ── Scan Capture (used by scan window) ───────────────────────
  captureAndOcr: () => ipcRenderer.invoke('capture-and-ocr'),

  // ── Window Controls ──────────────────────────────────────────
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  moveWindow: (x, y) => ipcRenderer.invoke('move-window', x, y),

  // ── Server Status ────────────────────────────────────────────
  checkServer: () => ipcRenderer.invoke('check-server'),

  // ── Events ───────────────────────────────────────────────────
  // OCR result relayed from scan window to main window
  onOcrResult: (callback) => {
    ipcRenderer.on('ocr-result', (_event, result) => callback(result));
  },
  // Scan window was closed
  onScanWindowClosed: (callback) => {
    ipcRenderer.on('scan-window-closed', () => callback());
  },
  // Trigger capture (global shortcut)
  onTriggerCapture: (callback) => {
    ipcRenderer.on('trigger-capture', () => callback());
  },
});
