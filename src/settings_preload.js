'use strict';
// Preload for the settings window. Minimal bridge to the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (s) => ipcRenderer.invoke('settings:save', s),
  resetAiBounds: () => ipcRenderer.invoke('settings:resetAiBounds'),
  getCacheSize: () => ipcRenderer.invoke('cache:size'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  getCookieSize: () => ipcRenderer.invoke('cookies:size'),
  clearCookies: () => ipcRenderer.invoke('cookies:clear'),
  close: () => ipcRenderer.send('settings:close')
});
