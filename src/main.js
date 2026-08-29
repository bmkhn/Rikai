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

/**
 * Resolve the Python interpreter path.
 * Dev: uses venv if available, falls back to system python
 * Prod: uses the PyInstaller-bundled exe from extraResources
 */
function getPythonServerCommand() {
  if (isDev) {
    const projectRoot = path.join(__dirname, '..');

    // Try venv first (Windows, then Unix)
    const venvWin = path.join(projectRoot, 'venv', 'Scripts', 'python.exe');
    const venvUnix = path.join(projectRoot, 'venv', 'bin', 'python');

    let pythonCmd = 'python';
    if (fs.existsSync(venvWin)) {
      pythonCmd = venvWin;
    } else if (fs.existsSync(venvUnix)) {
      pythonCmd = venvUnix;
    }

    const serverPath = path.join(projectRoot, 'server', 'ocr_server.py');
    console.log(`Dev mode: using ${pythonCmd === 'python' ? 'system' : 'venv'} Python`);
    return { cmd: pythonCmd, args: [serverPath] };
  }

  // Production: bundled PyInstaller exe
  const ocrExe = path.join(process.resourcesPath, 'ocr_server', 'ocr_server.exe');

  if (fs.existsSync(ocrExe)) {
    return { cmd: ocrExe, args: [] };
  }

  // Fallback
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

  pythonProcess.stdout.on('data', (data) => {
    console.log(`[Python] ${data.toString().trim()}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`[Python] ${data.toString().trim()}`);
  });

  pythonProcess.on('error', (err) => {
    console.error('Failed to start Python process:', err);
  });

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
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
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
            resolve(JSON.parse(data));
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

// ── Screen Capture ───────────────────────────────────────────────

async function captureScreenRegion(bounds) {
  const allDisplays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();

  let targetDisplay = primaryDisplay;
  let maxOverlap = 0;

  for (const display of allDisplays) {
    const { x, y, width, height } = display.bounds;
    const overlapX = Math.max(
      0,
      Math.min(bounds.x + bounds.width, x + width) - Math.max(bounds.x, x)
    );
    const overlapY = Math.max(
      0,
      Math.min(bounds.y + bounds.height, y + height) - Math.max(bounds.y, y)
    );
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

  // Calculate the ratio between thumbnail pixels and actual screen pixels
  // desktopCapturer scales the screen to fit thumbnailSize, so we need
  // the ratio of thumbnail dimensions to actual screen dimensions.
  const screenW = targetDisplay.bounds.width;
  const screenH = targetDisplay.bounds.height;
  const ratioX = thumbSize.width / screenW;
  const ratioY = thumbSize.height / screenH;

  // Window bounds relative to this display's origin
  const offsetX = bounds.x - targetDisplay.bounds.x;
  const offsetY = bounds.y - targetDisplay.bounds.y;

  const cropX = Math.max(0, Math.round(offsetX * ratioX));
  const cropY = Math.max(0, Math.round(offsetY * ratioY));
  const cropWidth = Math.round(bounds.width * ratioX);
  const cropHeight = Math.round(bounds.height * ratioY);

  const safeW = Math.min(cropWidth, thumbSize.width - cropX);
  const safeH = Math.min(cropHeight, thumbSize.height - cropY);

  const cropped = thumbnail.crop({
    x: cropX,
    y: cropY,
    width: safeW,
    height: safeH,
  });

  return cropped.toPNG().toString('base64');
}

// ── IPC Handlers ─────────────────────────────────────────────────

function setupIPC() {
  ipcMain.handle('capture-and-ocr', async () => {
    if (isCapturing) {
      return { text: '', error: 'Already capturing', time_ms: 0 };
    }

    isCapturing = true;
    const startTime = Date.now();

    try {
      const bounds = mainWindow.getBounds();
      const imageBase64 = await captureScreenRegion(bounds);
      const result = await sendOcrRequest(imageBase64);

      return {
        text: result.text || '',
        image: imageBase64,
        time_ms: Date.now() - startTime,
        ocr_time_ms: result.time_ms || 0,
      };
    } catch (err) {
      return {
        text: '',
        error: err.message,
        time_ms: Date.now() - startTime,
      };
    } finally {
      isCapturing = false;
    }
  });

  ipcMain.handle('get-bounds', () => {
    return mainWindow ? mainWindow.getBounds() : null;
  });

  ipcMain.handle('resize-window', (event, width, height) => {
    if (mainWindow) {
      mainWindow.setSize(width, height);
      return mainWindow.getBounds();
    }
    return null;
  });

  ipcMain.handle('move-window', (event, x, y) => {
    if (mainWindow) {
      mainWindow.setPosition(x, y);
      return mainWindow.getBounds();
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

  ipcMain.handle('save-config', (event, data) => {
    saveConfig(data);
    return { ok: true };
  });

  ipcMain.handle('load-config', () => {
    return loadConfig();
  });

  ipcMain.handle('get-displays', () => {
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      label: d.label,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === screen.getPrimaryDisplay().id,
    }));
  });
}

// ── System Tray ──────────────────────────────────────────────────

function createTray() {
  let iconPath;
  if (isDev) {
    iconPath = path.join(__dirname, '..', 'icons', 'icon16.png');
  } else {
    // In production, icon16.png is in extraResources
    iconPath = path.join(process.resourcesPath, 'icon16.png');
    if (!fs.existsSync(iconPath)) {
      // Fallback: check original dev path (works if running unpacked)
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
      label: 'Scan Now',
      accelerator: 'CommandOrControl+Shift+O',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('trigger-capture');
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

  tray.setToolTip('Rikai — Manga OCR');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Window Creation ──────────────────────────────────────────────

function createWindow() {
  const config = loadConfig();
  const bounds = config.windowBounds;

  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;
  const defaultX = Math.round((screenW - 260) / 2);
  const defaultY = Math.round((screenH - 160) / 2);

  mainWindow = new BrowserWindow({
    width: (bounds && bounds.width) || 260,
    height: (bounds && bounds.height) || 160,
    x: (bounds && bounds.x) || defaultX,
    y: (bounds && bounds.y) || defaultY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  let saveTimeout = null;
  const scheduleSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        saveConfig({ windowBounds: mainWindow.getBounds() });
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

// ── App Lifecycle ────────────────────────────────────────────────

app.whenReady().then(async () => {
  setupIPC();

  startPythonServer();
  createTray();

  try {
    await waitForServer();
    console.log('Python OCR server is ready');
  } catch (err) {
    console.error(err.message);
  }

  createWindow();

  globalShortcut.register('CommandOrControl+Shift+O', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.webContents.send('trigger-capture');
      } else {
        mainWindow.show();
        mainWindow.focus();
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
