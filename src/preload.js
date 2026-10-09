const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuxAgent', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  testPrint: (printerName) => ipcRenderer.invoke('test-print', printerName),
  connectionStatus: () => ipcRenderer.invoke('connection-status'),
});
