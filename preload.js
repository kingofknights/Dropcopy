'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    start: (exchange) => ipcRenderer.invoke('client:start', exchange),
    setExchange: (exchange) => ipcRenderer.invoke('client:setExchange', exchange),
    stop: (exchange) => ipcRenderer.invoke('client:stop', exchange),
    getStats: () => ipcRenderer.invoke('client:stats'),
    getPaths: () => ipcRenderer.invoke('app:getPaths'),
    getCompanyName: () => ipcRenderer.invoke('app:getCompanyName'),
    loadTrades: () => ipcRenderer.invoke('trades:load'),
    openCsv: () => ipcRenderer.invoke('trades:openCsv'),
    openFolder: () => ipcRenderer.invoke('trades:openFolder'),
    getExchangeConfig: (exchange) => ipcRenderer.invoke('config:getExchange', exchange),
    saveExchangeConfig: (exchange, config) => ipcRenderer.invoke('config:saveExchange', exchange, config),
    chooseConfigPath: (exchange, section, key, currentPath) => ipcRenderer.invoke('config:choosePath', exchange, section, key, currentPath),
    setLogsVisible: (visible) => ipcRenderer.invoke('view:setLogsVisible', visible),
    settingsAction: (action) => ipcRenderer.invoke('settings:action', action),

    onStatus:    (cb) => ipcRenderer.on('client:status',    (_, d) => cb(d)),
    onLogin:     (cb) => ipcRenderer.on('client:login',     (_, d) => cb(d)),
    onTrade:     (cb) => ipcRenderer.on('client:trade',     (_, d) => cb(d)),
    onHeartbeat: (cb) => ipcRenderer.on('client:heartbeat', (_, d) => cb(d)),
    onStats:     (cb) => ipcRenderer.on('client:stats',     (_, d) => cb(d)),
    onLog:       (cb) => ipcRenderer.on('client:log',       (_, d) => cb(d)),
    onMenuAction: (cb) => ipcRenderer.on('menu:action', (_, action) => cb(action)),
    onReset:     (cb) => ipcRenderer.on('client:reset',     (_, d) => cb(d))
});
