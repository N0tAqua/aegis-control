import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { API_URL } from './config.js';

/** Panel permissions that can be attached to a key (and its account). */
export const SCOPES = ['manageBot', 'manageRules', 'useConsole', 'viewLogs', 'manageKeys', 'manageRooms', 'linkConsole'];
export const DEFAULT_KEY_SCOPES = ['manageBot', 'manageRules', 'useConsole', 'viewLogs'];

function accountScopes(account) {
  if (!account) return [];
  if (account.role === 'owner') return [...SCOPES];
  return Array.isArray(account.scopes)
    ? account.scopes.filter((scope) => SCOPES.includes(scope))
    : [];
}

/**
 * A stable fingerprint for this Windows installation. Uses the MachineGuid so a
 * hostname change does not break a key.
 */
export function machineId() {
  let guid = '';
  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true },
    );
    guid = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(output)?.[1] ?? '';
  } catch {
    guid = '';
  }

  const parts = guid
    ? ['machine-guid', guid.toLowerCase()]
    : ['fallback', os.hostname(), os.platform(), os.arch(), os.cpus()?.[0]?.model ?? ''];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function derivePassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

/**
 * Panel accounts live on the hosted Aegis server, so keys and permissions work
 * on any computer. Only the session token and the last known account are kept
 * on disk. Password hashing happens here; the server stores a verifier.
 */
export class AuthStore {
  constructor({ filePath, machineId: machine, apiUrl = API_URL }) {
    this.filePath = filePath;
    this.machineId = machine;
    this.apiUrl = String(apiUrl || API_URL).replace(/\/+$/, '');
    this.token = null;
    this.user = null;
    this.locked = false;
    this.offline = false;
    this.discordSupported = false;
    this.setup = { firstRun: false, ownerKey: null };
    this.saveChain = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (typeof parsed?.token === 'string') this.token = parsed.token;
      if (parsed?.user && typeof parsed.user === 'object') this.user = parsed.user;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Could not read the saved session:', error.message);
      }
    }
    return this;
  }

  async save() {
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      const payload = { token: this.token, user: this.user, savedAt: Date.now() };
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await rename(tmp, this.filePath);
    });
    return this.saveChain;
  }

  async request(pathname, { method = 'GET', body, token = this.token, timeout = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = { 'x-aegis-hwid': this.machineId };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetch(`${this.apiUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      const error = new Error('Cannot reach the Aegis server. Check your internet connection.');
      error.status = 0;
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      // A paused site is answered with plain text, so show that instead of a
      // bare status code: "reached its hosting allowance" explains a 429.
      const plain =
        text && text.length <= 300 && !text.trim().startsWith('<') ? text.trim() : '';
      const error = new Error(
        data.error || plain || `The Aegis server rejected that request (${response.status}).`,
      );
      error.status = response.status;
      throw error;
    }
    return data;
  }

  getStatusPayload({ firstRun = this.setup.firstRun, ownerKey = null } = {}) {
    const authenticated = !this.locked && Boolean(this.token) && Boolean(this.user);
    return {
      authenticated,
      user: authenticated
        ? {
            id: this.user.id,
            username: this.user.username,
            role: this.user.role,
            scopes: accountScopes(this.user),
            createdAt: this.user.createdAt,
            discordId: this.user.discordId ?? null,
            discordUsername: this.user.discordUsername ?? null,
            discordAvatar: this.user.discordAvatar ?? null,
            key: this.user.key ?? null,
          }
        : null,
      discordLinked: Boolean(authenticated && this.user?.discordId),
      discordSupported: this.discordSupported,
      firstRun: Boolean(firstRun),
      ownerKey: firstRun ? ownerKey : null,
      autoLoginUser: this.token && this.user ? this.user.username : null,
      machine: this.machineId.slice(0, 12),
      server: this.apiUrl,
      offline: this.offline,
    };
  }

  async getStatus() {
    this.offline = false;
    let setup = { firstRun: this.setup.firstRun, ownerKey: null };

    try {
      const data = await this.request('/api/setup', { token: null });
      setup = { firstRun: Boolean(data.firstRun), ownerKey: data.ownerKey ?? null };
      this.discordSupported = data.discordSupported === true;
      this.setup = setup;
    } catch (error) {
      this.offline = true;
    }

    if (this.token && !this.locked) {
      try {
        const data = await this.request('/api/auth/verify', { method: 'POST' });
        this.user = data.account;
        this.discordSupported = data.discordSupported === true;
        this.offline = false;
        await this.save();
      } catch (error) {
        // Only a real rejection signs the user out. A paused site (429) or a
        // server hiccup (5xx) must keep the saved session so the app comes back
        // signed in once the server answers again.
        if (error.status === 0 || error.status === 429 || error.status >= 500) {
          this.offline = true;
        } else {
          this.token = null;
          this.user = null;
          await this.save();
        }
      }
    }

    return this.getStatusPayload(setup);
  }

  currentAccount() {
    if (this.locked) return null;
    return this.user ?? null;
  }

  requireSession() {
    const account = this.currentAccount();
    if (!account) throw new Error('Sign in to Aegis Control first.');
    return account;
  }

  hasScope(account, scope) {
    if (!account) return false;
    if (account.role === 'owner') return true;
    return accountScopes(account).includes(scope);
  }

  requirePermission(scope) {
    const account = this.requireSession();
    if (!this.hasScope(account, scope)) {
      throw new Error('Your panel account does not have permission to do that.');
    }
    return account;
  }

  async register({ username: rawUsername, password: rawPassword, key: rawKey } = {}) {
    const username = String(rawUsername ?? '').trim();
    const password = String(rawPassword ?? '');
    const key = String(rawKey ?? '').trim().toUpperCase();

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      throw new Error('Username must be 3-24 letters, numbers or underscores.');
    }
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    if (!key) throw new Error('A licence key is required.');

    const salt = randomBytes(16).toString('base64');
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      token: null,
      body: {
        username,
        passwordHash: derivePassword(password, salt),
        salt,
        key,
        hwid: this.machineId,
      },
    });

    this.token = data.token;
    this.user = data.account;
    this.discordSupported = data.discordSupported === true;
    this.locked = false;
    this.offline = false;
    this.setup = { firstRun: false, ownerKey: null };
    await this.save();
    return this.getStatusPayload({ firstRun: false });
  }

  async login({ username: rawUsername, password: rawPassword } = {}) {
    const username = String(rawUsername ?? '').trim();
    const password = String(rawPassword ?? '');
    if (!username || !password) throw new Error('Enter your username and password.');

    const { salt } = await this.request(`/api/auth/salt?username=${encodeURIComponent(username)}`, {
      token: null,
    });
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      token: null,
      body: {
        username,
        passwordHash: derivePassword(password, salt),
        hwid: this.machineId,
      },
    });

    this.token = data.token;
    this.user = data.account;
    this.discordSupported = data.discordSupported === true;
    this.locked = false;
    this.offline = false;
    await this.save();
    return this.getStatusPayload({ firstRun: false });
  }

  async autoLogin() {
    if (!this.token) throw new Error('No saved session yet. Sign in with your password.');
    this.locked = false;
    const status = await this.getStatus();
    if (!status.authenticated) {
      throw new Error(
        status.offline
          ? 'Cannot reach the Aegis server. Check your internet connection.'
          : 'Your session expired. Sign in with your password.',
      );
    }
    return status;
  }

  lock() {
    this.locked = true;
    return this.getStatusPayload({ firstRun: false });
  }

  async logout() {
    try {
      if (this.token) await this.request('/api/auth/logout', { method: 'POST' });
    } catch {
      // Signing out locally must work even when the server is unreachable.
    }
    this.token = null;
    this.user = null;
    this.locked = false;
    this.offline = false;
    await this.save();
    return this.getStatusPayload({ firstRun: false });
  }

  async listKeys() {
    const data = await this.request('/api/keys');
    return data.keys ?? [];
  }

  async createKey({ label, scopes, discordId } = {}) {
    const data = await this.request('/api/keys', {
      method: 'POST',
      body: { label, scopes, discordId },
    });
    return data.keys ?? [];
  }

  async updateKey({ id, label, disabled, resetHwid, scopes, discordId } = {}) {
    const data = await this.request(`/api/keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { label, disabled, resetHwid, scopes, discordId },
    });
    return data.keys ?? [];
  }

  async deleteKey(id) {
    const data = await this.request(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return data.keys ?? [];
  }

  async listRooms() {
    return this.request('/api/rooms');
  }

  async createRoom(name) {
    const data = await this.request('/api/rooms', { method: 'POST', body: { name } });
    return data.room;
  }

  async joinRoomByCode(code) {
    const data = await this.request('/api/rooms/join', { method: 'POST', body: { code } });
    return data.room;
  }

  async joinRoom(id) {
    const data = await this.request(`/api/rooms/${encodeURIComponent(id)}/join`, { method: 'POST' });
    return data.room;
  }

  async getRoom(id) {
    const data = await this.request(`/api/rooms/${encodeURIComponent(id)}`);
    return data.room;
  }

  async leaveRoom(id) {
    return this.request(`/api/rooms/${encodeURIComponent(id)}/leave`, { method: 'POST' });
  }

  async deleteRoom(id) {
    return this.request(`/api/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async publishRoomState(id, { status, logs, messages }) {
    return this.request(`/api/rooms/${encodeURIComponent(id)}/state`, {
      method: 'POST',
      body: { status, logs, messages },
    });
  }

  async removeRoomMember(roomId, accountId) {
    return this.request(
      `/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(accountId)}`,
      { method: 'DELETE' },
    );
  }

  async getSocial() {
    return this.request('/api/social');
  }

  async addFriend(publicId) {
    return this.request('/api/friends/request', { method: 'POST', body: { publicId } });
  }

  async respondFriend(id, accept) {
    return this.request('/api/friends/respond', { method: 'POST', body: { id, accept } });
  }

  async removeFriend(accountId) {
    return this.request(`/api/friends/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
  }

  async inviteToRoom(roomId, publicId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/invites`, {
      method: 'POST',
      body: { publicId },
    });
  }

  async respondInvite(id, accept) {
    return this.request(`/api/invites/${encodeURIComponent(id)}/respond`, {
      method: 'POST',
      body: { accept },
    });
  }

  async requestRoom(roomId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/request`, { method: 'POST' });
  }

  async respondRoomRequest(id, accept) {
    return this.request(`/api/requests/${encodeURIComponent(id)}/respond`, {
      method: 'POST',
      body: { accept },
    });
  }

  async listRoomActions(roomId) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/actions`);
  }

  async completeRoomAction(roomId, actionId, result) {
    return this.request(
      `/api/rooms/${encodeURIComponent(roomId)}/actions/${encodeURIComponent(actionId)}/result`,
      { method: 'POST', body: result },
    );
  }

  async sendRoomAction(roomId, type, payload) {
    return this.request(`/api/rooms/${encodeURIComponent(roomId)}/actions`, {
      method: 'POST',
      body: { type, payload },
    });
  }

  async getRoomAction(roomId, actionId) {
    return this.request(
      `/api/rooms/${encodeURIComponent(roomId)}/actions/${encodeURIComponent(actionId)}`,
    );
  }


  async createDashboardToken(label = 'Web dashboard') {
    return this.request('/api/web/tokens', { method: 'POST', body: { label } });
  }

  async reportCrash(entry) {
    return this.request('/api/bot/crashes', {
      method: 'POST',
      body: { crashes: [entry] },
    });
  }

  async startDiscordLogin(clientId = null) {
    return this.request('/api/auth/discord/desktop/start', {
      method: 'POST',
      body: { clientId: clientId || null },
    });
  }

  async unlinkDiscord() {
    await this.request('/api/auth/discord/unlink', { method: 'POST' });
    return this.getStatus();
  }

  async pollDiscordLogin(code) {
    const data = await this.request('/api/auth/discord/desktop/poll', {
      method: 'POST',
      token: null,
      body: { code },
    });
    if (data.token) {
      this.token = data.token;
      this.user = data.account;
      this.discordSupported = true;
      this.locked = false;
      this.offline = false;
      await this.save();
    }
    return data;
  }

  async getSharedConsole() {
    const data = await this.request('/api/console');
    return data.console ?? null;
  }

  async publishSharedConsole({ status, logs }) {
    return this.request('/api/console', {
      method: 'POST',
      body: { status, logs },
    });
  }
}
