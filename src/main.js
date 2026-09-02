const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  screen,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
} = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

// ── State ────────────────────────────────────────────────────────

let mainWindow = null;
let scanWindow = null;
let pythonProcess = null;
let tray = null;
let isCapturing = false;
const OCR_SERVER_URL = 'http://127.0.0.1:54321';

const isDev = !app.isPackaged;

// Config path for persisting settings
const configDir = path.join(app.getPath('userData'), 'config');
const configPath = path.join(configDir, 'settings.json');

function loadConfig() {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const existing = loadConfig();
    fs.writeFileSync(configPath, JSON.stringify({ ...existing, ...data }, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}

// ── Python Subprocess Management ─────────────────────────────────

function getPythonServerCommand() {
  if (isDev) {
    const projectRoot = path.join(__dirname, '..');
    const venvWin = path.join(projectRoot, 'venv', 'Scripts', 'python.exe');
    const venvUnix = path.join(projectRoot, 'venv', 'bin', 'python');

    let pythonCmd = 'python';
    if (fs.existsSync(venvWin)) pythonCmd = venvWin;
    else if (fs.existsSync(venvUnix)) pythonCmd = venvUnix;

    const serverPath = path.join(projectRoot, 'server', 'ocr_server.py');
    console.log(`Dev mode: using ${pythonCmd === 'python' ? 'system' : 'venv'} Python`);
    return { cmd: pythonCmd, args: [serverPath] };
  }

  const ocrExe = path.join(process.resourcesPath, 'ocr_server', 'ocr_server.exe');
  if (fs.existsSync(ocrExe)) {
    return { cmd: ocrExe, args: [] };
  }

  console.warn('Bundled OCR server not found, falling back to system Python');
  const serverPath = path.join(__dirname, '..', 'server', 'ocr_server.py');
  return { cmd: 'python', args: [serverPath] };
}

function startPythonServer() {
  const { cmd, args } = getPythonServerCommand();
  console.log(`Starting Python OCR server: ${cmd} ${args.join(' ')}`);

  pythonProcess = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    cwd: isDev ? path.join(__dirname, '..') : process.resourcesPath,
  });

  pythonProcess.stdout.on('data', (data) => console.log(`[Python] ${data.toString().trim()}`));
  pythonProcess.stderr.on('data', (data) => console.error(`[Python] ${data.toString().trim()}`));
  pythonProcess.on('error', (err) => console.error('Failed to start Python process:', err));
  pythonProcess.on('exit', (code) => {
    console.log(`Python process exited with code ${code}`);
    pythonProcess = null;
  });
}

function waitForServer(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http
        .get(`${OCR_SERVER_URL}/health`, (res) => {
          if (res.statusCode === 200) resolve();
          else retry();
        })
        .on('error', () => retry());
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Python server did not start in time'));
        return;
      }
      setTimeout(check, 1000);
    };
    check();
  });
}

function stopPythonServer() {
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
  }
}

// ── OCR via HTTP ─────────────────────────────────────────────────

function sendOcrRequest(imageBase64) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(imageBase64, 'base64');
    const url = new URL('/ocr', OCR_SERVER_URL);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // Reject on HTTP errors so the caller sees the error message
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || `OCR server error (${res.statusCode})`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Invalid JSON from OCR server: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendTranslateRequest(text, target = 'en') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, target });
    const url = new URL('/translate', OCR_SERVER_URL);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || `Translate server error (${res.statusCode})`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Invalid JSON from translate server: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Screen Capture ───────────────────────────────────────────────

async function captureScreenRegion(bounds) {
  const allDisplays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();

  let targetDisplay = primaryDisplay;
  let maxOverlap = 0;

  for (const display of allDisplays) {
    const { x, y, width, height } = display.bounds;
    const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, x + width) - Math.max(bounds.x, x));
    const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, y + height) - Math.max(bounds.y, y));
    const overlap = overlapX * overlapY;
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      targetDisplay = display;
    }
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 3840, height: 2160 },
  });

  let source = sources[0];
  for (const s of sources) {
    if (
      s.display_id === String(targetDisplay.id) ||
      s.name.includes(targetDisplay.label) ||
      s.name === `Screen ${targetDisplay.id}`
    ) {
      source = s;
      break;
    }
  }

  const thumbnail = source.thumbnail;
  const thumbSize = thumbnail.getSize();
  const screenW = targetDisplay.bounds.width;
  const screenH = targetDisplay.bounds.height;
  const ratioX = thumbSize.width / screenW;
  const ratioY = thumbSize.height / screenH;

  const offsetX = bounds.x - targetDisplay.bounds.x;
  const offsetY = bounds.y - targetDisplay.bounds.y;

  const cropX = Math.max(0, Math.round(offsetX * ratioX));
  const cropY = Math.max(0, Math.round(offsetY * ratioY));
  const cropWidth = Math.round(bounds.width * ratioX);
  const cropHeight = Math.round(bounds.height * ratioY);

  const safeW = Math.min(cropWidth, thumbSize.width - cropX);
  const safeH = Math.min(cropHeight, thumbSize.height - cropY);

  const cropped = thumbnail.crop({ x: cropX, y: cropY, width: safeW, height: safeH });

  return cropped.toPNG().toString('base64');
}

// ── Scan Window Management ───────────────────────────────────────

function createScanWindow() {
  if (scanWindow && !scanWindow.isDestroyed()) {
    scanWindow.focus();
    return;
  }

  const config = loadConfig();
  const scanBounds = config.scanWindowBounds;

  // Default: center of primary display
  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;
  const scanW = 260;
  const scanH = 160;
  const defaultX = Math.round((screenW - scanW) / 2);
  const defaultY = Math.round((screenH - scanH) / 2);

  scanWindow = new BrowserWindow({
    width: (scanBounds && scanBounds.width) || scanW,
    height: (scanBounds && scanBounds.height) || scanH,
    x: (scanBounds && scanBounds.x) || defaultX,
    y: (scanBounds && scanBounds.y) || defaultY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    title: '',
    type: 'toolbar',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  scanWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Save scan window position on move/resize
  let saveTimeout = null;
  const scheduleSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (scanWindow && !scanWindow.isDestroyed()) {
        saveConfig({ scanWindowBounds: scanWindow.getBounds() });
      }
    }, 500);
  };

  scanWindow.on('move', scheduleSave);
  scanWindow.on('resize', scheduleSave);

  scanWindow.on('closed', () => {
    scanWindow = null;
    // Notify main window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan-window-closed');
    }
  });
}

function closeScanWindow() {
  if (scanWindow && !scanWindow.isDestroyed()) {
    scanWindow.close();
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────

function setupIPC() {
  // ── Scan Window Control ────────────────────────────────────
  ipcMain.handle('open-scan-window', () => {
    createScanWindow();
    return { ok: true };
  });

  ipcMain.handle('close-scan-window', () => {
    closeScanWindow();
    return { ok: true };
  });

  // ── Capture + OCR + Translate (single-stage) ─────────────────
  ipcMain.handle('capture-and-ocr', async () => {
    if (isCapturing) {
      return { text: '', error: 'Already capturing', time_ms: 0 };
    }

    isCapturing = true;
    const startTime = Date.now();

    try {
      if (!scanWindow || scanWindow.isDestroyed()) {
        throw new Error('Scan window not open');
      }

      const bounds = scanWindow.getBounds();
      let imageBase64 = await captureScreenRegion(bounds);
      const ocrResult = await sendOcrRequest(imageBase64);

      const ocrText = ocrResult.text || '';
      const ocrTimeMs = ocrResult.time_ms || 0;

      // Auto-translate the recognized text
      let translation = '';
      let translateTimeMs = 0;
      let translateError = '';
      if (ocrText.trim()) {
        try {
          const translateResult = await sendTranslateRequest(ocrText);
          if (translateResult.error) {
            translateError = translateResult.error;
          } else {
            translation = translateResult.translation || '';
            translateTimeMs = translateResult.time_ms || 0;
          }
        } catch (err) {
          translateError = err.message;
        }
      }

      const result = {
        text: ocrText,
        translation: translation,
        time_ms: Date.now() - startTime,
        ocr_time_ms: ocrTimeMs,
        translate_time_ms: translateTimeMs,
        translate_error: translateError,
      };

      // Relay result to main window
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ocr-result', result);
      }

      return result;
    } catch (err) {
      const errorResult = {
        text: '',
        error: err.message,
        time_ms: Date.now() - startTime,
      };

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ocr-result', errorResult);
      }

      return errorResult;
    } finally {
      isCapturing = false;
    }
  });

  // ── Window Controls ────────────────────────────────────────
  ipcMain.handle('get-bounds', (event) => {
    // Return bounds of whichever window sent this
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.getBounds() : null;
  });

  ipcMain.handle('move-window', (event, x, y) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.setPosition(x, y);
      return win.getBounds();
    }
    return null;
  });

  ipcMain.handle('check-server', async () => {
    try {
      await new Promise((resolve, reject) => {
        http
          .get(`${OCR_SERVER_URL}/health`, (res) => {
            if (res.statusCode === 200) resolve();
            else reject(new Error('Server unhealthy'));
          })
          .on('error', reject);
      });
      return { running: true };
    } catch {
      return { running: false };
    }
  });
}

// ── Main Window ──────────────────────────────────────────────────

function getIconPath() {
  if (isDev) {
    return path.join(__dirname, '..', 'icons', 'icon256.png');
  }
  return path.join(process.resourcesPath, 'icon256.png');
}

function createMainWindow() {
  const config = loadConfig();
  const bounds = config.mainWindowBounds;

  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;
  const defaultW = 380;
  const defaultH = 420;
  const defaultX = Math.round((screenW - defaultW) / 2);
  const defaultY = Math.round((screenH - defaultH) / 2);

  mainWindow = new BrowserWindow({
    width: (bounds && bounds.width) || defaultW,
    height: (bounds && bounds.height) || defaultH,
    x: (bounds && bounds.x) || defaultX,
    y: (bounds && bounds.y) || defaultY,
    frame: false,
    show: false,
    transparent: false,
    backgroundColor: '#f0f4f8',
    alwaysOnTop: false,
    resizable: true,
    hasShadow: true,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'main.html'));

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  // Save window position on move/resize
  let saveTimeout = null;
  const scheduleSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        saveConfig({ mainWindowBounds: mainWindow.getBounds() });
      }
    }, 500);
  };

  mainWindow.on('move', scheduleSave);
  mainWindow.on('resize', scheduleSave);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

// ── System Tray ──────────────────────────────────────────────────

function createTray() {
  let iconPath;
  if (isDev) {
    iconPath = path.join(__dirname, '..', 'icons', 'icon16.png');
  } else {
    iconPath = path.join(process.resourcesPath, 'icon16.png');
    if (!fs.existsSync(iconPath)) {
      iconPath = path.join(__dirname, '..', 'icons', 'icon16.png');
    }
  }

  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Open Scanner',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('open-scan-trigger');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Rikai',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Rikai — Manga OCR + Translation');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── App Lifecycle ────────────────────────────────────────────────

app.whenReady().then(async () => {
  setupIPC();
  startPythonServer();
  createTray();

  createMainWindow();

  try {
    await waitForServer();
    console.log('Python OCR server is ready');
  } catch (err) {
    console.error(err.message);
  }

  globalShortcut.register('CommandOrControl+Shift+O', () => {
    // Toggle scan window
    if (scanWindow && !scanWindow.isDestroyed()) {
      closeScanWindow();
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('open-scan-trigger');
      }
    }
  });
});

app.on('window-all-closed', () => {
  // Don't quit — tray keeps the app alive
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopPythonServer();
});
