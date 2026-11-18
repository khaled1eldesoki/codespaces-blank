'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serverDashboard', {
  health: () => ipcRenderer.invoke('dashboard:health'),
  login: credentials => ipcRenderer.invoke('dashboard:login', credentials),
  changePassword: credentials => ipcRenderer.invoke('dashboard:change-password', credentials),
  logout: () => ipcRenderer.invoke('dashboard:logout'),
  request: request => ipcRenderer.invoke('dashboard:request', request),
  service: action => ipcRenderer.invoke('dashboard:service', action),
  config: {
    get: () => ipcRenderer.invoke('dashboard:config:get'),
    save: changes => ipcRenderer.invoke('dashboard:config:save', changes)
  },
  certificates: {
    get: () => ipcRenderer.invoke('dashboard:certificates'),
    renew: () => ipcRenderer.invoke('dashboard:certificates:renew')
  },
  logs: () => ipcRenderer.invoke('dashboard:logs'),
  backups: {
    list: () => ipcRenderer.invoke('dashboard:backups'),
    verify: file => ipcRenderer.invoke('dashboard:backup:verify', file),
    restore: file => ipcRenderer.invoke('dashboard:backup:restore', file),
    import: () => ipcRenderer.invoke('dashboard:backup:import')
  },
  openClientConfig: () => ipcRenderer.invoke('dashboard:open-client-config')
});
