const { app, BrowserWindow, screen, ipcMain, shell } = require('electron');
const path = require('path');

let mainWindow;

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
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    title: 'GR Active Warnings',
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Keep always-on-top even when other windows are focused
  mainWindow.setAlwaysOnTop(true, 'floating');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC: window controls from renderer
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win-close', () => mainWindow && mainWindow.close());
ipcMain.on('win-toggle-ontop', (event, val) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(val, 'floating');
});
