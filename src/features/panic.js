import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, canManageGuild, embed, formatDuration } from './util.js';

export function panicState(features, guildId) {
  const config = features.store.guild(guildId);
  config.panic ??= {
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
  };
  return config.panic;
}

function note(record, text) {
  record.timeline.push({ at: Date.now(), text: String(text).slice(0, 200) });
  if (record.timeline.length > 60) record.timeline.splice(0, record.timeline.length - 60);
}

export function panicSummary(features, guildId) {
  const record = panicState(features, guildId);
  return {
    active: Boolean(record.active),
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    by: record.by ?? null,
    reason: record.reason ?? '',
    channels: record.channels?.length ?? 0,
    quarantined: record.quarantined?.length ?? 0,
    quarantineRoleId: record.quarantineRoleId ?? null,
    quarantineReport: record.quarantineReport ?? null,
    failed: record.failed ?? [],
    timeline: (record.timeline ?? []).slice(-10),
    duration: record.active && record.startedAt ? Date.now() - record.startedAt : null,
  };
}

const LOCKED_FLAGS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'AddReactions'];

/** @everyone overwrite on a channel, kept as plain values so it survives JSON. */
function readOverwrite(channel, everyoneId) {
  const overwrite = channel.permissionOverwrites?.cache?.get(everyoneId) ?? null;
  if (!overwrite) return { had: false, perms: {} };
  const perms = {};
  for (const flag of LOCKED_FLAGS) {
    const bit = PermissionFlagsBits[flag];
    perms[flag] = overwrite.allow.has(bit) ? 'allow' : overwrite.deny.has(bit) ? 'deny' : 'inherit';
  }
  return { had: true, perms };
}

async function restoreOverwrite(channel, everyoneId, saved) {
  if (!saved.had) {
    const existing = channel.permissionOverwrites?.cache?.get(everyoneId);
    if (existing) await channel.permissionOverwrites.delete(everyoneId, 'Aegis panic mode ended');
    return;
  }
  const options = {};
  for (const flag of LOCKED_FLAGS) {
    const value = saved.perms?.[flag];
    options[flag] = value === 'allow' ? true : value === 'deny' ? false : null;
  }
  await channel.permissionOverwrites.edit(everyoneId, options, { reason: 'Aegis panic mode ended' });
}

export async function activatePanic(features, guild, { by = 'dashboard', reason = '', quarantineRoleId = undefined, windowMs = undefined } = {}) {
  const record = panicState(features, guild.id);
  if (record.active) return { already: true, ...panicSummary(features, guild.id) };

  const me = guild.members.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('Aegis needs **Manage Channels** to lock the server.');
  }

  if (quarantineRoleId !== undefined) record.quarantineRoleId = quarantineRoleId || null;
  if (windowMs !== undefined) record.joinWindowMs = Math.min(7 * 86_400_000, Math.max(60_000, Number(windowMs) || 3_600_000));

  record.active = true;
  record.startedAt = Date.now();
  record.endedAt = null;
  record.by = String(by).slice(0, 80);
  record.reason = String(reason ?? '').slice(0, 300);
  record.channels = [];
  record.failed = [];
  record.timeline = [];
  record.quarantined = [];
  note(record, `Panic mode activated by ${record.by}${record.reason ? `: ${record.reason}` : ''}.`);

  const everyone = guild.roles.everyone;
  for (const channel of guild.channels.cache.values()) {
    if (typeof channel.isTextBased !== 'function' || !channel.isTextBased()) continue;
    if (channel.isThread?.() || channel.isDMBased?.()) continue;
    const canSend = channel.permissionsFor?.(everyone)?.has(PermissionFlagsBits.SendMessages);
    if (!canSend) continue;
    const saved = readOverwrite(channel, everyone.id);
    const entry = {
      id: channel.id,
      name: channel.name,
      slowmode: Number(channel.rateLimitPerUser) || 0,
      had: saved.had,
      perms: saved.perms,
    };
    try {
      await channel.permissionOverwrites.edit(
        everyone.id,
        {
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          AddReactions: false,
        },
        { reason: 'Aegis panic mode' },
      );
      if (entry.slowmode < 15 && typeof channel.setRateLimitPerUser === 'function') {
        await channel.setRateLimitPerUser(15, 'Aegis panic mode').catch(() => {});
      }
      record.channels.push(entry);
    } catch (error) {
      record.failed.push(`#${channel.name}: ${error.message}`);
    }
  }
  note(record, `Locked ${record.channels.length} channel(s).`);

  try {
    record.verification = guild.verificationLevel;
    if (guild.verificationLevel < 4 && me.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await guild.setVerificationLevel(4, 'Aegis panic mode');
      note(record, 'Raised the server verification level to highest.');
    }
  } catch (error) {
    record.failed.push(`Verification level: ${error.message}`);
  }

  if (record.quarantineRoleId) {
    await quarantineRecentJoins(guild, record);
    features.store.save();
  }

  features.store.save();
  await announce(features, guild, record, true);
  return { already: false, ...panicSummary(features, guild.id) };
}

export async function deactivatePanic(features, guild, { by = 'dashboard' } = {}) {
  const record = panicState(features, guild.id);
  if (!record.active) return { already: true, ...panicSummary(features, guild.id) };

  const everyone = guild.roles.everyone;
  let restored = 0;
  for (const entry of record.channels ?? []) {
    const channel = guild.channels.cache.get(entry.id) ?? (await guild.channels.fetch(entry.id).catch(() => null));
    if (!channel) continue;
    try {
      await restoreOverwrite(channel, everyone.id, entry);
      if (entry.slowmode !== undefined && typeof channel.setRateLimitPerUser === 'function' && channel.rateLimitPerUser !== entry.slowmode) {
        await channel.setRateLimitPerUser(entry.slowmode, 'Aegis panic mode ended').catch(() => {});
      }
      restored += 1;
    } catch (error) {
      record.failed.push(`#${entry.name}: ${error.message}`);
    }
  }

  if (record.verification !== null && record.verification !== undefined) {
    await guild.setVerificationLevel(record.verification, 'Aegis panic mode ended').catch((error) => {
      record.failed.push(`Verification level: ${error.message}`);
    });
  }

  let lifted = 0;
  let liftFailed = 0;
  for (const userId of record.quarantined ?? []) {
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    if (!member) continue;
    const done = await member.roles
      .remove(record.quarantineRoleId, 'Aegis panic mode ended')
      .then(() => true)
      .catch(() => false);
    if (done) lifted += 1;
    else {
      liftFailed += 1;
      if (liftFailed <= 3) record.failed.push(`Could not lift quarantine from ${member.user?.tag ?? userId}.`);
    }
  }
  if (record.quarantined?.length) note(record, `Lifted quarantine from ${lifted} member(s)${liftFailed ? `, ${liftFailed} failed` : ''}.`);

  record.active = false;
  record.endedAt = Date.now();
  record.channels = [];
  record.quarantined = [];
  record.verification = null;
  note(record, `Panic mode ended by ${String(by).slice(0, 80)}. Restored ${restored} channel(s).`);
  features.store.save();
  await announce(features, guild, record, false);
  return { already: false, restored, ...panicSummary(features, guild.id) };
}

/**
 * Recent joins are found through a full member fetch, not the gateway cache:
 * with the Server Members intent disabled (or a huge guild) the cache only
 * holds a handful of members, which used to skip people without a trace.
 * Anything that still cannot be covered is written into the panic report.
 */
async function quarantineRecentJoins(guild, record) {
  const report = { at: Date.now(), targets: 0, quarantined: 0, failed: 0, already: 0, incomplete: false, note: null };
  record.quarantineReport = report;
  const role = guild.roles.cache.get(record.quarantineRoleId);

  if (!role) {
    report.note = 'The quarantine role no longer exists, so nobody was quarantined.';
    record.failed.push(report.note);
    return report;
  }
  if (role.editable === false) {
    report.note = `The quarantine role "${role.name}" sits above Aegis, so it could not be given out.`;
    record.failed.push(report.note);
    return report;
  }

  let members = guild.members.cache;
  try {
    members = await guild.members.fetch({ limit: 0, time: 20_000 });
  } catch (error) {
    report.incomplete = true;
    report.note = `Could not read the full member list (${error.message}). Only the ${members.size} cached member(s) were checked — enable the Server Members intent for full coverage.`;
    record.failed.push(report.note);
  }
  if (!report.incomplete && members.size < Math.max(0, Number(guild.memberCount) - 1)) {
    report.incomplete = true;
    report.note = `Only ${members.size} of ${guild.memberCount} members were available, so some recent joins may not be quarantined.`;
    record.failed.push(report.note);
  }

  const cutoff = Date.now() - record.joinWindowMs;
  const targets = [...members.values()].filter((member) => {
    if (!member || member.user?.bot || member.id === guild.ownerId) return false;
    if (!(member.joinedTimestamp >= cutoff)) return false;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return false;
    return true;
  });
  report.targets = targets.length;

  for (const member of targets) {
    if (member.roles?.cache?.has?.(role.id)) {
      report.already += 1;
      if (!record.quarantined.includes(member.id)) record.quarantined.push(member.id);
      continue;
    }
    const added = await member.roles
      .add(role, 'Aegis panic mode quarantine')
      .then(() => true)
      .catch((error) => {
        report.failed += 1;
        if (report.failed <= 3) record.failed.push(`Could not quarantine ${member.user?.tag ?? member.id}: ${error.message}`);
        return false;
      });
    if (added) {
      report.quarantined += 1;
      record.quarantined.push(member.id);
    }
  }

  note(
    record,
    `Quarantined ${report.quarantined} of ${report.targets} recent join(s)${report.already ? ` (${report.already} already had the role)` : ''}${
      report.failed ? `, ${report.failed} failed` : ''}${report.incomplete ? ' — member list was incomplete' : ''}.`,
  );
  return report;
}

export async function quarantineNewMember(features, member) {
  const record = panicState(features, member.guild.id);
  if (!record.active || !record.quarantineRoleId) return false;
  if (member.user?.bot || member.id === member.guild.ownerId) return false;
  const added = await member.roles
    .add(record.quarantineRoleId, 'Aegis panic mode quarantine')
    .then(() => true)
    .catch(() => false);
  if (added) {
    record.quarantined.push(member.id);
    features.store.save();
  }
  return added;
}

async function announce(features, guild, record, started) {
  const config = features.store.guild(guild.id).logging;
  const channelId = config?.channels?.moderation ?? config?.channels?.messages ?? guild.systemChannelId;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  if (!channel?.isTextBased?.()) return;
  const lines = record.timeline.slice(-6).map((entry) => `• ${entry.text}`);
  if (record.failed.length) lines.push('', `⚠️ ${record.failed.length} step(s) failed — check Aegis permissions.`);
  await channel
    .send({
      embeds: [
        embed(
          started ? '🚨 Panic mode active' : '✅ Panic mode ended',
          [
            started
              ? `**${record.by}** locked the server${record.reason ? `: ${record.reason}` : '.'}`
              : `Restored by **${String(record.by ?? 'dashboard')}** after ${formatDuration(Date.now() - (record.startedAt ?? Date.now()))}.`,
            '',
            ...lines,
          ].join('\n'),
          started ? COLORS.urgent : COLORS.on,
        ),
      ],
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('panic')
      .setDescription('Lock the whole server in an emergency, then restore everything')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('on')
          .setDescription('Lock channels, raise verification and quarantine recent joins')
          .addStringOption((option) => option.setName('reason').setDescription('What is happening?').setRequired(false).setMaxLength(200))
          .addRoleOption((option) =>
            option.setName('quarantine-role').setDescription('Role to give recent joins while locked').setRequired(false),
          )
          .addIntegerOption((option) =>
            option
              .setName('join-window')
              .setDescription('Quarantine members who joined in the last N minutes (default 60)')
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(10080),
          ),
      )
      .addSubcommand((sub) => sub.setName('off').setDescription('Undo panic mode and restore the server'))
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the current panic state')),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      const guild = interaction.guild;

      if (subcommand === 'status') {
        const summary = panicSummary(features, guild.id);
        await interaction.reply({
          embeds: [
            embed(
              summary.active ? '🚨 Panic mode is active' : 'Panic mode is off',
              [
                summary.active
                  ? `Locked **${summary.channels}** channel(s) for ${formatDuration(summary.duration ?? 0)} by **${summary.by}**.`
                  : summary.endedAt
                    ? `Last used ${formatDuration(Date.now() - summary.endedAt)} ago.`
                    : 'Use `/panic on` if the server is being raided.',
                summary.quarantined ? `Quarantined members: **${summary.quarantined}**` : '',
                summary.quarantineReport?.targets
                  ? `Quarantine coverage: ${summary.quarantineReport.quarantined}/${summary.quarantineReport.targets}${
                      summary.quarantineReport.incomplete ? ' (member list incomplete)' : ''
                    }`
                  : '',
                summary.failed.length ? `\n⚠️ ${summary.failed.length} step(s) failed last time.` : '',
              ]
                .filter(Boolean)
                .join('\n'),
              summary.active ? COLORS.urgent : COLORS.muted,
            ),
          ],
          flags: 64,
        });
        return;
      }

      await interaction.deferReply({ flags: 64 });
      try {
        if (subcommand === 'on') {
          const role = interaction.options.getRole('quarantine-role');
          const minutes = interaction.options.getInteger('join-window');
          const result = await activatePanic(features, guild, {
            by: interaction.user.username,
            reason: interaction.options.getString('reason') ?? '',
            quarantineRoleId: role ? role.id : undefined,
            windowMs: minutes ? minutes * 60_000 : undefined,
          });
          await interaction.editReply({
            embeds: [
              embed(
                result.already ? 'Already locked' : '🚨 Panic mode active',
                [
                  `Locked **${result.channels}** channel(s). Use \`/panic off\` when it is safe.`,
                  result.quarantineReport?.targets
                    ? `Quarantined **${result.quarantineReport.quarantined}** of ${result.quarantineReport.targets} recent join(s).`
                    : '',
                  result.quarantineReport?.note ? `⚠️ ${result.quarantineReport.note}` : '',
                ]
                  .filter(Boolean)
                  .join('\n'),
                COLORS.urgent,
              ),
            ],
          });
        } else {
          const result = await deactivatePanic(features, guild, { by: interaction.user.username });
          await interaction.editReply({
            embeds: [
              embed(
                result.already ? 'Panic mode was not active' : '✅ Server restored',
                result.already ? 'Nothing to undo.' : `Restored **${result.restored}** channel(s) and lifted quarantine.`,
                COLORS.on,
              ),
            ],
          });
        }
      } catch (error) {
        await interaction.editReply({ embeds: [embed('Panic mode failed', error.message, COLORS.off)] });
      }
    },
  },
];
