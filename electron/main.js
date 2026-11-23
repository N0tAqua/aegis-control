import { app, BrowserWindow, clipboard, ipcMain, safeStorage, shell } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthStore, machineId } from './auth.js';
import { SERVER_FILE } from './config.js';
import { BotManager } from '../src/bot.js';
import { checkForUpdate, downloadUpdate, installUpdate, isNewer } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName('Aegis Control');
app.setAppUserModelId('com.aegis.control');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let bot = null;
let auth = null;

// A crash in the main process must be recorded and recoverable rather than
// silently closing the app: the BotManager logs why and restarts the bot.
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  bot?.fatal('uncaught-exception', error).catch(() => {});
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
let config = { token: '', guildId: '', autoStart: true };
const logs = [];
const MAX_LOGS = 500;
const consoleHistory = [];
const MAX_CONSOLE_HISTORY = 300;
let consolePublishAt = 0;
let consolePublishQueued = false;
let activeRoom = null;
let activeRoomId = null;
let updatedTo = null;
let persistTimer = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function roomFilePath() {
  return path.join(app.getPath('userData'), 'room.json');
}

function historyPath(name) {
  return path.join(app.getPath('userData'), name);
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistHistory().catch(() => {});
  }, 800);
}

async function persistHistory() {
  await mkdir(app.getPath('userData'), { recursive: true });
  await Promise.all([
    writeFile(historyPath('activity.json'), JSON.stringify(logs.slice(-MAX_LOGS))),
    writeFile(historyPath('console.json'), JSON.stringify(consoleHistory.slice(-MAX_CONSOLE_HISTORY))),
  ]);
}

async function loadPersistedHistory() {
  try {
    const saved = JSON.parse(await readFile(historyPath('activity.json'), 'utf8'));
    if (Array.isArray(saved)) logs.push(...saved.slice(-MAX_LOGS));
  } catch {}
  try {
    const saved = JSON.parse(await readFile(historyPath('console.json'), 'utf8'));
    if (Array.isArray(saved)) consoleHistory.push(...saved.slice(-MAX_CONSOLE_HISTORY));
  } catch {}

  try {
    const marker = JSON.parse(
      await readFile(path.join(app.getPath('userData'), 'updates', 'pending.json'), 'utf8'),
    );
    if (marker?.version) {
      if (!isNewer(marker.version, app.getVersion())) updatedTo = marker.version;
      await rm(path.join(app.getPath('userData'), 'updates', 'pending.json'), { force: true });
    }
  } catch {}
}

async function readRoomFile() {
  try {
    return JSON.parse(await readFile(roomFilePath(), 'utf8'));
  } catch {
    return null;
  }
}

async function writeRoomFile(roomId) {
  await mkdir(app.getPath('userData'), { recursive: true });
  if (!roomId) {
    await rm(roomFilePath(), { force: true });
    return;
  }
  await writeFile(
    roomFilePath(),
    JSON.stringify({ roomId, accountId: auth?.user?.id ?? null }),
  );
}

async function hydrateRoom() {
  if (!auth?.token || !auth.user) {
    activeRoom = null;
    activeRoomId = null;
    return null;
  }

  const saved = await readRoomFile();
  if (!saved?.roomId) {
    activeRoom = null;
    activeRoomId = null;
    return null;
  }
  if (saved.accountId && saved.accountId !== auth.user.id) {
    activeRoom = null;
    activeRoomId = null;
    return null;
  }

  activeRoomId = saved.roomId;
  try {
    activeRoom = await auth.getRoom(activeRoomId);
    return activeRoom;
  } catch (error) {
    activeRoom = null;
    if (/no longer exists|join this room/i.test(error.message ?? '')) {
      activeRoomId = null;
      await writeRoomFile(null);
      return null;
    }
    throw error;
  }
}

async function setActiveRoom(roomId) {
  activeRoomId = roomId;
  await writeRoomFile(roomId);
  activeRoom = roomId ? await auth.getRoom(roomId) : null;
  queueConsolePublish(true);
  return activeRoom;
}

async function loadConfig() {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const saved = JSON.parse(raw);
    if (saved.tokenEnc && safeStorage.isEncryptionAvailable()) {
      try {
        config.token = safeStorage.decryptString(Buffer.from(saved.tokenEnc, 'base64'));
      } catch {
        config.token = '';
      }
    } else if (typeof saved.token === 'string') {
      config.token = saved.token;
    }
    config.guildId = typeof saved.guildId === 'string' ? saved.guildId : '';
    config.autoStart = saved.autoStart !== false;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Could not read config:', error.message);
    }
  }
}

async function saveConfig(patch = {}) {
  if (typeof patch.token === 'string') config.token = patch.token.trim();
  if (typeof patch.guildId === 'string') config.guildId = patch.guildId.trim();
  if (typeof patch.autoStart === 'boolean') config.autoStart = patch.autoStart;

  const payload = { guildId: config.guildId, autoStart: config.autoStart };
  if (config.token) {
    if (safeStorage.isEncryptionAvailable()) {
      payload.tokenEnc = safeStorage.encryptString(config.token).toString('base64');
    } else {
      payload.token = config.token;
    }
  }

  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function publicConfig() {
  return {
    hasToken: Boolean(config.token),
    tokenHint: config.token ? `••••••••${config.token.slice(-4)}` : '',
    guildId: config.guildId,
    autoStart: config.autoStart,
  };
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function broadcastStatus() {
  if (!bot) return;
  broadcast('status', bot.getStatus());
}

function isRemoteRoom() {
  return Boolean(activeRoom && !activeRoom.isHost);
}

async function sendRoomAction(type, payload = {}, { wait = false, timeout = 15000 } = {}) {
  const room = activeRoom;
  if (!room) throw new Error('Create or join a room first.');
  if (!auth?.token) throw new Error('Sign in to Aegis Control first.');
  if (room.updatedAt && Date.now() - room.updatedAt > 45000) {
    throw new Error('The room host app looks offline. Try again when it is open.');
  }

  const data = await auth.sendRoomAction(room.id, type, payload);
  const actionId = data?.action?.id;
  if (!wait || !actionId) {
    return { queued: true, status: room.status ?? null };
  }

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let action = null;
    try {
      const result = await auth.getRoomAction(room.id, actionId);
      action = result?.action ?? null;
    } catch {
      action = null;
    }
    if (action?.status === 'done' || action?.status === 'error') {
      const result = action.result ?? {};
      if (!result.ok) throw new Error(result.message || 'The host could not run that action.');
      return result.data ?? result.message ?? true;
    }
  }
  throw new Error('The room host did not answer in time.');
}

async function executeRoomAction(action) {
  const payload = action.payload ?? {};
  switch (action.type) {
    case 'start':
      if (!config.token) throw new Error('The host has not saved a bot token yet.');
      await bot.start(config.token);
      return { status: bot.getStatus() };
    case 'stop':
      await bot.stop();
      return { status: bot.getStatus() };
    case 'deploy':
      if (!config.token) throw new Error('The host has not saved a bot token yet.');
      return {
        message: await bot.deployCommands({ token: config.token, guildId: payload.guildId ?? config.guildId }),
        status: bot.getStatus(),
      };
    case 'guild':
      await bot.setGuildSetting(payload.guildId, payload.key, payload.value);
      return { status: bot.getStatus() };
    case 'member':
      await bot.setMemberSetting(payload.guildId, payload.userId, payload.key, payload.value);
      return { status: bot.getStatus() };
    case 'memberAdd':
      await bot.addManagedMember(payload.guildId, payload.userId);
      return { status: bot.getStatus() };
    case 'memberRemove':
      await bot.removeManagedMember(payload.guildId, payload.userId);
      return { status: bot.getStatus() };
    case 'allowAdd':
      await bot.addAllowedUser(String(payload.userId ?? ''));
      return { status: bot.getStatus() };
    case 'allowRemove':
      await bot.removeAllowedUser(String(payload.userId ?? ''));
      return { status: bot.getStatus() };
    case 'console':
      return { message: await bot.runConsole(String(payload.line ?? '')) };
    case 'addAllMembers':
      return { data: await bot.addAllMembers(payload.guildId) };
    default:
      throw new Error('Unknown room action.');
  }
}

let roomActionPolling = false;
const roomActionResults = new Map();

async function pollRoomActions() {
  if (!auth?.token || !activeRoom?.isHost || roomActionPolling) return;
  // Requests count against the hosting allowance, and a minimised window has
  // nobody waiting on the answer.
  if (!mainWindow || mainWindow.isMinimized() || !mainWindow.isVisible()) return;
  const room = activeRoom;
  roomActionPolling = true;
  try {
    const data = await auth.listRoomActions(room.id);
    for (const action of data.actions ?? []) {
      let result = roomActionResults.get(action.id);
      if (!result) {
        try {
          const value = await executeRoomAction(action);
          result = { ok: true, message: '', data: value ?? null };
        } catch (error) {
          result = { ok: false, message: error.message, data: null };
        }
        roomActionResults.set(action.id, result);
        if (roomActionResults.size > 500) {
          roomActionResults.delete(roomActionResults.keys().next().value);
        }
      }

      try {
        await auth.completeRoomAction(room.id, action.id, result);
        roomActionResults.delete(action.id);
      } catch {
        // Keep the result and retry completing it without running the action twice.
      }
      queueConsolePublish(true);
    }
  } catch {
    // Host polling is best effort; the next tick retries.
  } finally {
    roomActionPolling = false;
  }
}

function queueConsolePublish(force = false) {
  if (!auth?.token || !bot || !activeRoom?.isHost) return;
  const now = Date.now();
  if (!force && now - consolePublishAt < 3000) {
    if (consolePublishQueued) return;
    consolePublishQueued = true;
    setTimeout(() => {
      consolePublishQueued = false;
      queueConsolePublish(true);
    }, 3000 - (now - consolePublishAt));
    return;
  }

  consolePublishAt = now;
  const payload = {
    status: bot.getStatus(),
    logs: logs.slice(-150),
    messages: bot.getMessages().slice(-250),
  };
  auth.publishRoomState(activeRoom.id, payload).catch(() => {});
}

function maybeAutoStartBot() {
  if (!bot || !activeRoom?.isHost || !config.token || !config.autoStart) return;
  const status = bot.getStatus();
  if (status.running || status.starting) return;
  bot.start(config.token).catch(() => broadcastStatus());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 660,
    show: false,
    backgroundColor: '#070b16',
    title: 'Aegis Control',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (url.startsWith('https://')) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`Dashboard failed to load (${code}): ${description}`);
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function registerIpc(authStore) {
  const guarded = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      authStore.requireSession();
      return handler(event, ...args);
    });
  };

  const can = (scope, handler) => async (event, ...args) => {
    const account = authStore.requireSession();
    const roomControl = activeRoom && scope !== 'manageKeys' && scope !== 'manageRooms';
    if (!roomControl && !authStore.hasScope(account, scope)) {
      throw new Error('Your panel account does not have permission to do that.');
    }
    return handler(event, ...args);
  };

  ipcMain.handle('auth:status', async () => {
    const status = await authStore.getStatus();
    if (status.authenticated) {
      await hydrateRoom().catch(() => {});
      maybeAutoStartBot();
      queueConsolePublish(true);
    }
    return status;
  });
  ipcMain.handle('auth:register', async (_event, payload) => {
    const status = await authStore.register(payload ?? {});
    setTimeout(() => hydrateRoom().then(() => maybeAutoStartBot()).catch(() => {}), 600);
    setTimeout(() => queueConsolePublish(true), 1200);
    return status;
  });
  ipcMain.handle('auth:login', async (_event, payload) => {
    const status = await authStore.login(payload ?? {});
    setTimeout(() => hydrateRoom().then(() => maybeAutoStartBot()).catch(() => {}), 600);
    setTimeout(() => queueConsolePublish(true), 1200);
    return status;
  });
  ipcMain.handle('auth:auto-login', async () => {
    const status = await authStore.autoLogin();
    setTimeout(() => hydrateRoom().then(() => maybeAutoStartBot()).catch(() => {}), 600);
    setTimeout(() => queueConsolePublish(true), 1200);
    return status;
  });
  ipcMain.handle('auth:lock', () => authStore.lock());
  ipcMain.handle('auth:set-server', async (_event, rawUrl) => {
    const value = String(rawUrl ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/i.test(value)) {
      throw new Error('Enter the server address, for example http://your-host:14651');
    }
    await mkdir(path.dirname(SERVER_FILE), { recursive: true });
    await writeFile(SERVER_FILE, `${value}\n`, 'utf8');
    // Take effect immediately: the store keeps the address it was created with.
    authStore.apiUrl = value;
    authStore.offline = false;
    return authStore.getStatus();
  });
  ipcMain.handle('auth:logout', async () => {
    const status = await authStore.logout();
    activeRoom = null;
    activeRoomId = null;
    await writeRoomFile(null).catch(() => {});
    return status;
  });

  ipcMain.handle('roles:list', async (_event, guildId) => {
    authStore.requirePermission('manageBot');
    return authStore.listRoles(String(guildId ?? ''));
  });
  ipcMain.handle('roles:action', async (_event, payload) => {
    authStore.requirePermission('manageBot');
    return authStore.roleAction(payload ?? {});
  });
  ipcMain.handle('roles:task', async (_event, id) => {
    authStore.requireSession();
    return authStore.roleTask(String(id ?? ''));
  });

  ipcMain.handle('auth:keys:list', () => {
    authStore.requirePermission('manageKeys');
    return authStore.listKeys();
  });
  ipcMain.handle('auth:keys:create', async (_event, payload) => {
    const actor = authStore.requirePermission('manageKeys');
    return authStore.createKey(payload ?? {}, actor);
  });
  ipcMain.handle('auth:keys:update', async (_event, payload) => {
    const actor = authStore.requirePermission('manageKeys');
    return authStore.updateKey(payload ?? {}, actor);
  });
  ipcMain.handle('auth:keys:delete', async (_event, id) => {
    const actor = authStore.requirePermission('manageKeys');
    return authStore.deleteKey(id, actor);
  });

  ipcMain.handle('auth:dashboard-token', async (_event, label) => {
    authStore.requireSession();
    return authStore.createDashboardToken(String(label ?? 'Web dashboard').slice(0, 60));
  });

  ipcMain.handle('auth:discord-unlink', async () => {
    authStore.requireSession();
    return authStore.unlinkDiscord();
  });

  ipcMain.handle('auth:discord-start', async () => {
    const status = bot?.getStatus?.();
    const fromToken = (() => {
      const first = String(config.token ?? '').split('.')[0];
      if (!first) return null;
      const decoded = Buffer.from(first, 'base64').toString('utf8').trim();
      return /^\d{17,20}$/.test(decoded) ? decoded : null;
    })();
    const session = await authStore.startDiscordLogin(status?.id ?? fromToken);
    await shell.openExternal(session.url);
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      let data;
      try {
        data = await authStore.pollDiscordLogin(session.code);
      } catch (error) {
        if (error.status === 400 || error.status === 410) throw error;
        continue;
      }
      if (data.token) return authStore.getStatus();
    }
    throw new Error('Discord sign-in timed out. Try again.');
  });

  guarded('app:info', () => ({
    name: 'Aegis Control',
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
    configPath: configPath(),
    electron: process.versions.electron,
    node: process.versions.node,
    encrypted: safeStorage.isEncryptionAvailable(),
    server: authStore.apiUrl,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    updatedTo,
    room: activeRoom ? { id: activeRoom.id, name: activeRoom.name, isHost: activeRoom.isHost } : null,
  }));

  guarded('app:copy', (_event, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  guarded('app:showAppFile', () => {
    shell.showItemInFolder(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
    return true;
  });

  guarded('status:get', () => bot.getStatus());
  guarded('config:get', () => publicConfig());

    ipcMain.handle(
    'bot:start',
    can('manageBot', async () => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction('start', {}, { wait: true, timeout: 30000 });
        return data?.status ?? activeRoom.status ?? null;
      }
      if (!activeRoom) throw new Error('Create or join a room before starting Aegis.');
      if (!config.token) throw new Error('Save a bot token in Settings first.');
      await bot.start(config.token);
      return bot.getStatus();
    }),
  );
  ipcMain.handle(
    'bot:stop',
    can('manageBot', async () => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction('stop', {}, { wait: true, timeout: 20000 });
        return data?.status ?? activeRoom.status ?? null;
      }
      return bot.stop();
    }),
  );

  ipcMain.handle(
    'config:save',
    can('manageBot', async (_event, patch) => {
      if (isRemoteRoom()) throw new Error('Only the room host can change the bot token or startup settings.');
      await saveConfig(patch ?? {});
      if (patch?.autoStart === true) maybeAutoStartBot();
      return publicConfig();
    }),
  );

  ipcMain.handle(
    'settings:set',
    can('manageRules', async (_event, { guildId, key, value }) => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction('guild', { guildId, key, value }, { wait: true, timeout: 10000 });
        return { settings: null, status: data?.status ?? activeRoom.status ?? null };
      }
      const settings = await bot.setGuildSetting(guildId, key, value);
      return { settings, status: bot.getStatus() };
    }),
  );

  ipcMain.handle(
    'settings:member',
    can('manageRules', async (_event, { guildId, userId, key, value }) => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction(
          'member',
          { guildId, userId, key, value },
          { wait: true, timeout: 10000 },
        );
        return { settings: null, status: data?.status ?? activeRoom.status ?? null };
      }
      const settings = await bot.setMemberSetting(guildId, userId, key, value);
      return { settings, status: bot.getStatus() };
    }),
  );

  ipcMain.handle(
    'members:add',
    can('manageRules', async (_event, { guildId, userId }) => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction('memberAdd', { guildId, userId }, { wait: true, timeout: 10000 });
        return data?.status ?? activeRoom.status ?? null;
      }
      await bot.addManagedMember(guildId, userId);
      return bot.getStatus();
    }),
  );

  ipcMain.handle(
    'members:addAll',
    can('manageRules', async (_event, { guildId }) => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction(
          'addAllMembers',
          { guildId },
          { wait: true, timeout: 60000 },
        );
        return data ?? { added: 0, total: 0, status: activeRoom.status ?? null };
      }
      return bot.addAllMembers(guildId);
    }),
  );

  ipcMain.handle(
    'members:remove',
    can('manageRules', async (_event, { guildId, userId }) => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction(
          'memberRemove',
          { guildId, userId },
          { wait: true, timeout: 10000 },
        );
        return data?.status ?? activeRoom.status ?? null;
      }
      await bot.removeManagedMember(guildId, userId);
      return bot.getStatus();
    }),
  );

  ipcMain.handle(
    'allowlist:add',
    can('manageRules', async (_event, userId) => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction('allowAdd', { userId }, { wait: true, timeout: 10000 });
        return data?.status ?? activeRoom.status ?? null;
      }
      await bot.addAllowedUser(userId);
      return bot.getStatus();
    }),
  );

  ipcMain.handle(
    'allowlist:remove',
    can('manageRules', async (_event, userId) => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction('allowRemove', { userId }, { wait: true, timeout: 10000 });
        return data?.status ?? activeRoom.status ?? null;
      }
      await bot.removeAllowedUser(userId);
      return bot.getStatus();
    }),
  );

  ipcMain.handle(
    'commands:deploy',
    can('manageBot', async (_event, guildId) => {
      if (isRemoteRoom()) {
        const data = await sendRoomAction(
          'deploy',
          { guildId: guildId ?? null },
          { wait: true, timeout: 60000 },
        );
        return data?.message ?? 'Commands deployed.';
      }
      if (!config.token) throw new Error('Save a bot token in Settings first.');
      return bot.deployCommands({ token: config.token, guildId: guildId ?? config.guildId });
    }),
  );

  ipcMain.handle(
    'console:run',
    can('useConsole', async (_event, line) => {
      const text = String(line ?? '');
      consoleHistory.push({ text: `aegis › ${text}`, kind: 'echo', at: Date.now() });
      let result;
      try {
        if (isRemoteRoom()) {
          const data = await sendRoomAction('console', { line: text }, { wait: true, timeout: 30000 });
          result = typeof data === 'string' ? data : data?.message ?? '';
        } else {
          result = await bot.runConsole(text);
        }
        if (result) consoleHistory.push({ text: String(result), kind: 'out', at: Date.now() });
      } catch (error) {
        consoleHistory.push({ text: error.message, kind: 'err', at: Date.now() });
        schedulePersist();
        throw error;
      }
      if (consoleHistory.length > MAX_CONSOLE_HISTORY) {
        consoleHistory.splice(0, consoleHistory.length - MAX_CONSOLE_HISTORY);
      }
      schedulePersist();
      return result;
    }),
  );
  ipcMain.handle('logs:get', can('viewLogs', () => logs));
  guarded('console:history', () => consoleHistory.slice(-MAX_CONSOLE_HISTORY));
  guarded('messages:get', () => bot.getMessages());

  ipcMain.handle('rooms:list', async () => {
    authStore.requireSession();
    const data = await authStore.listRooms();
    return { ...data, activeRoomId };
  });
  ipcMain.handle('rooms:current', async () => {
    authStore.requireSession();
    return hydrateRoom();
  });
  ipcMain.handle('rooms:create', async (_event, name) => {
    authStore.requirePermission('manageRooms');
    const room = await authStore.createRoom(String(name ?? ''));
    return setActiveRoom(room.id);
  });
  ipcMain.handle('rooms:join-code', async (_event, code) => {
    authStore.requireSession();
    const room = await authStore.joinRoomByCode(String(code ?? ''));
    return setActiveRoom(room.id);
  });
  ipcMain.handle('rooms:join', async (_event, id) => {
    authStore.requirePermission('manageRooms');
    await authStore.joinRoom(id);
    return setActiveRoom(id);
  });
  ipcMain.handle('rooms:select', async (_event, id) => {
    authStore.requireSession();
    return setActiveRoom(id);
  });
  ipcMain.handle('rooms:leave', async (_event, id) => {
    authStore.requireSession();
    await authStore.leaveRoom(id);
    if (activeRoomId === id) {
      activeRoom = null;
      activeRoomId = null;
      await writeRoomFile(null);
    }
    return true;
  });
  ipcMain.handle('rooms:delete', async (_event, id) => {
    authStore.requireSession();
    await authStore.deleteRoom(id);
    if (activeRoomId === id) {
      activeRoom = null;
      activeRoomId = null;
      await writeRoomFile(null);
    }
    return true;
  });
  ipcMain.handle('rooms:removeMember', async (_event, { roomId, accountId }) => {
    authStore.requireSession();
    await authStore.removeRoomMember(roomId, accountId);
    return true;
  });
  ipcMain.handle('rooms:invite', async (_event, { roomId, publicId }) => {
    authStore.requireSession();
    return authStore.inviteToRoom(roomId, publicId);
  });
  ipcMain.handle('invites:respond', async (_event, { id, accept }) => {
    authStore.requireSession();
    const data = await authStore.respondInvite(id, accept);
    if (accept && data.room) await setActiveRoom(data.room.id);
    return data;
  });
  ipcMain.handle('rooms:request', async (_event, roomId) => {
    authStore.requireSession();
    return authStore.requestRoom(roomId);
  });
  ipcMain.handle('requests:respond', async (_event, { id, accept }) => {
    authStore.requireSession();
    return authStore.respondRoomRequest(id, accept);
  });
  ipcMain.handle('social:get', async () => {
    authStore.requireSession();
    return authStore.getSocial();
  });
  ipcMain.handle('friends:request', async (_event, publicId) => {
    authStore.requireSession();
    return authStore.addFriend(String(publicId ?? ''));
  });
  ipcMain.handle('friends:respond', async (_event, { id, accept }) => {
    authStore.requireSession();
    return authStore.respondFriend(id, accept);
  });
  ipcMain.handle('friends:remove', async (_event, accountId) => {
    authStore.requireSession();
    return authStore.removeFriend(accountId);
  });

  ipcMain.handle('console:linked', async () => {
    const account = authStore.requireSession();
    if (account.role !== 'owner' && !authStore.hasScope(account, 'linkConsole')) {
      throw new Error('This key does not have the Linked console permission.');
    }
    return authStore.getSharedConsole();
  });

  ipcMain.handle('update:check', () => checkForUpdate(app.getVersion()));
  ipcMain.handle('update:download', (_event, release) =>
    downloadUpdate(release, path.join(app.getPath('userData'), 'updates'), (percent) =>
      broadcast('update:progress', { percent }),
    ),
  );
  ipcMain.handle('update:install', async (_event, release) => {
    await mkdir(path.join(app.getPath('userData'), 'updates'), { recursive: true });
    await writeFile(
      path.join(app.getPath('userData'), 'updates', 'pending.json'),
      JSON.stringify({ version: release.version }),
    );
    await installUpdate(release, path.join(app.getPath('userData'), 'updates'));
    setTimeout(() => app.quit(), 600);
    return true;
  });

  guarded('app:openExternal', async (_event, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) await shell.openExternal(url);
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  bot?.stop().catch(() => {});
});

async function startup() {
  await loadConfig();

  auth = new AuthStore({
    filePath: path.join(app.getPath('userData'), 'auth.json'),
    machineId: machineId(),
  });
  await auth.load();
  await loadPersistedHistory();
  registerIpc(auth);

  bot = new BotManager({ dataDir: app.getPath('userData') });
  await bot.init();

  bot.on('log', (entry) => {
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
    broadcast('log', entry);
    queueConsolePublish();
    schedulePersist();
  });

  bot.on('message', (entry) => {
    broadcast('message', entry);
    if (activeRoom?.isHost) queueConsolePublish();
  });

  // One command check a minute keeps the runner well inside the hosting
  // request allowance; the desktop app is attended, so a short delay is fine.
  setInterval(pollRoomActions, 60_000).unref?.();

  bot.on('status', () => {
    broadcastStatus();
    queueConsolePublish();
  });

  bot.on('crash', (entry) => {
    broadcast('crash', entry);
    // Only the owner account may store crash reports; anyone else keeps them locally.
    if (auth?.user?.role === 'owner') auth.reportCrash?.(entry).catch(() => {});
  });

  // Console publishing is a courtesy refresh for linked viewers, so do it
  // slowly and skip it while the window is minimised.
  setInterval(() => {
    if (mainWindow && !mainWindow.isMinimized() && mainWindow.isVisible()) {
      queueConsolePublish(true);
    }
  }, 120_000);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app
  .whenReady()
  .then(() => {
    return startup();
  })
  .catch((error) => {
    console.error('Startup failed:', error);
    app.exit(1);
  });
