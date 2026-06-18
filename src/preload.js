const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize:        () => ipcRenderer.send('win-minimize'),
  close:           () => ipcRenderer.send('win-close'),
  setAlwaysOnTop:  (val) => ipcRenderer.send('win-toggle-ontop', val),
  installUpdate:   () => ipcRenderer.send('update-install-now'),
  openExternal:    (url) => ipcRenderer.send('open-external-url', url),
  fetchAllowedUrl:     (url) => ipcRenderer.invoke('fetch-allowed-url', url),
  fetchAllowedDataUrl: (url) => ipcRenderer.invoke('fetch-allowed-data-url', url),
  fetchAllowedBuffer:  (url) => ipcRenderer.invoke('fetch-allowed-buffer', url),
  onUpdateStatus:  (cb) => ipcRenderer.on('update-status', (_, data) => cb(data)),
});