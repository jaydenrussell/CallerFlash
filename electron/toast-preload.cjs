const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callerflash', {
  toast: {
    getInitial: () => ipcRenderer.invoke('toast:getInitial'),
    onShow: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('toast:show:event', handler);
      return () => ipcRenderer.removeListener('toast:show:event', handler);
    },
  },
});
