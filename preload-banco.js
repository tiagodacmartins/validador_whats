const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('banco', {
  getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
  searchCache: (query, filter, offset, pageSize) => ipcRenderer.invoke('search-cache', query, filter, offset, pageSize),
  revalidatePhone: (phone) => ipcRenderer.invoke('revalidate-phone', phone)
});
