import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
} from 'discord.js';
import { commands, commandsByName } from './commands.js';
import { FeatureManager } from './features/index.js';

const DEDUPE_MS = 2000;

/** Close codes Discord sends when the session cannot recover by reconnecting. */
const FATAL_GATEWAY_CODES = new Set([4004, 4010, 4011, 4013, 4014]);
const MAX_CRASHES = 80;
const CRASH_STACK_LIMIT = 4000;
const GUILD_KEYS = ['antiServerMute', 'antiServerDeafen'];
const MEMBER_KEYS = [
  'antiServerMute',
  'antiServerDeafen',
  'forceServerMute',
  'forceServerDeafen',
];

const HELP_TEXT = [
  'Available commands:',
  '  help                                    show this list',
  '  status                                  bot status and uptime',
  '  guilds                                  servers Aegis is in',
  '  members <guildId>                       managed members and their rules',
  '  antimute <guildId> on|off               server-wide mute protection',
  '  antideafen <guildId> on|off             server-wide deafen protection',
  '  protect <guildId> <userId> mute|deafen on|off|clear',
  '  force <guildId> <userId> mute|deafen on|off',
  '  allowlist                               list allowed users',
  '  allowlist add <userId>                  let a user control Aegis',
  '  allowlist remove <userId>               revoke a user',
  '  say <channelId> <message>               send a message as Aegis',
].join('\n');

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

/** "#ff6600" or a number -> colour int, null when the input is empty. */
function roleColor(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(0xffffff, Math.max(0, Math.trunc(value)));
  }
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  return match ? Number.parseInt(match[1], 16) : null;
}

function normalizeMember(raw) {
  return {
    displayName: typeof raw?.displayName === 'string' ? raw.displayName : null,
    username: typeof raw?.username === 'string' ? raw.username : null,
    avatar: typeof raw?.avatar === 'string' ? raw.avatar : null,
    antiServerMute: typeof raw?.antiServerMute === 'boolean' ? raw.antiServerMute : null,
    antiServerDeafen: typeof raw?.antiServerDeafen === 'boolean' ? raw.antiServerDeafen : null,
    forceServerMute: raw?.forceServerMute === true,
    forceServerDeafen: raw?.forceServerDeafen === true,
  };
}

function isMemberEmpty(member) {
  return (
    member.antiServerMute === null &&
    member.antiServerDeafen === null &&
    !member.forceServerMute &&
    !member.forceServerDeafen
  );
}

/**
 * Owns the Discord client and all persisted settings. Used by both the desktop
 * dashboard and the headless CLI, so behaviour is identical in both.
 */
/**
 * A command registered both globally and in a server is listed twice in Discord.
 * Deploying writes one scope, so this clears the same names from the other one.
 */
export async function clearCommandCopies({ rest, applicationId, names, guildId, guildIds = [] }) {
  const removed = [];

  if (guildId) {
    const existing = await rest.get(Routes.applicationCommands(applicationId)).catch(() => []);
    for (const command of existing ?? []) {
      if (!names.has(command.name)) continue;
      const done = await rest
        .delete(Routes.applicationCommand(applicationId, command.id))
        .then(() => true)
        .catch(() => false);
      if (done) removed.push(`/${command.name} (global copy)`);
    }
    return removed;
  }

  for (const id of guildIds) {
    const existing = await rest
      .get(Routes.applicationGuildCommands(applicationId, id))
      .catch(() => []);
    for (const command of existing ?? []) {
      if (!names.has(command.name)) continue;
      const done = await rest
        .delete(Routes.applicationGuildCommand(applicationId, id, command.id))
        .then(() => true)
        .catch(() => false);
      if (done) removed.push(`/${command.name} (server copy)`);
    }
  }
  return removed;
}

export class BotManager extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    this.settingsPath = path.join(dataDir, 'settings.json');
    this.messagesPath = path.join(dataDir, 'messages.json');
    this.data = { guilds: {}, guildNames: {}, allowlist: [] };
    this.messages = [];
    this.saveMessagesChain = Promise.resolve();
    this.saveMessagesTimer = null;
    this.client = null;
    this.starting = false;
    this.startedAt = null;
    this.lastError = null;
    this.token = '';
    this.messageContentEnabled = null;
    this.serverMembersEnabled = null;
    this.handled = new Map();
    this.rechecks = new Map();
    this.warned = new Set();
    this.saveChain = Promise.resolve();
    this.features = new FeatureManager({ dataDir });

    // Crash supervision: every fatal client failure is recorded with its stack
    // and the bot brings itself back up, without anyone pressing Start again.
    this.crashPath = path.join(dataDir, 'crashes.json');
    this.crashes = [];
    this.saveCrashesChain = Promise.resolve();
    this.wantRunning = false;
    this.restartTimer = null;
    this.restartAt = null;
    this.restartAttempts = 0;
    this.crashBusy = false;
    this.unreadySince = null;
    this.lastClientError = null;

    setInterval(() => this.checkGateway(), 20_000).unref?.();

    setInterval(() => {
      const cutoff = Date.now() - DEDUPE_MS * 5;
      for (const [key, timestamp] of this.handled) {
        if (timestamp < cutoff) this.handled.delete(key);
      }
    }, 60_000).unref();
  }

  log(level, message) {
    const entry = { level, message, at: Date.now() };
    this.emit('log', entry);
    const line = `[${level}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  /* -------------------------------------------------------------- crashes --- */

  saveCrashes() {
    this.saveCrashesChain = this.saveCrashesChain
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.crashPath), { recursive: true });
        await writeFile(this.crashPath, `${JSON.stringify(this.crashes.slice(-MAX_CRASHES))}\n`, 'utf8');
      });
    return this.saveCrashesChain;
  }

  getCrashes() {
    return [...this.crashes].reverse();
  }

  /** Store why something broke. Kept on disk so it survives a restart. */
  async recordCrash(reason, error, detail = {}) {
    const facts = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
    const now = Date.now();
    const entry = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      at: now,
      reason: String(reason || 'crashed').slice(0, 60),
      name: String(facts.name || 'Error').slice(0, 80),
      message: String(facts.message || 'Unknown error').slice(0, 600),
      code:
        detail.code !== undefined && detail.code !== null
          ? String(detail.code).slice(0, 40)
          : facts.code
            ? String(facts.code).slice(0, 40)
            : null,
      stack: String(facts.stack || '').slice(0, CRASH_STACK_LIMIT),
      detail: detail.detail ? String(detail.detail).slice(0, 400) : null,
      uptimeMs: this.startedAt ? now - this.startedAt : 0,
      restarts: this.restartAttempts,
      repeats: 0,
    };

    // An identical failure every few seconds must not bury the first one.
    const last = this.crashes[this.crashes.length - 1];
    const repeated =
      last && last.reason === entry.reason && last.message === entry.message && now - last.at < 60_000;
    if (repeated) {
      last.at = now;
      last.uptimeMs = entry.uptimeMs;
      last.restarts = entry.restarts;
      last.repeats = (Number(last.repeats) || 0) + 1;
    } else {
      this.crashes.push(entry);
      if (this.crashes.length > MAX_CRASHES) this.crashes.splice(0, this.crashes.length - MAX_CRASHES);
    }

    this.lastError = `${entry.reason}: ${entry.message}`;
    this.log('error', `Crashed (${entry.reason}): ${entry.message}`);
    await this.saveCrashes().catch(() => {});
    if (!repeated) this.emit('crash', entry);
    return entry;
  }

  /** Called when the client or the host process hits something fatal. */
  async fatal(reason, error, detail = {}) {
    if (this.crashBusy) return null;
    this.crashBusy = true;
    try {
      const entry = await this.recordCrash(reason, error, detail);
      const client = this.client;
      this.client = null;
      this.startedAt = null;
      this.starting = false;
      this.unreadySince = null;
      try {
        client?.destroy();
      } catch {
        // already gone
      }
      this.emit('status');
      if (this.wantRunning) this.scheduleRestart();
      return entry;
    } finally {
      this.crashBusy = false;
    }
  }

  scheduleRestart() {
    if (this.restartTimer || !this.wantRunning || !this.token) return;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.restartAttempts, 5));
    this.restartAttempts += 1;
    this.restartAt = Date.now() + delay;
    this.log('warn', `Restarting Aegis in ${Math.round(delay / 1000)}s (attempt ${this.restartAttempts}).`);
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      this.restartAt = null;
      if (!this.wantRunning || this.client) return;
      try {
        await this.start(this.token);
      } catch (error) {
        await this.recordCrash('restart-failed', error, {
          detail: `restart attempt ${this.restartAttempts}`,
        });
        this.scheduleRestart();
      }
    }, delay);
    this.restartTimer.unref?.();
    this.emit('status');
  }

  /** A silent dead gateway is a crash too: reconnect after two minutes down. */
  checkGateway() {
    if (!this.wantRunning || !this.client || this.starting) return;
    if (this.client.isReady()) {
      this.unreadySince = null;
      return;
    }
    this.unreadySince ??= Date.now();
    if (Date.now() - this.unreadySince > 120_000) {
      this.unreadySince = null;
      this.fatal('gateway-timeout', new Error('Discord did not reconnect for over two minutes.'));
    }
  }

  async init() {
    try {
      const raw = await readFile(this.settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        guilds: parsed?.guilds && typeof parsed.guilds === 'object' ? parsed.guilds : {},
        guildNames:
          parsed?.guildNames && typeof parsed.guildNames === 'object' ? parsed.guildNames : {},
        allowlist: Array.isArray(parsed?.allowlist)
          ? [...new Set(parsed.allowlist.map(String))]
          : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.log('warn', `Could not read settings file, starting fresh: ${error.message}`);
      }
    }

    try {
      const raw = await readFile(this.messagesPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.messages = parsed.slice(-1000).map((entry) => ({
          ...entry,
          contentHidden:
            entry.contentHidden ?? (!String(entry.content ?? '').trim() && !entry.attachments),
        }));
      }
    } catch {
      // No message history yet.
    }

    try {
      const raw = await readFile(this.crashPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.crashes = parsed.slice(-MAX_CRASHES);
    } catch {
      // No crash history yet.
    }

    await this.features.init();
    return this;
  }

  saveMessages() {
    this.saveMessagesChain = this.saveMessagesChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.messagesPath), { recursive: true });
      await writeFile(this.messagesPath, `${JSON.stringify(this.messages.slice(-1000))}\n`, 'utf8');
    });
    return this.saveMessagesChain;
  }

  scheduleSaveMessages() {
    if (this.saveMessagesTimer) return;
    this.saveMessagesTimer = setTimeout(() => {
      this.saveMessagesTimer = null;
      this.saveMessages().catch(() => {});
    }, 1500);
    this.saveMessagesTimer.unref?.();
  }

  getMessages() {
    return [...this.messages];
  }

  async save() {
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(path.dirname(this.settingsPath), { recursive: true });
      const tmp = `${this.settingsPath}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      await rename(tmp, this.settingsPath);
    });
    return this.saveChain;
  }

  /* ------------------------------------------------------------ settings --- */

  getGuildSettings(guildId) {
    const saved = this.data.guilds[guildId] ?? {};
    const members = {};
    const rawMembers = saved.members && typeof saved.members === 'object' ? saved.members : {};
    for (const [userId, raw] of Object.entries(rawMembers)) {
      members[userId] = normalizeMember(raw);
    }
    return {
      antiServerMute: Boolean(saved.antiServerMute),
      antiServerDeafen: Boolean(saved.antiServerDeafen),
      members,
    };
  }

  async setGuildSetting(guildId, key, value) {
    if (!GUILD_KEYS.includes(key)) throw new Error(`Unknown setting "${key}".`);
    if (!isSnowflake(guildId)) throw new Error('That does not look like a server ID.');

    const guild = this.getGuildSettings(guildId);
    guild[key] = Boolean(value);
    this.data.guilds[guildId] = guild;
    await this.save();
    this.emit('status');
    return guild;
  }

  getMemberSettings(guildId, userId) {
    return normalizeMember(this.data.guilds[guildId]?.members?.[userId]);
  }

  getManagedMembers(guildId) {
    return this.getGuildSettings(guildId).members;
  }

  async setMemberSetting(guildId, userId, key, value) {
    if (!MEMBER_KEYS.includes(key)) throw new Error(`Unknown member setting "${key}".`);
    if (!isSnowflake(guildId)) throw new Error('That does not look like a server ID.');
    if (!isSnowflake(String(userId ?? ''))) throw new Error('That does not look like a user ID.');

    const guild = this.getGuildSettings(guildId);
    const member = normalizeMember(guild.members[userId]);

    if (key === 'antiServerMute' || key === 'antiServerDeafen') {
      if (value !== null && typeof value !== 'boolean') {
        throw new Error('That protection must be on, off or inherit.');
      }
      member[key] = value;
    } else {
      if (typeof value !== 'boolean') throw new Error('That force rule must be on or off.');
      member[key] = value;
    }

    guild.members[userId] = member;
    this.data.guilds[guildId] = guild;
    await this.save();
    this.emit('status');
    return member;
  }

  async addManagedMember(guildId, userId) {
    if (!isSnowflake(guildId)) throw new Error('That does not look like a server ID.');
    if (!isSnowflake(String(userId ?? ''))) throw new Error('A Discord user ID is 17-20 digits.');

    const guild = this.getGuildSettings(guildId);
    if (!guild.members[userId]) {
      guild.members[userId] = normalizeMember({});
      this.data.guilds[guildId] = guild;
      await this.save();
      this.emit('status');
    }
    return guild.members[userId];
  }

  async removeManagedMember(guildId, userId) {
    const guild = this.getGuildSettings(guildId);
    if (guild.members[userId]) {
      delete guild.members[userId];
      this.data.guilds[guildId] = guild;
      await this.save();
      this.emit('status');
    }
    return guild;
  }

  /**
   * What actually applies to a member right now: personal override, otherwise
   * the server-wide switch. A forced state always wins over anti-protection.
   */
  getEffectiveRules(guildId, userId) {
    const guild = this.getGuildSettings(guildId);
    const member = normalizeMember(guild.members[userId]);
    return {
      ...member,
      effectiveAntiServerMute: member.forceServerMute
        ? false
        : (member.antiServerMute ?? guild.antiServerMute),
      effectiveAntiServerDeafen: member.forceServerDeafen
        ? false
        : (member.antiServerDeafen ?? guild.antiServerDeafen),
    };
  }

  /* ------------------------------------------------------------- allowlist --- */

  getAllowlist() {
    return [...this.data.allowlist];
  }

  async addAllowedUser(userId) {
    if (!isSnowflake(String(userId ?? '').trim())) {
      throw new Error('A Discord user ID is 17-20 digits.');
    }
    const id = String(userId).trim();
    if (!this.data.allowlist.includes(id)) {
      this.data.allowlist.push(id);
      await this.save();
      this.emit('status');
      this.log('info', `Added ${id} to the allowlist.`);
    }
    return this.getAllowlist();
  }

  async removeAllowedUser(userId) {
    const id = String(userId ?? '').trim();
    this.data.allowlist = this.data.allowlist.filter((entry) => entry !== id);
    await this.save();
    this.emit('status');
    this.log('info', `Removed ${id} from the allowlist.`);
    return this.getAllowlist();
  }

  /**
   * When the allowlist has entries, only those users may use the commands.
   * When it is empty, anyone with Manage Server may.
   */
  canUseCommands(memberPermissions, userId) {
    if (this.data.allowlist.length > 0) {
      return this.data.allowlist.includes(userId);
    }
    return Boolean(memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  }

  /* ---------------------------------------------------------------- client --- */

  async start(token = this.token) {
    if (this.starting) throw new Error('Aegis is already starting.');
    if (this.client) return this.getStatus();

    const resolvedToken = String(token ?? '').trim();
    if (!resolvedToken) {
      this.lastError = 'No bot token saved yet.';
      throw new Error(this.lastError);
    }

    this.starting = true;
    this.lastError = null;
    this.token = resolvedToken;
    this.wantRunning = true;
    this.unreadySince = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      this.restartAt = null;
    }

    const makeClient = (intents) => {
      const next = new Client({
        intents,
        partials: [
          Partials.Channel,
          Partials.GuildMember,
          Partials.Message,
          Partials.User,
          Partials.Reaction,
        ],
      });
      this.wire(next);
      return next;
    };

    const baseIntents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildModeration,
    ];
    const attempts = [
      {
        intents: [...baseIntents, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
        warning: null,
      },
      {
        intents: [...baseIntents, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
        warning:
          'Server Members intent is disabled in the Discord Developer Portal, so Add all members may not work. Message capture is still on.',
      },
      {
        intents: [...baseIntents, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
        warning:
          'Message Content intent is disabled in the Discord Developer Portal. Message text will be hidden, but Add all members still works.',
      },
      {
        intents: [...baseIntents, GatewayIntentBits.GuildMessages],
        warning:
          'Message Content and Server Members intents are disabled in the Discord Developer Portal. Message text and Add all members will be limited until you enable them.',
      },
    ];

    let loginError = null;
    let loggedIn = false;
    let enabledWithWarning = false;

    for (const attempt of attempts) {
      const candidate = makeClient(attempt.intents);
      this.client = candidate;

      try {
        await candidate.login(resolvedToken);
        loggedIn = true;
        this.messageContentEnabled = attempt.intents.includes(GatewayIntentBits.MessageContent);
        this.serverMembersEnabled = attempt.intents.includes(GatewayIntentBits.GuildMembers);
        if (attempt.warning) {
          enabledWithWarning = true;
          this.log('warn', attempt.warning);
        }
        break;
      } catch (error) {
        loginError = error;
        try {
          candidate.destroy();
        } catch {
          // already gone
        }

        // A bad token will not be fixed by removing intents.
        if (!/disallowed|4014|privileged/i.test(String(error?.message ?? ''))) break;
      }
    }

    if (!loggedIn) {
      this.lastError =
        loginError?.code === 'TokenInvalid'
          ? 'Discord rejected that bot token. Check it in Settings.'
          : `Could not log in: ${loginError?.message ?? 'unknown error'}`;
      this.log('error', this.lastError);
      this.client = null;
      this.starting = false;
      throw new Error(this.lastError);
    }

    if (!enabledWithWarning) {
      this.log('info', 'Discord connected with Message Content and Server Members intents.');
    }

    this.features.attach(this, this.client);

    this.starting = false;
    this.startedAt = Date.now();
    this.restartAt = null;
    return this.getStatus();
  }

  async stop() {
    this.wantRunning = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartAt = null;
    this.restartAttempts = 0;
    this.unreadySince = null;
    await this.features.detach();
    const client = this.client;
    this.client = null;
    this.startedAt = null;
    this.starting = false;
    if (this.saveMessagesTimer) {
      clearTimeout(this.saveMessagesTimer);
      this.saveMessagesTimer = null;
      await this.saveMessages().catch(() => {});
    }
    if (!client) return this.getStatus();
    try {
      client.destroy();
    } catch (error) {
      this.log('warn', `Shutdown warning: ${error.message}`);
    }
    this.log('info', 'Aegis stopped.');
    this.emit('status');
    return this.getStatus();
  }

  wire(client) {
    client.once(Events.ClientReady, async (readyClient) => {
      this.startedAt = Date.now();
      this.log('info', `Logged in as ${readyClient.user.tag} (${readyClient.user.id}).`);
      this.log('info', `Serving ${readyClient.guilds.cache.size} server(s).`);

      let changed = false;
      for (const guild of readyClient.guilds.cache.values()) {
        if (this.data.guildNames[guild.id] !== guild.name) {
          this.data.guildNames[guild.id] = guild.name;
          changed = true;
        }
      }
      if (changed) await this.save().catch(() => {});
      this.emit('status');

      // Only forget the failure count once this connection has stayed up.
      setTimeout(() => {
        if (this.client === readyClient || (this.client && this.client.isReady())) {
          this.restartAttempts = 0;
          this.restartAt = null;
        }
      }, 30_000).unref?.();

      // Re-apply forced states to anyone already sitting in voice.
      for (const guild of readyClient.guilds.cache.values()) {
        for (const state of guild.voiceStates.cache.values()) {
          if (!state.member || state.member.user.bot) continue;
          try {
            await this.enforceMember(guild, state.member.id, { silent: true });
          } catch (error) {
            this.log('warn', `Could not restore forced state: ${error.message}`);
          }
        }
      }
    });

    client.on(Events.GuildCreate, () => this.emit('status'));
    client.on(Events.GuildDelete, () => this.emit('status'));
    client.on(Events.Error, (error) => {
      this.lastClientError = error;
      this.log('error', `Discord client error: ${error.message}`);
    });
    client.on(Events.Warn, (message) => this.log('warn', message));
    client.on(Events.ShardError, (error) => {
      this.lastClientError = error;
      this.log('warn', `Gateway error: ${error?.message || error}`);
    });
    client.on(Events.ShardDisconnect, (event) => {
      const code = Number(event?.code ?? 0);
      this.log('warn', `Discord gateway closed (code ${code || 'unknown'}).`);
      if (this.client === client && FATAL_GATEWAY_CODES.has(code)) {
        this.fatal('gateway-closed', new Error(`Discord closed the gateway (code ${code}).`), { code });
      }
    });
    client.on(Events.Invalidated, () => {
      if (this.client === client) {
        this.fatal('session-invalidated', new Error('Discord invalidated the session, so a fresh login is needed.'));
      }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const command = commandsByName.get(interaction.commandName);
      if (!command) return;

      try {
        if (!this.canUseCommands(interaction.memberPermissions, interaction.user.id)) {
          await interaction.reply({
            content:
              "You're not on Aegis's control list, so you can't use that command. Ask the owner to add your Discord ID in the dashboard.",
            ephemeral: true,
          });
          return;
        }
        await command.execute(interaction, { bot: this, features: this.features });
      } catch (error) {
        this.log('error', `/${interaction.commandName} failed: ${error.message}`);
        const payload = {
          content: `Something went wrong: ${error.message}`,
          ephemeral: true,
        };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload).catch(() => {});
        } else {
          await interaction.reply(payload).catch(() => {});
        }
      }
    });

    client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
      try {
        await this.handleVoiceState(newState);
      } catch (error) {
        this.log('error', `Voice state handling failed: ${error.message}`);
      }
    });

    client.on(Events.MessageCreate, (message) => {
      try {
        this.recordMessage(message);
      } catch (error) {
        this.log('warn', `Could not record a message: ${error.message}`);
      }
    });
  }

  recordMessage(message) {
    if (!message?.guild || !message?.channel) return;
    const text = String(message.content ?? '').trim();
    const attachments = message.attachments;
    const embeds = message.embeds ?? [];
    const stickers = message.stickers;
    let fallback = '';

    if (!text) {
      if (embeds.length) {
        const embed = embeds[0];
        fallback = `[Embed] ${embed.title ?? embed.description ?? embed.url ?? 'embedded content'}`;
      } else if (attachments?.size) {
        fallback = `[Attachment] ${[...attachments.values()]
          .map((attachment) => attachment.name)
          .join(', ')}`;
      } else if (stickers?.size) {
        fallback = `[Sticker] ${[...stickers.values()].map((sticker) => sticker.name).join(', ')}`;
      } else if (message.poll) {
        fallback = `[Poll] ${message.poll.question?.text ?? 'poll'}`;
      } else if (message.system) {
        fallback = `[System message: ${message.type}]`;
      }
    }

    const entry = {
      id: message.id,
      guildId: message.guild.id,
      guildName: message.guild.name,
      channelId: message.channel.id,
      channelName: message.channel.name ?? 'unknown-channel',
      authorId: message.author?.id ?? null,
      authorName: message.author?.username ?? 'unknown',
      bot: Boolean(message.author?.bot),
      content: (text || fallback).slice(0, 2000),
      contentHidden: !text && !fallback && this.messageContentEnabled === false,
      attachments: attachments?.size ?? 0,
      createdAt: message.createdTimestamp || Date.now(),
    };
    this.messages.push(entry);
    if (this.messages.length > 2000) this.messages.splice(0, this.messages.length - 2000);
    this.emit('message', entry);
    this.scheduleSaveMessages();
  }

  async addAllMembers(guildId) {
    if (!this.client?.isReady()) throw new Error('Start Aegis before adding server members.');
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('That server is not available to the bot.');
    try {
      await guild.members.fetch({ force: true, time: 120_000 });
    } catch (error) {
      throw new Error(
        `Discord would not let Aegis fetch the member list. Enable the Server Members intent in the Discord Developer Portal, then restart Aegis. (${error.message})`,
      );
    }

    const members = [...guild.members.cache.values()].filter((member) => !member.user?.bot);
    if (!members.length) {
      throw new Error('Discord returned no members for that server. Try again in a moment.');
    }

    const settings = this.getGuildSettings(guildId);
    let added = 0;
    for (const member of members) {
      const existing = settings.members[member.id];
      const profile = {
        displayName: member.displayName ?? null,
        username: member.user?.username ?? null,
        avatar: member.displayAvatarURL?.({ extension: 'png', size: 64 }) ?? null,
      };
      if (!existing) added += 1;
      settings.members[member.id] = { ...normalizeMember(existing), ...profile };
    }
    this.data.guilds[guildId] = settings;
    await this.save();
    this.emit('status');
    this.log('info', `Added ${added} member(s) from ${guild.name} to the managed list.`);
    return { added, total: members.length, status: this.getStatus() };
  }

  /**
   * What Aegis wants this member's server mute/deafen to be:
   * true (hold it on), false (remove it) or null (leave it alone).
   */
  desiredVoice(guildId, userId) {
    const rules = this.getEffectiveRules(guildId, userId);
    return {
      mute: rules.forceServerMute ? true : rules.effectiveAntiServerMute ? false : null,
      deafen: rules.forceServerDeafen ? true : rules.effectiveAntiServerDeafen ? false : null,
    };
  }

  async handleVoiceState(newState) {
    const guild = newState.guild;
    const member = newState.member;
    if (!guild || !member || member.user.bot) return;
    if (!newState.channelId) return;

    const desired = this.desiredVoice(guild.id, member.id);
    if (desired.mute !== null && desired.mute !== newState.serverMute) {
      await this.applyVoice(member, 'mute', desired.mute);
    }
    if (desired.deafen !== null && desired.deafen !== newState.serverDeaf) {
      await this.applyVoice(member, 'deafen', desired.deafen);
    }
  }

  /**
   * Applies a server mute/deafen change without an audit-log reason and without
   * writing to the activity feed. A short per-member cooldown plus a follow-up
   * re-check makes sure a moderator's undo cannot slip through unnoticed.
   */
  async applyVoice(member, kind, value, { verify = false } = {}) {
    const guild = member.guild;
    const permission =
      kind === 'mute' ? PermissionFlagsBits.MuteMembers : PermissionFlagsBits.DeafenMembers;
    const permissionName = kind === 'mute' ? 'Mute Members' : 'Deafen Members';
    const warnKey = `${guild.id}:${kind}`;

    if (!guild.members.me?.permissions.has(permission)) {
      if (!this.warned.has(warnKey)) {
        this.warned.add(warnKey);
        this.log(
          'warn',
          `[${guild.name}] Missing the "${permissionName}" permission, so ${kind} rules are paused there.`,
        );
      }
      return false;
    }

    const rateKey = `${guild.id}:${member.id}:${kind}`;
    const now = Date.now();
    if (now - (this.handled.get(rateKey) ?? 0) < 400) {
      this.scheduleRecheck(guild.id, member.id);
      return false;
    }
    this.handled.set(rateKey, now);

    try {
      if (kind === 'mute') await member.voice.setMute(value);
      else await member.voice.setDeaf(value);
      if (!verify) this.scheduleRecheck(guild.id, member.id);
      return true;
    } catch (error) {
      this.log(
        'warn',
        `[${guild.name}] Could not update server ${kind} for ${member.user.tag}: ${error.message}`,
      );
      return false;
    }
  }

  scheduleRecheck(guildId, userId, delay = 1200) {
    const key = `${guildId}:${userId}`;
    if (this.rechecks.has(key)) return;

    const timer = setTimeout(async () => {
      this.rechecks.delete(key);
      try {
        const guild = this.client?.guilds.cache.get(guildId);
        const state = guild?.voiceStates.cache.get(userId);
        if (!guild || !state || !state.channelId || !state.member) return;

        const desired = this.desiredVoice(guildId, userId);
        if (desired.mute !== null && desired.mute !== state.serverMute) {
          this.handled.delete(`${guildId}:${userId}:mute`);
          await this.applyVoice(state.member, 'mute', desired.mute, { verify: true });
        }
        if (desired.deafen !== null && desired.deafen !== state.serverDeaf) {
          this.handled.delete(`${guildId}:${userId}:deafen`);
          await this.applyVoice(state.member, 'deafen', desired.deafen, { verify: true });
        }
      } catch (error) {
        this.log('warn', `Voice re-check failed: ${error.message}`);
      }
    }, delay);

    timer.unref?.();
    this.rechecks.set(key, timer);
  }

  /** Apply any forced state to a member immediately (used when a rule is enabled). */
  async enforceMember(guild, userId, { silent = false } = {}) {
    const rules = this.getMemberSettings(guild.id, userId);
    if (!rules.forceServerMute && !rules.forceServerDeafen) return false;

    let member = guild.members.cache.get(userId);
    if (!member) member = await guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot || !member.voice?.channelId) return false;

    let applied = false;
    if (rules.forceServerMute && !member.voice.serverMute) {
      applied = (await this.applyVoice(member, 'mute', true, { verify: true })) || applied;
    }
    if (rules.forceServerDeafen && !member.voice.serverDeaf) {
      applied = (await this.applyVoice(member, 'deafen', true, { verify: true })) || applied;
    }
    if (!silent && !applied) {
      this.log('info', `Forced state saved for ${userId}; it applies the next time they join voice.`);
    }
    return applied;
  }

  /* ---------------------------------------------------------------- deploy --- */

  async deployCommands({ token = this.token, guildId = '' } = {}) {
    const resolvedToken = String(token ?? '').trim();
    if (!resolvedToken) throw new Error('Save a bot token first.');

    const rest = new REST({ version: '10' }).setToken(resolvedToken);
    const application = await rest.get(Routes.currentApplication());
    const scopedGuild = String(guildId ?? '').trim();
    if (scopedGuild && !isSnowflake(scopedGuild)) {
      throw new Error('The server ID should be 17-20 digits.');
    }

    const route = scopedGuild
      ? Routes.applicationGuildCommands(application.id, scopedGuild)
      : Routes.applicationCommands(application.id);

    // Register each name once: Discord rejects a payload with two identical
    // names, and we would rather drop the later duplicate than fail the deploy.
    const body = [];
    const seen = new Set();
    for (const command of commands) {
      if (seen.has(command.data.name)) continue;
      seen.add(command.data.name);
      body.push(command.data.toJSON());
    }

    const names = new Set(body.map((command) => command.name));
    const guildIds = scopedGuild
      ? []
      : this.client?.isReady?.()
        ? [...this.client.guilds.cache.keys()]
        : ((await rest.get(Routes.userGuilds()).catch(() => [])) ?? []).map((guild) => guild.id);
    const removed = await clearCommandCopies({
      rest,
      applicationId: application.id,
      names,
      guildId: scopedGuild,
      guildIds,
    });

    const data = await rest.put(route, { body });
    this.log(
      'info',
      `Registered ${data.length} slash command(s) ${scopedGuild ? 'in the server' : 'globally'}.${
        removed.length ? ` Removed ${removed.length} duplicate(s).` : ''
      }`,
    );
    return {
      count: data.length,
      scope: scopedGuild ? 'guild' : 'global',
      names: data.map((command) => command.name),
      removed,
    };
  }

  /* ----------------------------------------------------------------- roles --- */

  /** The live guild for a role request, or an error the panel can show. */
  requireGuild(guildId) {
    if (!this.client?.isReady?.()) throw new Error('Start Aegis before managing roles.');
    const guild = this.client.guilds.cache.get(String(guildId ?? '').trim());
    if (!guild) throw new Error('Aegis is not in that server.');
    return guild;
  }

  roleView(guild, role, me) {
    const everyone = role.id === guild.id;
    const canManage =
      !everyone &&
      !role.managed &&
      Boolean(me?.permissions?.has(PermissionFlagsBits.ManageRoles)) &&
      Boolean(me && role.position < me.roles.highest.position);
    return {
      id: role.id,
      name: role.name,
      color: role.color,
      hex: `#${Number(role.color ?? 0).toString(16).padStart(6, '0')}`,
      position: role.position,
      hoist: Boolean(role.hoist),
      mentionable: Boolean(role.mentionable),
      managed: Boolean(role.managed),
      isEveryone: everyone,
      memberCount: role.members?.size ?? 0,
      canManage,
    };
  }

  listRoles(guildId) {
    const guild = this.requireGuild(guildId);
    const me = guild.members.me;
    const roles = [...guild.roles.cache.values()]
      .sort((a, b) => b.position - a.position)
      .map((role) => this.roleView(guild, role, me));
    return {
      guildId: guild.id,
      guildName: guild.name,
      canManageRoles: Boolean(me?.permissions?.has(PermissionFlagsBits.ManageRoles)),
      roles,
    };
  }

  async createRole(guildId, input = {}) {
    const guild = this.requireGuild(guildId);
    const me = guild.members.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('Aegis needs the Manage Roles permission to create roles.');
    }
    const name = String(input.name ?? '').trim().slice(0, 100);
    if (!name) throw new Error('Give the role a name.');

    const role = await guild.roles.create({
      name,
      color: roleColor(input.color) ?? undefined,
      hoist: Boolean(input.hoist),
      mentionable: Boolean(input.mentionable),
      reason: `Created from the Aegis panel by ${input.by ?? 'the dashboard'}`,
    });
    this.log('info', `[${guild.name}] Created role ${role.name}.`);
    this.emit('status');
    return this.listRoles(guild.id);
  }

  async updateRole(guildId, roleId, input = {}) {
    const guild = this.requireGuild(guildId);
    const me = guild.members.me;
    const role = guild.roles.cache.get(String(roleId ?? ''));
    if (!role) throw new Error('That role no longer exists.');
    if (role.id === guild.id) throw new Error('The @everyone role cannot be edited.');
    if (role.managed) throw new Error('That role is managed by an integration and cannot be edited.');
    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('Aegis needs the Manage Roles permission to edit roles.');
    }
    if (role.position >= me.roles.highest.position) {
      throw new Error("That role sits at or above Aegis's highest role. Move Aegis's role higher first.");
    }

    const patch = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim().slice(0, 100);
      if (!name) throw new Error('Give the role a name.');
      patch.name = name;
    }
    const color = roleColor(input.color);
    if (color !== null) patch.color = color;
    if (input.hoist !== undefined) patch.hoist = Boolean(input.hoist);
    if (input.mentionable !== undefined) patch.mentionable = Boolean(input.mentionable);
    if (!Object.keys(patch).length) throw new Error('Nothing to change.');

    await role.edit(patch, `Edited from the Aegis panel by ${input.by ?? 'the dashboard'}`);
    this.log('info', `[${guild.name}] Updated role ${role.name}.`);
    this.emit('status');
    return this.listRoles(guild.id);
  }

  async deleteRole(guildId, roleId, { by = 'the dashboard' } = {}) {
    const guild = this.requireGuild(guildId);
    const me = guild.members.me;
    const role = guild.roles.cache.get(String(roleId ?? ''));
    if (!role) throw new Error('That role no longer exists.');
    if (role.id === guild.id) throw new Error('The @everyone role cannot be deleted.');
    if (role.managed) throw new Error('That role is managed by an integration and cannot be deleted.');
    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('Aegis needs the Manage Roles permission to delete roles.');
    }
    if (role.position >= me.roles.highest.position) {
      throw new Error("That role sits at or above Aegis's highest role. Move Aegis's role higher first.");
    }

    await role.delete(`Deleted from the Aegis panel by ${by}`);
    this.log('info', `[${guild.name}] Deleted role ${role.name}.`);
    this.emit('status');
    return this.listRoles(guild.id);
  }

  async moveRole(guildId, roleId, direction, { by = 'the dashboard' } = {}) {
    const guild = this.requireGuild(guildId);
    const me = guild.members.me;
    const role = guild.roles.cache.get(String(roleId ?? ''));
    if (!role) throw new Error('That role no longer exists.');
    if (role.id === guild.id) throw new Error('The @everyone role cannot be moved.');
    if (!['up', 'down'].includes(direction)) throw new Error('Move a role up or down.');
    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('Aegis needs the Manage Roles permission to move roles.');
    }
    if (role.position >= me.roles.highest.position) {
      throw new Error("That role sits at or above Aegis's highest role. Move Aegis's role higher first.");
    }

    const ordered = [...guild.roles.cache.values()]
      .filter((entry) => entry.id !== guild.id)
      .sort((a, b) => b.position - a.position);
    const index = ordered.findIndex((entry) => entry.id === role.id);
    const neighbour = direction === 'up' ? ordered[index - 1] : ordered[index + 1];
    if (!neighbour) {
      throw new Error(`That role is already at the ${direction === 'up' ? 'top' : 'bottom'}.`);
    }

    await role.setPosition(neighbour.position, { reason: `Moved from the Aegis panel by ${by}` });
    this.log('info', `[${guild.name}] Moved role ${role.name} ${direction}.`);
    this.emit('status');
    return this.listRoles(guild.id);
  }

  /* ---------------------------------------------------------------- status --- */

  describeGuild(guildLike, live) {
    const settings = this.getGuildSettings(guildLike.id);
    const me = live ? guildLike.members.me : null;
    const memberEntries = Object.entries(settings.members).map(([id, member]) => {
      const liveMember = live ? guildLike.members.cache.get(id) : null;
      return {
        id,
        ...member,
        displayName: liveMember?.displayName ?? member.displayName ?? null,
        username: liveMember?.user?.username ?? member.username ?? null,
        avatar:
          liveMember?.displayAvatarURL?.({ extension: 'png', size: 64 }) ?? member.avatar ?? null,
      };
    });

    return {
      id: guildLike.id,
      name: guildLike.name,
      memberCount: live ? (guildLike.memberCount ?? null) : null,
      icon: live ? guildLike.iconURL({ extension: 'png', size: 64 }) : null,
      antiServerMute: settings.antiServerMute,
      antiServerDeafen: settings.antiServerDeafen,
      canMute: live ? Boolean(me?.permissions.has(PermissionFlagsBits.MuteMembers)) : null,
      canDeafen: live ? Boolean(me?.permissions.has(PermissionFlagsBits.DeafenMembers)) : null,
      canManageRoles: live ? Boolean(me?.permissions.has(PermissionFlagsBits.ManageRoles)) : null,
      members: memberEntries,
    };
  }

  getStatus() {
    const client = this.client;
    const ready = Boolean(client?.isReady());

    const guilds = ready
      ? client.guilds.cache
          .map((guild) => this.describeGuild(guild, true))
          .sort((a, b) => a.name.localeCompare(b.name))
      : Object.entries(this.data.guildNames)
          .map(([id, name]) => this.describeGuild({ id, name }, false))
          .sort((a, b) => a.name.localeCompare(b.name));

    return {
      running: ready,
      starting: this.starting,
      tag: ready ? client.user.tag : null,
      id: ready ? client.user.id : null,
      avatar: ready ? client.user.displayAvatarURL({ extension: 'png', size: 128 }) : null,
      guilds,
      allowlist: this.getAllowlist(),
      uptimeMs: ready && this.startedAt ? Date.now() - this.startedAt : 0,
      lastError: this.lastError,
      hasToken: Boolean(this.token),
      messageContentEnabled: this.messageContentEnabled,
      serverMembersEnabled: this.serverMembersEnabled,
      supervising: this.wantRunning,
      restartAt: this.restartAt,
      restartAttempts: this.restartAttempts,
      crashCount: this.crashes.length,
      crashes: this.getCrashes().slice(0, 10),
    };
  }

  /* --------------------------------------------------------------- console --- */

  async runConsole(input) {
    const trimmed = String(input ?? '').trim();
    if (!trimmed) return '';
    const [rawCommand, ...rest] = trimmed.split(/\s+/);
    const command = rawCommand.toLowerCase();

    switch (command) {
      case 'help':
        return HELP_TEXT;

      case 'status': {
        const status = this.getStatus();
        if (!status.running) {
          return status.starting
            ? 'Aegis is starting…'
            : 'Aegis is offline. Start it from the Overview page.';
        }
        const switches = status.guilds.reduce(
          (total, guild) =>
            total +
            (guild.antiServerMute ? 1 : 0) +
            (guild.antiServerDeafen ? 1 : 0) +
            guild.members.reduce(
              (count, member) =>
                count +
                (member.antiServerMute === true ? 1 : 0) +
                (member.antiServerDeafen === true ? 1 : 0) +
                (member.forceServerMute ? 1 : 0) +
                (member.forceServerDeafen ? 1 : 0),
              0,
            ),
          0,
        );
        return [
          `Aegis is online as ${status.tag}`,
          `Servers: ${status.guilds.length}`,
          `Rules active: ${switches}`,
          `Allowlisted users: ${status.allowlist.length}`,
        ].join('\n');
      }

      case 'guilds': {
        const status = this.getStatus();
        if (status.guilds.length === 0) return 'No servers known yet. Start Aegis and invite it first.';
        return status.guilds
          .map(
            (guild) =>
              `${guild.name}  (${guild.id})\n  anti-mute: ${guild.antiServerMute ? 'on' : 'off'}   anti-deafen: ${
                guild.antiServerDeafen ? 'on' : 'off'
              }   managed members: ${guild.members.length}`,
          )
          .join('\n');
      }

      case 'members': {
        const [guildId] = rest;
        if (!guildId) return 'Usage: members <guildId>';
        const members = this.getGuildSettings(guildId).members;
        const entries = Object.entries(members);
        if (entries.length === 0) return 'No managed members in that server.';
        return entries
          .map(([userId, member]) => {
            const rules = this.getEffectiveRules(guildId, userId);
            return [
              `${userId}`,
              `  anti-mute: ${member.antiServerMute === null ? 'inherit' : member.antiServerMute ? 'on' : 'off'} (effective ${rules.effectiveAntiServerMute ? 'on' : 'off'})`,
              `  anti-deafen: ${member.antiServerDeafen === null ? 'inherit' : member.antiServerDeafen ? 'on' : 'off'} (effective ${rules.effectiveAntiServerDeafen ? 'on' : 'off'})`,
              `  force-mute: ${member.forceServerMute ? 'on' : 'off'}   force-deafen: ${member.forceServerDeafen ? 'on' : 'off'}`,
            ].join('\n');
          })
          .join('\n');
      }

      case 'antimute':
      case 'antideafen': {
        const [guildId, state] = rest;
        const key = command === 'antimute' ? 'antiServerMute' : 'antiServerDeafen';
        if (!guildId || !['on', 'off'].includes((state ?? '').toLowerCase())) {
          return `Usage: ${command} <guildId> on|off`;
        }
        const settings = await this.setGuildSetting(guildId, key, state.toLowerCase() === 'on');
        return `${command} for ${guildId} is now ${settings[key] ? 'on' : 'off'}.`;
      }

      case 'protect': {
        const [guildId, userId, kindRaw, stateRaw] = rest;
        const kind = (kindRaw ?? '').toLowerCase();
        const state = (stateRaw ?? '').toLowerCase();
        if (!guildId || !userId || !['mute', 'deafen'].includes(kind) || !['on', 'off', 'clear'].includes(state)) {
          return 'Usage: protect <guildId> <userId> mute|deafen on|off|clear';
        }
        const key = kind === 'mute' ? 'antiServerMute' : 'antiServerDeafen';
        const value = state === 'clear' ? null : state === 'on';
        const member = await this.setMemberSetting(guildId, userId, key, value);
        return `${kind} protection for ${userId}: ${
          member[key] === null ? 'inherit server setting' : member[key] ? 'on' : 'off'
        }.`;
      }

      case 'force': {
        const [guildId, userId, kindRaw, stateRaw] = rest;
        const kind = (kindRaw ?? '').toLowerCase();
        const state = (stateRaw ?? '').toLowerCase();
        if (!guildId || !userId || !['mute', 'deafen'].includes(kind) || !['on', 'off'].includes(state)) {
          return 'Usage: force <guildId> <userId> mute|deafen on|off';
        }
        const key = kind === 'mute' ? 'forceServerMute' : 'forceServerDeafen';
        const member = await this.setMemberSetting(guildId, userId, key, state === 'on');
        if (member[key] && this.client) {
          const guild = this.client.guilds.cache.get(guildId);
          if (guild) await this.enforceMember(guild, userId, { silent: true });
        }
        return `Forced server ${kind} for ${userId}: ${member[key] ? 'on' : 'off'}.`;
      }

      case 'allowlist': {
        const [action, userId] = rest;
        if (!action) {
          const list = this.getAllowlist();
          return list.length === 0
            ? 'Allowlist is empty: server managers can use the commands.'
            : list.join('\n');
        }
        if (action === 'add') {
          const list = await this.addAllowedUser(userId);
          return `Added ${userId}. Allowlist now has ${list.length} user(s).`;
        }
        if (action === 'remove') {
          const list = await this.removeAllowedUser(userId);
          return `Removed ${userId}. Allowlist now has ${list.length} user(s).`;
        }
        return 'Usage: allowlist [add|remove] <userId>';
      }

      case 'say': {
        const [channelId, ...words] = rest;
        const message = words.join(' ');
        if (!channelId || !message) return 'Usage: say <channelId> <message>';
        if (!this.client?.isReady()) return 'Start Aegis before sending messages.';
        const channel = this.client.channels.cache.get(channelId);
        if (!channel?.isTextBased?.()) return `No text channel found with ID ${channelId}.`;
        await channel.send(message);
        return `Sent to #${channel.name ?? channelId}.`;
      }

      default:
        return `Unknown command "${command}". Type "help" for the list.`;
    }
  }
}
