const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sessionapi', {
  chooseFolder: () => ipcRenderer.invoke('session:chooseFolder'),
  load: (folderPath) => ipcRenderer.invoke('session:load', folderPath),
  decide: (payload) => ipcRenderer.invoke('session:decide', payload),
});

contextBridge.exposeInMainWorld('previewapi', {
  thumbnail: (item) => ipcRenderer.invoke('preview:thumbnail', item),
  full: (item) => ipcRenderer.invoke('preview:full', item),
});

contextBridge.exposeInMainWorld('winapi', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
});
