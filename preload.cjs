/**
 * preload 边界（CommonJS，contextIsolation 开启）—— 渲染层唯一可见的受限接口。
 *
 * 渲染层拿不到 ipcRenderer 本体、拿不到 SQLite 驱动、拿不到任何凭据；
 * 每个方法只映射到主进程已注册的 desktop:* 句柄，参数逐个显式转发，
 * 不暴露通用 invoke（避免渲染层越权调用任意通道）。
 */

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getSummary: () => ipcRenderer.invoke('desktop:getSummary'),
  listConsultations: (filter) => ipcRenderer.invoke('desktop:listConsultations', filter ?? {}),
  getExplanation: (consultationNo) => ipcRenderer.invoke('desktop:getExplanation', String(consultationNo)),
  confirm: (consultationNo) => ipcRenderer.invoke('desktop:confirm', String(consultationNo)),
  handoff: (consultationNo) => ipcRenderer.invoke('desktop:handoff', String(consultationNo)),
  print: (consultationNo) => ipcRenderer.invoke('desktop:print', String(consultationNo)),
  replay: (consultationNo) => ipcRenderer.invoke('desktop:replay', String(consultationNo)),
  checkConnectivity: () => ipcRenderer.invoke('desktop:checkConnectivity'),
  reportReady: () => { void ipcRenderer.invoke('desktop:reportReady'); },
};

contextBridge.exposeInMainWorld('desktopAPI', api);
