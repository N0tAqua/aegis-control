import {
  AuditLogEvent,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, canManageGuild, embed, formatDuration, isStaffMember, relative } from './util.js';

function configFor(features, guildId) {
  return features.store.guild(guildId).staff;
}

export function staffRoleIds(features, guildId) {
  return configFor(features, guildId).roles ?? [];
}

function ensureMember(config, userId) {
  if (!config.members[userId]) {
    config.members[userId] = {
      messages: 0,
      voiceMs: 0,
      actions: 0,
      bans: 0,
      kicks: 0,
      lastActiveAt: 0,
      firstSeenAt: Date.now(),
    };
  }
  return config.members[userId];
}

export function trackStaffMessage(features, message) {
  if (!message.guild || message.author?.bot || !message.member) return;
  const config = configFor(features, message.guild.id);
  if (!isStaffMember(message.member, config.roles ?? [])) return;
  const stat = ensureMember(config, message.author.id);
  stat.messages += 1;
  stat.lastActiveAt = Date.now();
  features.store.save();
}

export function trackStaffVoice(features, oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;
  const config = configFor(features, guild.id);
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;
  if (!isStaffMember(member, config.roles ?? [])) return;

  features.voiceSessions ??= new Map();
  const key = `${guild.id}:${member.id}`;

  const wasIn = Boolean(oldState.channelId);
  const isIn = Boolean(newState.channelId);
  if (wasIn && !isIn) {
    const started = features.voiceSessions.get(key);
    if (started) {
      const stat = ensureMember(config, member.id);
      stat.voiceMs += Math.max(0, Date.now() - started);
      stat.lastActiveAt = Date.now();
      features.voiceSessions.delete(key);
      features.store.save();
    }
  } else if (!wasIn && isIn) {
    features.voiceSessions.set(key, Date.now());
  } else if (wasIn && isIn && oldState.channelId !== newState.channelId) {
    features.voiceSessions.set(key, features.voiceSessions.get(key) ?? Date.now());
  }
}

export function trackStaffAction(features, guildId, userId, kind) {
  if (!userId) return;
  const config = configFor(features, guildId);
  const stat = ensureMember(config, userId);
  stat.actions += 1;
  if (kind === 'ban') stat.bans += 1;
  if (kind === 'kick') stat.kicks += 1;
  stat.lastActiveAt = Date.now();
  features.store.save();
}

async function auditExecutor(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 8 });
    const entry = logs.entries.find(
      (item) => item.targetId === targetId && Date.now() - Number(item.createdTimestamp) < 20_000,
    );
    return entry?.executor ?? null;
  } catch {
    return null;
  }
}

export function registerStaffTracking(features, client) {
  client.on('guildBanAdd', async (ban) => {
    const executor = await auditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (executor) trackStaffAction(features, ban.guild.id, executor.id, 'ban');
  });
  client.on('guildMemberRemove', async (member) => {
    if (member.user?.bot) return;
    const executor = await auditExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
    if (executor) trackStaffAction(features, member.guild.id, executor.id, 'kick');
  });
}

export function staffSnapshot(features, guildId, userId, member) {
  const config = configFor(features, guildId);
  const ticketConfig = features.store.guild(guildId).tickets;
  const stat = config.members[userId] ?? {
    messages: 0,
    voiceMs: 0,
    actions: 0,
    bans: 0,
    kicks: 0,
    lastActiveAt: 0,
  };
  const tickets = ticketConfig.staff[userId] ?? {
    claimed: 0,
    closed: 0,
    responses: 0,
    responseTotal: 0,
    messages: 0,
  };
  const liveVoice = features.voiceSessions?.get(`${guildId}:${userId}`);
  const voiceMs = stat.voiceMs + (liveVoice ? Date.now() - liveVoice : 0);
  const score = Math.round(
    stat.messages * 1 + (voiceMs / 3_600_000) * 15 + stat.actions * 8 + tickets.closed * 12 + tickets.claimed * 4,
  );
  return {
    userId,
    name: member?.displayName ?? member?.user?.username ?? userId,
    messages: stat.messages,
    voiceMs,
    actions: stat.actions,
    bans: stat.bans,
    kicks: stat.kicks,
    lastActiveAt: stat.lastActiveAt,
    tickets,
    averageResponse: tickets.responses ? tickets.responseTotal / tickets.responses : null,
    score,
  };
}

export async function staffDigest(features, guild) {
  const config = configFor(features, guild.id);
  if (!config.channelId) return null;
  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return null;

  const staffIds = new Set([
    ...Object.keys(config.members),
    ...guild.members.cache
      .filter((member) => !member.user.bot && isStaffMember(member, config.roles ?? []))
      .map((member) => member.id),
  ]);
  const rows = [...staffIds]
    .map((userId) => staffSnapshot(features, guild.id, userId, guild.members.cache.get(userId)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (rows.length === 0) return null;

  const message = await channel
    .send({
      embeds: [
        embed(
          '📊 Weekly staff report',
          [
            ...rows.map(
              (row, index) =>
                `**${index + 1}.** <@${row.userId}> — ${row.messages} messages · ${formatDuration(
                  row.voiceMs,
                )} voice · ${row.tickets.closed} tickets closed · ${row.actions} actions`,
            ),
            '',
            'Use `/staff stats` for an individual breakdown.',
          ].join('\n'),
          COLORS.brand,
        ),
      ],
    })
    .catch(() => null);

  config.lastDigestAt = Date.now();
  features.store.save();
  return message;
}

export async function sweepStaff(features) {
  const week = 7 * 86_400_000;
  for (const guild of features.client?.guilds.cache.values() ?? []) {
    const config = configFor(features, guild.id);
    if (!config.channelId) continue;
    if (Date.now() - (config.lastDigestAt ?? 0) < week) continue;
    await staffDigest(features, guild).catch(() => {});
  }
}

/* ----------------------------------------------------------------- command --- */

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('staff')
      .setDescription('Staff activity, response times and moderation statistics')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) =>
        sub
          .setName('stats')
          .setDescription('Activity breakdown for one staff member')
          .addUserOption((option) => option.setName('user').setDescription('Staff member (default: you)').setRequired(false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('top')
          .setDescription('Staff leaderboard')
          .addStringOption((option) =>
            option
              .setName('metric')
              .setDescription('What to rank by')
              .setRequired(false)
              .addChoices(
                { name: 'Activity score', value: 'score' },
                { name: 'Messages', value: 'messages' },
                { name: 'Voice time', value: 'voice' },
                { name: 'Tickets closed', value: 'tickets' },
                { name: 'Moderation actions', value: 'actions' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('role')
          .setDescription('Choose which roles count as staff')
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('Add, remove or list')
              .setRequired(true)
              .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' }),
          )
          .addRoleOption((option) => option.setName('role').setDescription('Staff role').setRequired(false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Post the weekly staff report here')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Report channel').setRequired(true).addChannelTypes(0),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reset')
          .setDescription('Reset tracked staff activity')
          .addUserOption((option) => option.setName('user').setDescription('Only reset this member').setRequired(false)),
      ),

    async execute(interaction, { features }) {
      const guild = interaction.guild;
      const config = configFor(features, guild.id);
      const subcommand = interaction.options.getSubcommand();
      const manager = canManageGuild(interaction.member);

      if (subcommand === 'role' || subcommand === 'channel' || subcommand === 'reset') {
        if (!manager) {
          await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
          return;
        }
      }

      if (subcommand === 'role') {
        const action = interaction.options.getString('action', true);
        const role = interaction.options.getRole('role');
        if (action === 'add') {
          if (!role) {
            await interaction.reply({ embeds: [embed('Role required', 'Pick a role to add.', COLORS.off)], flags: 64 });
            return;
          }
          config.roles = [...new Set([...(config.roles ?? []), role.id])];
          features.store.save();
          await interaction.reply({ embeds: [embed('Staff role added', `<@&${role.id}> now counts as staff.`, COLORS.on)], flags: 64 });
          return;
        }
        if (action === 'remove') {
          if (!role) {
            await interaction.reply({ embeds: [embed('Role required', 'Pick a role to remove.', COLORS.off)], flags: 64 });
            return;
          }
          config.roles = (config.roles ?? []).filter((id) => id !== role.id);
          features.store.save();
          await interaction.reply({ embeds: [embed('Staff role removed', `<@&${role.id}> no longer counts as staff.`, COLORS.on)], flags: 64 });
          return;
        }
        await interaction.reply({
          embeds: [
            embed(
              'Staff roles',
              config.roles?.length
                ? config.roles.map((id) => `<@&${id}>`).join('\n')
                : 'No staff roles yet. Anyone with **Manage Server** counts as staff by default.',
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'channel') {
        config.channelId = interaction.options.getChannel('channel', true).id;
        config.lastDigestAt = 0;
        features.store.save();
        await interaction.reply({
          embeds: [embed('Weekly report enabled', `The staff report is posted in <#${config.channelId}> once a week.`, COLORS.on)],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'reset') {
        const target = interaction.options.getUser('user');
        if (target) delete config.members[target.id];
        else config.members = {};
        features.store.save();
        await interaction.reply({
          embeds: [embed('Activity reset', target ? `Cleared stats for <@${target.id}>.` : 'All staff activity stats were cleared.', COLORS.muted)],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'stats') {
        const user = interaction.options.getUser('user') ?? interaction.user;
        const member = guild.members.cache.get(user.id) ?? (await guild.members.fetch(user.id).catch(() => null));
        const snapshot = staffSnapshot(features, guild.id, user.id, member);
        await interaction.reply({
          embeds: [
            embed(
              `Staff activity · ${user.username}`,
              [
                `**Activity score:** ${snapshot.score}`,
                `**Messages:** ${snapshot.messages.toLocaleString('en-US')}`,
                `**Voice time:** ${formatDuration(snapshot.voiceMs)}`,
                `**Tickets claimed:** ${snapshot.tickets.claimed} · **closed:** ${snapshot.tickets.closed}`,
                `**Average first response:** ${
                  snapshot.averageResponse !== null ? formatDuration(snapshot.averageResponse) : '—'
                }`,
                `**Moderation actions:** ${snapshot.actions} (${snapshot.bans} bans, ${snapshot.kicks} kicks)`,
                `**Last active:** ${snapshot.lastActiveAt ? relative(snapshot.lastActiveAt) : 'no activity tracked yet'}`,
                '',
                '_Activity is tracked from the moment Aegis starts tracking this server._',
              ].join('\n'),
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      const metric = interaction.options.getString('metric') ?? 'score';
      const userIds = new Set([
        ...Object.keys(config.members),
        ...guild.members.cache
          .filter((member) => !member.user.bot && isStaffMember(member, config.roles ?? []))
          .map((member) => member.id),
      ]);
      const rows = [...userIds]
        .map((userId) => staffSnapshot(features, guild.id, userId, guild.members.cache.get(userId)))
        .sort((a, b) => {
          if (metric === 'messages') return b.messages - a.messages;
          if (metric === 'voice') return b.voiceMs - a.voiceMs;
          if (metric === 'tickets') return b.tickets.closed - a.tickets.closed;
          if (metric === 'actions') return b.actions - a.actions;
          return b.score - a.score;
        })
        .slice(0, 15);

      if (rows.length === 0) {
        await interaction.reply({ embeds: [embed('No staff data yet', 'Set staff roles with `/staff role` and activity will build up.', COLORS.muted)], flags: 64 });
        return;
      }

      const label = { score: 'activity score', messages: 'messages', voice: 'voice time', tickets: 'tickets closed', actions: 'moderation actions' }[metric];
      await interaction.reply({
        embeds: [
          embed(
            `Staff leaderboard · ${label}`,
            rows
              .map((row, index) => {
                const value =
                  metric === 'voice'
                    ? formatDuration(row.voiceMs)
                    : metric === 'tickets'
                      ? String(row.tickets.closed)
                      : metric === 'messages'
                        ? row.messages.toLocaleString('en-US')
                        : metric === 'actions'
                          ? String(row.actions)
                          : String(row.score);
                return `**${index + 1}.** <@${row.userId}> — ${value}`;
              })
              .join('\n'),
            COLORS.brand,
          ),
        ],
        flags: 64,
      });
    },
  },
];
