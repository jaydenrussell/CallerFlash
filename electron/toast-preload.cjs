const { contextBridge, ipcRenderer } = require('electron');

const log = (...args) => console.log('[toast-preload]', ...args);

contextBridge.exposeInMainWorld('callerflash', {
  toast: {
    getInitial: () => {
      log('getInitial called by toast.html');
      return ipcRenderer.invoke('toast:getInitial').then((data) => {
        log('getInitial resolved:', data ? Object.keys(data).join(',') : 'null');
        return data;
      });
    },
    onShow: (callback) => {
      log('onShow subscriber registered by toast.html');
      const handler = (_event, data) => {
        log('onShow received event with data:', data ? Object.keys(data).join(',') : 'null');
        callback(data);
      };
      ipcRenderer.on('toast:show:event', handler);
      return () => ipcRenderer.removeListener('toast:show:event', handler);
    },
    resizeContent: () => {
      try {
        const w = document.body.scrollWidth;
        const h = document.body.scrollHeight;
        log('resizeContent sending:', w + 'x' + h);
        ipcRenderer.send('toast:resize-content', w, h);
      } catch(e) {
        log('resizeContent error:', e);
      }
    },
  },
});
