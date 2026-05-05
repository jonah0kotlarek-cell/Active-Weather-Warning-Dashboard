const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize:       () => ipcRenderer.send('win-minimize'),
  close:          () => ipcRenderer.send('win-close'),
  setAlwaysOnTop: (val) => ipcRenderer.send('win-toggle-ontop', val),
  installUpdate:  () => ipcRenderer.send('update-install-now'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, data) => cb(data)),
});
