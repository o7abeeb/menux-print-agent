const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuxAgent', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
});
