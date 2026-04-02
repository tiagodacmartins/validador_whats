const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waApp', {
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pickOutputFolder: () => ipcRenderer.invoke('pick-output-folder'),
  connectWhatsApp: (id) => ipcRenderer.invoke('connect-whatsapp', id),
  disconnectWhatsApp: (id) => ipcRenderer.invoke('disconnect-whatsapp', id),
  openConnectWindow: () => ipcRenderer.invoke('open-connect-window'),
  getWaInfo: (id) => ipcRenderer.invoke('get-wa-info', id),
  getQr: () => ipcRenderer.invoke('get-qr'),
  openWhatsAppWeb: () => ipcRenderer.invoke('open-whatsapp-web'),
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  addAccount: () => ipcRenderer.invoke('add-account'),
  removeAccount: (id) => ipcRenderer.invoke('remove-account', id),
  startValidation: (payload) => ipcRenderer.invoke('start-validation', payload),
  cancelValidation: () => ipcRenderer.invoke('cancel-validation'),
  getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
  searchCache: (query, filter, offset = 0, pageSize = 500) => ipcRenderer.invoke('search-cache', query, filter, offset, pageSize),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openBancoWindow: () => ipcRenderer.invoke('open-banco-window'),
  getFileInfo: (fp) => ipcRenderer.invoke('get-file-info', fp),
  revalidatePhone: (phone) => ipcRenderer.invoke('revalidate-phone', phone),
  validatePhonesManual: (phones) => ipcRenderer.invoke('validate-phones-manual', phones),
  onStatus: (callback) => ipcRenderer.on('wa-status', (_e, data) => callback(data)),
  onAccounts: (callback) => ipcRenderer.on('wa-accounts', (_e, data) => callback(data)),
  onProgress: (callback) => ipcRenderer.on('validation-progress', (_e, data) => callback(data))
});