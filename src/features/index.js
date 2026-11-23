import { Events } from 'discord.js';
import path from 'node:path';
import { JsonStore } from './store.js';
import { registerLogging } from './logging.js';
import { handleReactionRoleComponent } from './reaction-roles.js';
import { handleTicketComponent, trackTicketMessage } from './tickets.js';
import { handleGiveawayComponent, sweepGiveaways } from './giveaways.js';
import { handleTempVoiceComponent, handleTempVoiceState, resumeTempVoice } from './temp-voice.js';
import { handleBackupComponent } from './backup.js';
import {
  registerStaffTracking,
  sweepStaff,
  trackStaffMessage,
  trackStaffVoice,
} from './staff.js';
import { recordMemberActivity, recordMessageActivity, scanGuild } from './intel.js';
import { handleAiComponent, sweepAiReports } from './ai.js';
import { handleCopilotComponent } from './copilot.js';
import { handleEventComponent, sweepEvents } from './events.js';
import { handleEconomyComponent, recordEconomyMessage, trackEconomyVoice } from './economy.js';
import { quarantineNewMember } from './panic.js';
import { registerNukeGuard } from './nuke.js';
import { sweepStats } from './stats.js';

function isComponent(interaction) {
  return (
    interaction.isButton?.() ||
    interaction.isAnySelectMenu?.() ||
    interaction.isModalSubmit?.()
  );
}

/**
 * Owns every optional community feature. The bot only needs to hand it the
 * client; storage, listeners, timers and component routing live here.
 */
export class FeatureManager {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.store = new JsonStore(path.join(dataDir, 'features.json'));
    this.bot = null;
    this.client = null;
    this.timers = [];
    this.voiceSessions = new Map();
    this.tempTimers = new Map();
    this.pendingAnnouncements = new Map();
    this.recovering = false;
  }

  async init() {
    await this.store.load();
    return this;
  }

  attach(bot, client) {
    this.bot = bot;
    this.client = client;
    this.register(client);

    const ready = () => this.onReady().catch((error) => this.bot?.log('warn', `Feature startup: ${error.message}`));
    if (client.isReady()) ready();
    else client.once(Events.ClientReady, ready);

    // Giveaways need a short tick so they end close to their deadline.
    this.addTimer(setInterval(() => this.sweepGiveaways().catch(() => {}), 20_000));
    this.addTimer(setInterval(() => this.sweepEvents().catch(() => {}), 30_000));
    this.addTimer(setInterval(() => this.sweepStats().catch(() => {}), 10 * 60_000));
    this.addTimer(setInterval(() => this.sweepSlow().catch(() => {}), 5 * 60_000));
  }

  async detach() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const timer of this.tempTimers.values()) clearTimeout(timer);
    this.tempTimers.clear();
    this.voiceSessions.clear();
    await this.store.flush().catch(() => {});
    this.client = null;
    this.bot = null;
  }

  addTimer(timer) {
    timer.unref?.();
    this.timers.push(timer);
  }

  register(client) {
    registerLogging(this, client);
    registerStaffTracking(this, client);
    registerNukeGuard(this, client);

    client.on(Events.MessageCreate, (message) => {
      try {
        recordMessageActivity(this, message);
        trackStaffMessage(this, message);
        trackTicketMessage(this, message);
        recordEconomyMessage(this, message);
      } catch (error) {
        this.bot?.log('warn', `Feature message tracking failed: ${error.message}`);
      }
    });

    client.on(Events.GuildMemberAdd, (member) => {
      try {
        recordMemberActivity(this, member.guild.id, 'join', member);
        quarantineNewMember(this, member).catch(() => {});
      } catch (error) {
        this.bot?.log('warn', `Join tracking failed: ${error.message}`);
      }
    });

    client.on(Events.GuildMemberRemove, (member) => {
      try {
        recordMemberActivity(this, member.guild.id, 'leave', member);
      } catch (error) {
        this.bot?.log('warn', `Leave tracking failed: ${error.message}`);
      }
    });

    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      try {
        trackStaffVoice(this, oldState, newState);
        trackEconomyVoice(this, oldState, newState);
      } catch {
        // Voice stats are best-effort.
      }
      handleTempVoiceState(this, oldState, newState).catch((error) => {
        this.bot?.log('warn', `Temporary voice handling failed: ${error.message}`);
      });
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!isComponent(interaction)) return;
      try {
        const handled =
          (await handleReactionRoleComponent(this, interaction)) ||
          (await handleTicketComponent(this, interaction)) ||
          (await handleGiveawayComponent(this, interaction)) ||
          (await handleTempVoiceComponent(this, interaction)) ||
          (await handleBackupComponent(this, interaction)) ||
          (await handleAiComponent(this, interaction)) ||
          (await handleEconomyComponent(this, interaction)) ||
          (await handleEventComponent(this, interaction)) ||
          (await handleCopilotComponent(this, interaction));
        if (!handled) {
          await interaction.reply({ content: 'That control is no longer in use.', flags: 64 }).catch(() => {});
        }
      } catch (error) {
        this.bot?.log('error', `Interaction ${interaction.customId} failed: ${error.message}`);
        const payload = { content: `Something went wrong: ${error.message}`, flags: 64 };
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
        else await interaction.reply(payload).catch(() => {});
      }
    });
  }

  async onReady() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await resumeTempVoice(this);
      this.bot?.log('info', 'Community features ready: tickets, roles, giveaways, voice, backups, intel, matchmaking, AI, panic, anti-nuke, doctor, economy, events, stats, copilot.');
    } finally {
      this.recovering = false;
    }
  }

  async sweepGiveaways() {
    if (!this.client) return;
    await sweepGiveaways(this);
  }

  async sweepEvents() {
    if (!this.client) return;
    await sweepEvents(this);
  }

  async sweepStats() {
    if (!this.client) return;
    await sweepStats(this);
  }

  async sweepSlow() {
    if (!this.client) return;
    const now = Date.now();
    for (const guild of this.client.guilds.cache.values()) {
      const intel = this.store.guild(guild.id).intel;
      if (now - (intel.lastScanAt ?? 0) >= 30 * 60_000) {
        await scanGuild(this, guild).catch((error) => {
          this.bot?.log('warn', `Intelligence scan failed: ${error.message}`);
        });
      }
    }
    await sweepStaff(this).catch(() => {});
    await sweepAiReports(this).catch(() => {});
  }
}
