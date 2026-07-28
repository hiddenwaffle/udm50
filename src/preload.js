'use strict';
// Preload for the launcher bar. Minimal, safe bridge to the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  submit: (q, isPrivate) => ipcRenderer.send('submit-query', { query: q, private: !!isPrivate }),
  hide: () => ipcRenderer.send('hide-launcher'),
  onShown: (cb) => ipcRenderer.on('launcher-shown', (_e, state) => cb(state || {})),
  setMode: (isPrivate) => ipcRenderer.send('mode:set', isPrivate),
  onReset: (cb) => ipcRenderer.on('launcher-reset', () => cb()),
  saveDraft: (text) => ipcRenderer.send('draft:save', text),
  getCleared: () => ipcRenderer.invoke('draft:cleared'),
  getHistory: (query) => ipcRenderer.invoke('history:get', query),
  deleteHistory: (text, query) => ipcRenderer.invoke('history:delete', { text, query }),
  resize: (height) => ipcRenderer.send('launcher:resize', height)
});
