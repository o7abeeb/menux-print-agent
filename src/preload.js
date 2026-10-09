const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuxAgent', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  testPrint: (printerName, printMode) => ipcRenderer.invoke('test-print', printerName, printMode),
  connectionStatus: () => ipcRenderer.invoke('connection-status'),
});
