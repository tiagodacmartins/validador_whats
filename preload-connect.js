const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waConnect', {
  connectWhatsApp:    () => ipcRenderer.invoke('connect-whatsapp'),
  disconnectWhatsApp: () => ipcRenderer.invoke('disconnect-whatsapp'),
  getWaInfo:          () => ipcRenderer.invoke('get-wa-info'),
  onStatus: (callback) => ipcRenderer.on('wa-status', (_e, data) => callback(data))
});
