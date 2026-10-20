const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sessionapi', {
  chooseFolder: () => ipcRenderer.invoke('session:chooseFolder'),
  chooseFile: () => ipcRenderer.invoke('session:chooseFile'),
  resolvePath: (p) => ipcRenderer.invoke('session:resolvePath', p),
  // Electron 32+ não expõe mais File.path no renderer
  pathForFile: (file) => webUtils.getPathForFile(file),
  load: (folderPath) => ipcRenderer.invoke('session:load', folderPath),
  decide: (payload) => ipcRenderer.invoke('session:decide', payload),
  settings: () => ipcRenderer.invoke('settings:get'),
  showItem: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
});

contextBridge.exposeInMainWorld('previewapi', {
  thumbnail: (item) => ipcRenderer.invoke('preview:thumbnail', item),
  full: (item) => ipcRenderer.invoke('preview:full', item),
  alternate: (item) => ipcRenderer.invoke('preview:alternate', item),
});

contextBridge.exposeInMainWorld('mediaapi', {
  probe: (filePath) => ipcRenderer.invoke('media:probe', filePath),
  proxy: (item, jobId) => ipcRenderer.invoke('media:proxy', { item, jobId }),
  saveFrame: (payload) => ipcRenderer.invoke('media:saveFrame', payload),
  saveClip: (payload) => ipcRenderer.invoke('media:saveClip', payload),
  cancel: (jobId) => ipcRenderer.invoke('media:cancel', jobId),
  onProgress: (fn) => ipcRenderer.on('job:progress', (_e, data) => fn(data)),
});

contextBridge.exposeInMainWorld('winapi', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onMaximized: (fn) => ipcRenderer.on('window:maximized', (_e, v) => fn(v)),
});
