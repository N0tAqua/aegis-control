import {
  AuditLogEvent,
  Events,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, canManageGuild, embed } from './util.js';

const WATCHED = new Map([
  [AuditLogEvent.MemberBanAdd, { key: 'ban', label: 'banned members', emoji: '🔨' }],
  [AuditLogEvent.MemberKick, { key: 'kick', label: 'kicked members', emoji: '👢' }],
  [AuditLogEvent.MemberPrune, { key: 'prune', label: 'pruned members', emoji: '🧹' }],
  [AuditLogEvent.ChannelDelete, { key: 'channel', label: 'deleted channels', emoji: '🗑️' }],
  [AuditLogEvent.RoleDelete, { key: 'role', label: 'deleted roles', emoji: '🏷️' }],
]);

const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ModerateMembers,
];

export function guardState(features, guildId) {
  const config = features.store.guild(guildId);
  config.guard ??= {
    enabled: false,
    threshold: 3,
    windowMs: 60_000,
    channelId: null,
    trustedRoles: [],
    incidents: [],
    lastBreachAt: {},
  };
  return config.guard;
}

export function guardSummary(features, guildId) {
  const config = guardState(features, guildId);
  return {
    enabled: Boolean(config.enabled),
    threshold: config.threshold,
    windowMs: config.windowMs,
    channelId: config.channelId ?? null,
    trustedRoles: config.trustedRoles ?? [],
    incidents: (config.incidents ?? []).slice(0, 12),
  };
}

export function limitConfigured(features, guildId, guild) {
  // Aegis needs to see the audit log and manage roles to punish an actor.
  const me = guild.members.me;
  return Boolean(me?.permissions?.has(PermissionFlagsBits.ViewAuditLog) && me?.permissions?.has(PermissionFlagsBits.ManageRoles));
}

export async function handleAuditEntry(features, entry, guild) {
  const config = guardState(features, guild.id);
  if (!config.enabled) return null;
  const watched = WATCHED.get(entry.action);
  if (!watched) return null;
  const actorId = entry.executorId;
  if (!actorId || actorId === features.client?.user?.id || actorId === guild.ownerId) return null;
  if (config.trustedRoles?.length) {
    const member = guild.members.cache.get(actorId);
    if (member?.roles?.cache?.some((role) => config.trustedRoles.includes(role.id))) return null;
  }

  features.guardHits ??= new Map();
  const key = `${guild.id}:${actorId}:${watched.key}`;
  const now = Date.now();
  const hits = (features.guardHits.get(key) ?? []).filter((at) => now - at < config.windowMs);
  hits.push(now);
  features.guardHits.set(key, hits);
  if (hits.length < config.threshold) return null;

  const lastBreach = Number(config.lastBreachAt?.[actorId] ?? 0);
  if (now - lastBreach < 60_000) return null;
  config.lastBreachAt ??= {};
  config.lastBreachAt[actorId] = now;
  features.guardHits.delete(key);

  return punish(features, guild, config, { actorId, watched, count: hits.length });
}

async function punish(features, guild, config, { actorId, watched, count }) {
  const member = guild.members.cache.get(actorId) ?? (await guild.members.fetch(actorId).catch(() => null));
  const removed = [];
  let note = null;

  if (!member) {
    note = 'The account is no longer in the server.';
  } else if (member.id === guild.ownerId) {
    note = 'Server owners cannot be restricted by Aegis.';
  } else if (!member.manageable) {
    note = 'That member is above Aegis in the role list, so it could not be restricted.';
  } else {
    const targets = member.roles.cache.filter(
      (role) => role.id !== guild.id && DANGEROUS.some((flag) => role.permissions.has(flag)),
    );
    for (const role of targets.values()) {
      const done = await member.roles
        .remove(role.id, `Aegis anti-nuke: ${count} ${watched.label} in one minute`)
        .then(() => true)
        .catch(() => false);
      if (done) removed.push(role.name);
    }
    if (removed.length === 0) note = 'No dangerous roles could be removed.';
  }

  const incident = {
    id: Math.random().toString(36).slice(2, 10),
    at: Date.now(),
    actorId,
    actorName: member?.user?.tag ?? actorId,
    action: watched.key,
    label: watched.label,
    count,
    removed,
    note,
  };
  config.incidents = [incident, ...(config.incidents ?? [])].slice(0, 20);
  features.store.save();

  await alert(features, guild, config, incident);
  return incident;
}

async function alert(features, guild, config, incident) {
  const text = [
    `**${incident.actorName}** (<@${incident.actorId}>) triggered **${incident.count} ${incident.label}** inside ${Math.round(
      config.windowMs / 1000,
    )}s.`,
    incident.removed.length
      ? `Removed roles: ${incident.removed.map((name) => `\`${name}\``).join(', ')}`
      : incident.note || 'No roles were removed.',
    '_Review the audit log before giving anything back._',
  ].join('\n');

  const logging = features.store.guild(guild.id).logging;
  const channelId = config.channelId ?? logging?.channels?.moderation ?? logging?.channels?.messages;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  if (channel?.isTextBased?.()) {
    await channel
      .send({ embeds: [embed('🛡️ Anti-nuke triggered', text, COLORS.urgent)], allowedMentions: { parse: [] } })
      .catch(() => {});
  }

  const owner = await features.client?.users?.fetch(guild.ownerId).catch(() => null);
  await owner?.send({ embeds: [embed(`Anti-nuke in ${guild.name}`, text, COLORS.urgent)] }).catch(() => {});
}

export function registerNukeGuard(features, client) {
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (!guild) return;
    handleAuditEntry(features, entry, guild).catch((error) => {
      features.bot?.log('warn', `Anti-nuke check failed: ${error.message}`);
    });
  });
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('antinuke')
      .setDescription('Stop a compromised staff account from wiping the server')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the guard state and recent incidents'))
      .addSubcommand((sub) => sub.setName('on').setDescription('Turn the guard on'))
      .addSubcommand((sub) => sub.setName('off').setDescription('Turn the guard off'))
      .addSubcommand((sub) =>
        sub
          .setName('threshold')
          .setDescription('How many actions in the window count as a breach')
          .addIntegerOption((option) => option.setName('count').setDescription('Actions, 2-20').setRequired(true).setMinValue(2).setMaxValue(20))
          .addIntegerOption((option) =>
            option.setName('seconds').setDescription('Window in seconds, default 60').setRequired(false).setMinValue(10).setMaxValue(600),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Where to post incidents')
          .addChannelOption((option) => option.setName('channel').setDescription('Alert channel').setRequired(true).addChannelTypes(0)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('trust')
          .setDescription('Exempt a role from the guard')
          .addRoleOption((option) => option.setName('role').setDescription('Trusted role').setRequired(true)),
      ),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      const guild = interaction.guild;
      const config = guardState(features, guild.id);
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'status') {
        const summary = guardSummary(features, guild.id);
        await interaction.reply({
          embeds: [
            embed(
              summary.enabled ? '🛡️ Anti-nuke is on' : 'Anti-nuke is off',
              [
                `**Trigger:** ${summary.threshold} actions in ${Math.round(summary.windowMs / 1000)}s`,
                `**Alerts:** ${summary.channelId ? `<#${summary.channelId}>` : '_moderation log channel_'}`,
                `**Trusted roles:** ${summary.trustedRoles.length || 'none'}`,
                limitConfigured(features, guild.id, guild) ? '' : '\n⚠️ Aegis needs **View Audit Log** and **Manage Roles**.',
                summary.incidents.length
                  ? `\n**Recent incidents**\n${summary.incidents
                      .slice(0, 5)
                      .map((item) => `• <t:${Math.floor(item.at / 1000)}:R> — <@${item.actorId}> ${item.count}× ${item.label}`)
                      .join('\n')}`
                  : '\nNo incidents recorded.',
              ]
                .filter(Boolean)
                .join('\n'),
              summary.enabled ? COLORS.on : COLORS.muted,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'on' || subcommand === 'off') {
        config.enabled = subcommand === 'on';
        features.store.save();
        await interaction.reply({
          embeds: [
            embed(
              config.enabled ? 'Anti-nuke enabled' : 'Anti-nuke disabled',
              config.enabled
                ? `If one account ${config.threshold}× destructive actions in ${Math.round(config.windowMs / 1000)}s, Aegis strips its dangerous roles and alerts you.`
                : 'Destructive staff actions are no longer watched.',
              config.enabled ? COLORS.on : COLORS.warn,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'threshold') {
        config.threshold = interaction.options.getInteger('count', true);
        config.windowMs = (interaction.options.getInteger('seconds') ?? 60) * 1000;
        features.store.save();
        await interaction.reply({
          embeds: [embed('Threshold updated', `Breach at **${config.threshold}** actions in **${Math.round(config.windowMs / 1000)}s**.`, COLORS.on)],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'channel') {
        config.channelId = interaction.options.getChannel('channel', true).id;
        features.store.save();
        await interaction.reply({ embeds: [embed('Alert channel set', `Incidents post to <#${config.channelId}>.`, COLORS.on)], flags: 64 });
        return;
      }

      if (subcommand === 'trust') {
        const role = interaction.options.getRole('role', true);
        config.trustedRoles ??= [];
        if (config.trustedRoles.includes(role.id)) {
          config.trustedRoles = config.trustedRoles.filter((id) => id !== role.id);
        } else {
          config.trustedRoles.push(role.id);
        }
        features.store.save();
        await interaction.reply({
          embeds: [
            embed(
              config.trustedRoles.includes(role.id) ? 'Role trusted' : 'Role no longer trusted',
              `<@&${role.id}> ${config.trustedRoles.includes(role.id) ? 'is ignored by the guard.' : 'is watched again.'}`,
              COLORS.on,
            ),
          ],
          flags: 64,
        });
      }
    },
  },
];
