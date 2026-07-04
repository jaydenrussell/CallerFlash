const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helper', {
  onProgress: (cb) => {
    ipcRenderer.on('helper:progress', (_e, data) => cb(data));
  },
});
