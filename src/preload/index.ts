import { contextBridge, ipcRenderer } from 'electron';

/**
 * Único puente entre la interfaz y el proceso principal. La interfaz no ve
 * Node ni el sistema de archivos: solo estas funciones.
 */
const api = {
  info: () => ipcRenderer.invoke('app:info'),

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch: unknown) => ipcRenderer.invoke('config:set', patch),
  },

  install: {
    select: () => ipcRenderer.invoke('install:select'),
    inspect: (dir: string) => ipcRenderer.invoke('install:inspect', dir),
    diskSpace: (dir: string) => ipcRenderer.invoke('install:diskSpace', dir),
    applyRealmlist: (dir: string) => ipcRenderer.invoke('install:applyRealmlist', dir),
    readRealmlist: (dir: string) => ipcRenderer.invoke('install:readRealmlist', dir),
    openDir: (dir: string) => ipcRenderer.invoke('install:openDir', dir),
    resetGraphics: (dir: string) => ipcRenderer.invoke('install:resetGraphics', dir),
  },

  download: {
    manifest: () => ipcRenderer.invoke('download:manifest'),
    plan: (deep = false) => ipcRenderer.invoke('download:plan', deep),
    start: () => ipcRenderer.invoke('download:start'),
    stop: () => ipcRenderer.invoke('download:stop'),
  },

  game: {
    launch: () => ipcRenderer.invoke('game:launch'),
    stop: () => ipcRenderer.invoke('game:stop'),
    state: () => ipcRenderer.invoke('game:state'),
  },

  realm: {
    status: () => ipcRenderer.invoke('realm:status'),
  },

  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
  },

  on: (channel: string, cb: (payload: unknown) => void) => {
    const allowed = [
      'download:progress',
      'download:phase',
      'download:retry',
      'download:check-progress',
      'download:error',
      'game:state',
      'realm:status',
      'updater:available',
      'updater:progress',
      'updater:ready',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('frosthold', api);

export type FrostholdApi = typeof api;
