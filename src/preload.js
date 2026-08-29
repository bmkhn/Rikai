const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rikai', {
  // Capture screen behind window and OCR it
  captureAndOcr: () => ipcRenderer.invoke('capture-and-ocr'),

  // Window controls
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', width, height),
  moveWindow: (x, y) => ipcRenderer.invoke('move-window', x, y),

  // Check if Python OCR server is running
  checkServer: () => ipcRenderer.invoke('check-server'),

  // Config persistence
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  loadConfig: () => ipcRenderer.invoke('load-config'),

  // Multi-monitor info
  getDisplays: () => ipcRenderer.invoke('get-displays'),

  // Listen for capture trigger from main process (global shortcut)
  onTriggerCapture: (callback) => {
    ipcRenderer.on('trigger-capture', () => callback());
  },
});
