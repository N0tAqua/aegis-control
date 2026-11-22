const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aegis', {
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    register: (payload) => ipcRenderer.invoke('auth:register', payload),
    login: (payload) => ipcRenderer.invoke('auth:login', payload),
    autoLogin: () => ipcRenderer.invoke('auth:auto-login'),
    lock: () => ipcRenderer.invoke('auth:lock'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    createDashboardToken: (label) => ipcRenderer.invoke('auth:dashboard-token', label),
    startDiscordLogin: () => ipcRenderer.invoke('auth:discord-start'),
    unlinkDiscord: () => ipcRenderer.invoke('auth:discord-unlink'),
    keys: {
      list: () => ipcRenderer.invoke('auth:keys:list'),
      create: (payload) => ipcRenderer.invoke('auth:keys:create', payload),
      update: (payload) => ipcRenderer.invoke('auth:keys:update', payload),
      remove: (id) => ipcRenderer.invoke('auth:keys:delete', id),
    },
  },

  getInfo: () => ipcRenderer.invoke('app:info'),
  copyText: (text) => ipcRenderer.invoke('app:copy', text),
  showAppFile: () => ipcRenderer.invoke('app:showAppFile'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  startBot: () => ipcRenderer.invoke('bot:start'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),

  setGuildSetting: (guildId, key, value) =>
    ipcRenderer.invoke('settings:set', { guildId, key, value }),
  setMemberSetting: (guildId, userId, key, value) =>
    ipcRenderer.invoke('settings:member', { guildId, userId, key, value }),
  addMember: (guildId, userId) => ipcRenderer.invoke('members:add', { guildId, userId }),
  addAllMembers: (guildId) => ipcRenderer.invoke('members:addAll', { guildId }),
  removeMember: (guildId, userId) => ipcRenderer.invoke('members:remove', { guildId, userId }),
  getMessages: () => ipcRenderer.invoke('messages:get'),
  onMessage: (handler) => {
    const listener = (_event, entry) => handler(entry);
    ipcRenderer.on('message', listener);
    return () => ipcRenderer.removeListener('message', listener);
  },

  social: {
    get: () => ipcRenderer.invoke('social:get'),
    addFriend: (publicId) => ipcRenderer.invoke('friends:request', publicId),
    respondFriend: (id, accept) => ipcRenderer.invoke('friends:respond', { id, accept }),
    removeFriend: (accountId) => ipcRenderer.invoke('friends:remove', accountId),
    invite: (roomId, publicId) => ipcRenderer.invoke('rooms:invite', { roomId, publicId }),
    respondInvite: (id, accept) => ipcRenderer.invoke('invites:respond', { id, accept }),
    requestRoom: (roomId) => ipcRenderer.invoke('rooms:request', roomId),
    respondRoomRequest: (id, accept) => ipcRenderer.invoke('requests:respond', { id, accept }),
    removeRoomMember: (roomId, accountId) =>
      ipcRenderer.invoke('rooms:removeMember', { roomId, accountId }),
  },

  addAllowedUser: (userId) => ipcRenderer.invoke('allowlist:add', userId),
  removeAllowedUser: (userId) => ipcRenderer.invoke('allowlist:remove', userId),

  deployCommands: (guildId) => ipcRenderer.invoke('commands:deploy', guildId),
  runCommand: (line) => ipcRenderer.invoke('console:run', line),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  getConsoleHistory: () => ipcRenderer.invoke('console:history'),
  getLinkedConsole: () => ipcRenderer.invoke('console:linked'),

  rooms: {
    list: () => ipcRenderer.invoke('rooms:list'),
    current: () => ipcRenderer.invoke('rooms:current'),
    create: (name) => ipcRenderer.invoke('rooms:create', name),
    joinCode: (code) => ipcRenderer.invoke('rooms:join-code', code),
    join: (id) => ipcRenderer.invoke('rooms:join', id),
    select: (id) => ipcRenderer.invoke('rooms:select', id),
    leave: (id) => ipcRenderer.invoke('rooms:leave', id),
    remove: (id) => ipcRenderer.invoke('rooms:delete', id),
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: (release) => ipcRenderer.invoke('update:download', release),
  installUpdate: (release) => ipcRenderer.invoke('update:install', release),
  onUpdateProgress: (callback) => {
    ipcRenderer.on('update:progress', (_event, payload) => callback(payload));
  },

  onLog: (callback) => {
    ipcRenderer.on('log', (_event, entry) => callback(entry));
  },
  onStatus: (callback) => {
    ipcRenderer.on('status', (_event, status) => callback(status));
  },
});
