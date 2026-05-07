const { app, BrowserWindow, screen, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

let mainWindow;

// ── Auto-updater ─────────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function initAutoUpdater() {
  autoUpdater.checkForUpdates();
  // Re-check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-status', {
      type: 'downloading',
      version: info.version,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update-status', {
      type: 'ready',
      version: info.version,
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err?.message || err);
  });
}

// ── Window ───────────────────────────────────────────────────────
function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 400,
    height: 560,
    x: sw - 420,
    y: 40,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    minWidth: 320,
    minHeight: 300,
    backgroundColor: '#050505',
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, '..', 'assets', 'Icon.ico'),
    title: 'GR Active Warnings',
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (!app.isPackaged) {
    mainWindow.webContents.executeJavaScript('window.__DEV__ = true;');
  }

  mainWindow.setAlwaysOnTop(true, 'floating');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Only run updater in production builds
  if (app.isPackaged) initAutoUpdater();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC: window controls ─────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win-close',    () => mainWindow && mainWindow.close());
ipcMain.on('win-toggle-ontop', (event, val) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(val, 'floating');
});

// ── IPC: updater ─────────────────────────────────────────────────
ipcMain.on('update-install-now', () => {
  autoUpdater.quitAndInstall();
});
