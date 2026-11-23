import { ChannelType } from 'discord.js';
import { aiConfigured } from './ai.js';
import { panicSummary, activatePanic, deactivatePanic, panicState } from './panic.js';
import { guardSummary, guardState } from './nuke.js';
import { doctorSummary, runDoctor, applyDoctorFix } from './doctor.js';
import { economySummary, economyState } from './economy.js';
import { eventSummary, createEvent, cancelEvent } from './events.js';
import { statsSummary, setupStats, disableStats, updateStats } from './stats.js';
import { planRequest, applyPlan } from './copilot.js';
import { randomId } from './util.js';

export const FEATURE_ACTIONS = new Set([
  'panic_on',
  'panic_off',
  'guard_update',
  'doctor_run',
  'doctor_fix',
  'economy_update',
  'shop_save',
  'shop_delete',
  'coins_give',
  'event_create',
  'event_cancel',
  'stats_setup',
  'stats_off',
  'copilot_plan',
  'copilot_apply',
]);

async function resolveGuild(features, guildId) {
  const client = features.client;
  if (!client) throw new Error('Aegis is not connected to Discord.');
  const id = String(guildId ?? '');
  const cached = client.guilds.cache.get(id);
  if (cached) return cached;
  const fetched = await client.guilds.fetch(id).catch(() => null);
  if (!fetched) throw new Error('Aegis is not in that server.');
  return fetched;
}

function yes(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

export function featureSnapshot(features, guild) {
  return {
    guildId: guild.id,
    guildName: guild.name,
    memberCount: guild.memberCount,
    channels: guild.channels.cache
      .filter((channel) => [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory].includes(channel.type))
      .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type }))
      .slice(0, 300),
    roles: guild.roles.cache
      .filter((role) => role.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((role) => ({ id: role.id, name: role.name, managed: role.managed, members: role.members.size }))
      .slice(0, 250),
    panic: panicSummary(features, guild.id),
    guard: guardSummary(features, guild.id),
    doctor: doctorSummary(features, guild.id),
    economy: economySummary(features, guild.id),
    events: eventSummary(features, guild.id),
    stats: statsSummary(features, guild.id),
    ai: aiConfigured(),
    updatedAt: Date.now(),
  };
}

function updateGuard(features, guildId, patch = {}) {
  const config = guardState(features, guildId);
  if (typeof patch.enabled === 'boolean') config.enabled = patch.enabled;
  if (patch.threshold !== undefined) config.threshold = Math.min(20, Math.max(2, Math.round(Number(patch.threshold) || 3)));
  if (patch.windowMs !== undefined) config.windowMs = Math.min(600_000, Math.max(10_000, Math.round(Number(patch.windowMs) || 60_000)));
  if (patch.channelId !== undefined) config.channelId = patch.channelId ? String(patch.channelId) : null;
  if (Array.isArray(patch.trustedRoles)) config.trustedRoles = patch.trustedRoles.map(String).slice(0, 30);
  if (patch.clearIncidents) config.incidents = [];
  features.store.save();
  return guardSummary(features, guildId);
}

function updateEconomy(features, guildId, patch = {}) {
  const config = economyState(features, guildId);
  if (typeof patch.enabled === 'boolean') config.enabled = patch.enabled;
  if (patch.perMessage !== undefined) config.perMessage = Math.min(100, Math.max(0, Math.round(Number(patch.perMessage) || 0)));
  if (patch.perVoiceMinute !== undefined) config.perVoiceMinute = Math.min(100, Math.max(0, Math.round(Number(patch.perVoiceMinute) || 0)));
  if (patch.cooldownSec !== undefined) config.cooldownSec = Math.min(3600, Math.max(0, Math.round(Number(patch.cooldownSec) || 0)));
  if (patch.minLength !== undefined) config.minLength = Math.min(200, Math.max(0, Math.round(Number(patch.minLength) || 0)));
  features.store.save();
  return economySummary(features, guildId);
}

function saveShopItem(features, guild, patch = {}) {
  const config = economyState(features, guild.id);
  config.items ??= {};
  const role = guild.roles.cache.get(String(patch.roleId ?? ''));
  if (!role) throw new Error('Choose a role for that reward.');
  const id = String(patch.itemId ?? '').trim() || randomId(6);
  const existing = config.items[id];
  if (!existing && Object.keys(config.items).length >= 25) throw new Error('The shop is full — remove a reward first.');
  config.items[id] = {
    roleId: role.id,
    name: String(patch.name ?? existing?.name ?? role.name).trim().slice(0, 80) || role.name,
    price: Math.min(1_000_000, Math.max(0, Math.round(Number(patch.price ?? existing?.price ?? 100) || 100))),
    stock: Math.min(10_000, Math.max(0, Math.round(Number(patch.stock ?? existing?.stock ?? 0) || 0))),
    createdBy: existing?.createdBy ?? 'dashboard',
    createdAt: existing?.createdAt ?? Date.now(),
  };
  features.store.save();
  return { id, items: economySummary(features, guild.id).items };
}

export async function runFeatureTask(features, task) {
  const guild = await resolveGuild(features, task.guildId);
  const payload = task.payload ?? {};
  const by = String(payload.by ?? 'dashboard').slice(0, 80);

  switch (task.action) {
    case 'panic_on': {
      const result = await activatePanic(features, guild, {
        by,
        reason: payload.reason ?? '',
        quarantineRoleId: payload.quarantineRoleId ? String(payload.quarantineRoleId) : undefined,
        windowMs: payload.windowMs !== undefined ? Number(payload.windowMs) : undefined,
      });
      return { result, snapshot: featureSnapshot(features, guild) };
    }
    case 'panic_off': {
      const result = await deactivatePanic(features, guild, { by });
      return { result, snapshot: featureSnapshot(features, guild) };
    }
    case 'guard_update':
      return { result: updateGuard(features, guild.id, payload), snapshot: featureSnapshot(features, guild) };
    case 'doctor_run':
      return { result: await runDoctor(features, guild), snapshot: featureSnapshot(features, guild) };
    case 'doctor_fix':
      return { result: await applyDoctorFix(features, guild, String(payload.kind ?? '')), snapshot: featureSnapshot(features, guild) };
    case 'economy_update':
      return { result: updateEconomy(features, guild.id, payload), snapshot: featureSnapshot(features, guild) };
    case 'shop_save':
      return { result: saveShopItem(features, guild, payload), snapshot: featureSnapshot(features, guild) };
    case 'shop_delete': {
      const config = economyState(features, guild.id);
      const id = String(payload.itemId ?? '');
      if (config.items?.[id]) delete config.items[id];
      features.store.save();
      return { result: { id }, snapshot: featureSnapshot(features, guild) };
    }
    case 'coins_give': {
      const config = economyState(features, guild.id);
      const userId = String(payload.userId ?? '');
      if (!/^\d{17,20}$/.test(userId)) throw new Error('Choose a member first.');
      const amount = Math.min(100_000, Math.max(1, Math.round(Number(payload.amount) || 0)));
      config.balances ??= {};
      const entry = config.balances[userId] ?? (config.balances[userId] = { coins: 0, earned: 0, spent: 0, lastEarn: 0 });
      entry.coins += amount;
      entry.earned += amount;
      config.log = [{ at: Date.now(), text: `${by} added ${amount} coins to ${userId}.` }, ...(config.log ?? [])].slice(0, 30);
      features.store.save();
      return { result: { userId, amount, balance: entry.coins }, snapshot: featureSnapshot(features, guild) };
    }
    case 'event_create': {
      const channel = guild.channels.cache.get(String(payload.channelId ?? ''));
      if (!channel?.isTextBased?.()) throw new Error('Choose a text channel for the event.');
      const item = await createEvent(features, guild, channel, {
        title: payload.title,
        description: payload.description ?? '',
        startsIn: payload.startsIn ?? '1h',
        capacity: payload.capacity ?? 0,
        hostId: payload.hostId ?? guild.ownerId,
      });
      return { result: { id: item.id, startsAt: item.startsAt }, snapshot: featureSnapshot(features, guild) };
    }
    case 'event_cancel': {
      const item = await cancelEvent(features, guild, String(payload.eventId ?? ''));
      return { result: { id: item.id }, snapshot: featureSnapshot(features, guild) };
    }
    case 'stats_setup': {
      const made = await setupStats(features, guild, { categoryName: payload.categoryName || '📊 Server Stats' });
      return { result: { categoryId: made.category.id, names: made.names }, snapshot: featureSnapshot(features, guild) };
    }
    case 'stats_off': {
      await disableStats(features, guild);
      return { result: { ok: true }, snapshot: featureSnapshot(features, guild) };
    }
    case 'stats_refresh': {
      const result = await updateStats(features, guild);
      return { result, snapshot: featureSnapshot(features, guild) };
    }
    case 'copilot_plan':
      return { result: await planRequest(features, guild, payload.request), snapshot: featureSnapshot(features, guild) };
    case 'copilot_apply':
      return { result: { steps: await applyPlan(features, guild, payload.plan ?? { steps: [] }) }, snapshot: featureSnapshot(features, guild) };
    case 'panic_status':
      return { result: panicState(features, guild.id), snapshot: featureSnapshot(features, guild) };
    case 'economy_shop':
      return {
        result: { items: economySummary(features, guild.id).items },
        snapshot: featureSnapshot(features, guild),
      };
    default:
      throw new Error(`Unknown feature action "${task.action}".`);
  }
}
