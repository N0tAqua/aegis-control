import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Fresh per-server configuration. Always returns new nested objects. */
export function createGuildState() {
  return {
    logging: {
      channels: {
        messages: null,
        members: null,
        roles: null,
        channels: null,
        moderation: null,
        voice: null,
      },
      enabled: {
        messages: true,
        members: true,
        roles: true,
        channels: true,
        moderation: true,
        voice: false,
      },
    },
    reactionRoles: { panels: {} },
    tickets: {
      categories: [],
      counter: 0,
      open: {},
      closed: {},
      staff: {},
      panelChannelId: null,
      panelMessageId: null,
      categoryChannelId: null,
      transcriptChannelId: null,
    },
    giveaways: { items: {}, counter: 0 },
    tempVoice: { creatorChannelId: null, categoryId: null, channels: {} },
    staff: { roles: [], channelId: null, members: {}, lastDigestAt: 0 },
    activity: { days: {} },
    intel: {
      alerts: [],
      joins: [],
      lastScanAt: 0,
      lastAlertAt: {},
      channelId: null,
      enabled: true,
    },
    profiles: {},
    backups: [],
    ai: { reportChannelId: null, lastReportAt: 0 },
    panic: {
      active: false,
      startedAt: null,
      endedAt: null,
      by: null,
      reason: '',
      channels: [],
      failed: [],
      timeline: [],
      verification: null,
      quarantineRoleId: null,
      quarantined: [],
      quarantineReport: null,
      joinWindowMs: 3_600_000,
    },
    guard: { enabled: false, threshold: 3, windowMs: 60_000, channelId: null, trustedRoles: [], incidents: [], lastBreachAt: {} },
    doctor: { lastRunAt: 0, score: null, grade: null, checks: [] },
    economy: {
      enabled: true,
      perMessage: 3,
      perVoiceMinute: 2,
      cooldownSec: 45,
      minLength: 6,
      items: {},
      balances: {},
      log: [],
    },
    events: { enabled: true, items: {}, counter: 0 },
    stats: { enabled: false, categoryId: null, channels: {}, lastRunAt: 0, lastNames: {} },
  };
}

/**
 * Small JSON document store with atomic writes and a debounced save, so a busy
 * server never writes the whole file for every message.
 */
export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, guilds: {} };
    this.chain = Promise.resolve();
    this.timer = null;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.guilds && typeof parsed.guilds === 'object') {
        this.data = { version: 1, guilds: parsed.guilds };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[warn] Could not read ${path.basename(this.filePath)}: ${error.message}`);
      }
    }
    return this;
  }

  guild(guildId) {
    const id = String(guildId);
    if (!this.data.guilds[id]) this.data.guilds[id] = createGuildState();
    const state = this.data.guilds[id];
    const fresh = createGuildState();
    for (const [key, value] of Object.entries(fresh)) {
      if (state[key] === undefined || state[key] === null) state[key] = value;
      else if (typeof value === 'object' && !Array.isArray(value) && typeof state[key] === 'object') {
        for (const [inner, innerValue] of Object.entries(value)) {
          if (state[key][inner] === undefined) state[key][inner] = innerValue;
        }
      }
    }
    return state;
  }

  saveNow() {
    this.chain = this.chain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.data)}\n`, 'utf8');
      await rename(tmp, this.filePath);
    });
    return this.chain;
  }

  save() {
    if (this.timer) return this.chain;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow().catch((error) => {
        console.warn(`[warn] Could not save ${path.basename(this.filePath)}: ${error.message}`);
      });
    }, 1200);
    this.timer.unref?.();
    return this.chain;
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.saveNow();
  }
}
