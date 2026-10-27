/* Seal IPTV — preload.js: the only bridge between the window and the main process. */
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'app:init', 'settings:set',
  'profiles:test', 'profiles:save', 'profiles:delete', 'profiles:use', 'profiles:fromLink', 'dialog:m3uFile', 'dialog:exe',
  'catalog:refresh', 'catalog:summary', 'catalog:cats', 'catalog:list', 'catalog:item', 'catalog:search', 'catalog:recent',
  'details:movie', 'details:series', 'epg:short',
  'lib:favorite', 'lib:watched', 'lib:watchedMany', 'lib:progress', 'lib:clearProgress', 'lib:continue', 'lib:favorites', 'lib:arrangeFavorites', 'lib:clearHistory',
  'vpn:check', 'vpn:adapters', 'vpn:publicIp', 'vpn:openProton',
  'parental:status', 'parental:unlock', 'parental:lock', 'parental:setPin', 'parental:removePin', 'parental:options', 'parental:searchHidden', 'cats:flag',
  'sync:status', 'sync:probe', 'sync:connect', 'sync:now', 'sync:disconnect', 'sync:devices', 'sync:revoke', 'sync:destroy',
  'play:prepare', 'play:stopped', 'play:external', 'play:findVlc', 'play:netlog',
  'art:find', 'art:testKey', 'art:clear',
  'update:check', 'update:install', 'update:restart', 'update:openPage'
]);
const EVENTS = new Set(['vpn:status', 'catalog:step', 'sync:applied', 'sync:status', 'update:progress']);

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => {
    if (!CHANNELS.has(channel)) return Promise.resolve({ ok: false, error: 'Unknown command: ' + channel });
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) return;
    ipcRenderer.on(channel, (_e, data) => fn(data));
  }
});
