// 渲染进程只能看到状态和一组固定动作，本机口令不下发到页面里。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ferry', {
  action: (name, value) => ipcRenderer.invoke('action', name, value),
  onState: callback => ipcRenderer.on('state', (_event, state) => callback(state)),
  onDismiss: callback => ipcRenderer.on('dismiss-details', () => callback()),
});
