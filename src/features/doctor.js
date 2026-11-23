import { ChannelType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, canManageGuild, embed } from './util.js';

const BOT_PERMISSIONS = [
  [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
  [PermissionFlagsBits.KickMembers, 'Kick Members'],
  [PermissionFlagsBits.BanMembers, 'Ban Members'],
  [PermissionFlagsBits.ViewAuditLog, 'View Audit Log'],
  [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  [PermissionFlagsBits.ManageWebhooks, 'Manage Webhooks'],
];

const DANGEROUS_PERMS = [
  [PermissionFlagsBits.Administrator, 'Administrator'],
  [PermissionFlagsBits.ManageGuild, 'Manage Server'],
  [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  [PermissionFlagsBits.BanMembers, 'Ban Members'],
  [PermissionFlagsBits.KickMembers, 'Kick Members'],
  [PermissionFlagsBits.ManageWebhooks, 'Manage Webhooks'],
];

export function doctorState(features, guildId) {
  const config = features.store.guild(guildId);
  config.doctor ??= { lastRunAt: 0, score: null, grade: null, checks: [] };
  return config.doctor;
}

function activitySince(features, guildId, days) {
  const activity = features.store.guild(guildId).activity?.days ?? {};
  const cutoff = Date.now() - days * 86_400_000;
  const totals = new Map();
  for (const [key, day] of Object.entries(activity)) {
    const at = Date.parse(`${key}T00:00:00.000Z`);
    if (!Number.isFinite(at) || at < cutoff) continue;
    for (const [channelId, count] of Object.entries(day?.channels ?? {})) {
      totals.set(channelId, (totals.get(channelId) ?? 0) + Number(count || 0));
    }
  }
  return totals;
}

function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 78) return 'B';
  if (score >= 62) return 'C';
  if (score >= 45) return 'D';
  return 'E';
}

function check(id, severity, title, detail, { fix = null, count = 1, samples = [] } = {}) {
  return { id, severity, title, detail, fix, count, samples };
}

export function auditGuild(features, guild) {
  const checks = [];
  const me = guild.members.me;
  const botTop = me?.roles?.highest?.position ?? 0;
  const state = features.store.guild(guild.id);

  const adminRoles = guild.roles.cache.filter((role) => !role.managed && role.id !== guild.id && role.permissions.has(PermissionFlagsBits.Administrator));
  if (adminRoles.size) {
    checks.push(
      check(
        'admin-roles',
        adminRoles.size > 1 ? 'high' : 'medium',
        `${adminRoles.size} role${adminRoles.size === 1 ? '' : 's'} with Administrator`,
        'Anyone with one of these roles can do anything, including deleting the server. Keep the list as short as possible.',
        { samples: adminRoles.map((role) => role.name).slice(0, 8), count: adminRoles.size },
      ),
    );
  }

  const risky = guild.roles.cache.filter(
    (role) =>
      !role.managed &&
      role.id !== guild.id &&
      role.members.size === 0 &&
      DANGEROUS_PERMS.some(([flag]) => role.permissions.has(flag)),
  );
  if (risky.size) {
    checks.push(
      check(
        'unused-dangerous-roles',
        'medium',
        `${risky.size} unused role${risky.size === 1 ? '' : 's'} with dangerous permissions`,
        'Nobody has these roles, so they are free attack surface for anyone who can assign roles.',
        { fix: 'delete_unused_roles', count: risky.size, samples: risky.map((role) => role.name).slice(0, 8) },
      ),
    );
  }

  const privateLeaks = [];
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice) continue;
    const overwrites = channel.permissionOverwrites?.cache;
    if (!overwrites || overwrites.size === 0) continue;
    const everyone = overwrites.get(guild.id);
    if (!everyone) continue;
    if (everyone.allow.has(PermissionFlagsBits.ViewChannel)) privateLeaks.push(channel.name);
  }
  if (privateLeaks.length) {
    checks.push(
      check(
        'public-overrides',
        'medium',
        `${privateLeaks.length} channel${privateLeaks.length === 1 ? '' : 's'} with overrides still visible to @everyone`,
        'These channels have custom permissions but @everyone can still view them, which is usually not what the overrides were meant to do.',
        { samples: privateLeaks.slice(0, 8), count: privateLeaks.length },
      ),
    );
  }

  if (me) {
    const missing = BOT_PERMISSIONS.filter(([flag]) => !me.permissions.has(flag)).map(([, label]) => label);
    if (missing.length) {
      checks.push(
        check(
          'bot-permissions',
          'high',
          `Aegis is missing ${missing.length} permission${missing.length === 1 ? '' : 's'}`,
          'Some buttons and commands silently fail without these.',
          { samples: missing, count: missing.length },
        ),
      );
    }
  }

  const logging = state.logging ?? {};
  const logChannels = Object.values(logging.channels ?? {}).filter(Boolean);
  if (logChannels.length === 0) {
    checks.push(
      check('no-logging', 'medium', 'No log channel configured', 'Aegis cannot record moderation, joins or message edits until a log channel exists.', {
        samples: ['Run /logs setup'],
      }),
    );
  }

  if (guild.mfaLevel === 0) {
    checks.push(
      check('no-2fa', 'medium', 'Two-factor requirement is off', 'Staff can act on the server without 2FA on their Discord account.', {
        fix: 'require_2fa',
      }),
    );
  }

  if (guild.verificationLevel < 2) {
    checks.push(
      check(
        'low-verification',
        'low',
        'Server verification level is low',
        'New accounts can join and talk straight away. Medium verification stops most throwaway accounts.',
        { fix: 'set_verification' },
      ),
    );
  }

  const quiet = [];
  const totals = activitySince(features, guild.id, 30);
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    if (Date.now() - channel.createdTimestamp < 7 * 86_400_000) continue;
    if ((totals.get(channel.id) ?? 0) === 0) quiet.push(channel.name);
  }
  if (quiet.length) {
    checks.push(
      check(
        'quiet-channels',
        'low',
        `${quiet.length} channel${quiet.length === 1 ? '' : 's'} with no messages in 30 days`,
        'Quiet channels make the server look abandoned. Archive or merge the ones you no longer use.',
        { samples: quiet.slice(0, 8), count: quiet.length },
      ),
    );
  }

  const unmanageable = guild.roles.cache.filter((role) => role.position >= botTop && role.id !== guild.id && !role.managed);
  if (unmanageable.size && me) {
    checks.push(
      check(
        'role-hierarchy',
        'low',
        'Aegis cannot manage some roles',
        'Move the Aegis role above the roles it should edit.',
        { samples: unmanageable.map((role) => role.name).slice(0, 5), count: unmanageable.size },
      ),
    );
  }

  let score = 100;
  for (const entry of checks) {
    const penalty = { high: 14, medium: 8, low: 4 }[entry.severity] ?? 4;
    score -= Math.min(penalty * Math.max(1, Math.min(3, entry.count)), penalty * 3);
  }
  score = Math.max(0, Math.round(score));

  return {
    score,
    grade: grade(score),
    checks,
    at: Date.now(),
    counts: {
      roles: guild.roles.cache.size,
      channels: guild.channels.cache.size,
      members: guild.memberCount,
      fixes: checks.filter((entry) => entry.fix).length,
    },
  };
}

export async function runDoctor(features, guild) {
  const report = auditGuild(features, guild);
  const config = doctorState(features, guild.id);
  config.lastRunAt = report.at;
  config.score = report.score;
  config.grade = report.grade;
  config.checks = report.checks;
  features.store.save();
  return report;
}

export function doctorSummary(features, guildId) {
  const config = doctorState(features, guildId);
  return {
    lastRunAt: config.lastRunAt ?? 0,
    score: config.score ?? null,
    grade: config.grade ?? null,
    checks: config.checks ?? [],
  };
}

export async function applyDoctorFix(features, guild, kind) {
  const me = guild.members.me;
  if (kind === 'delete_unused_roles') {
    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) throw new Error('Aegis needs **Manage Roles**.');
    const botTop = me.roles.highest.position;
    const targets = guild.roles.cache.filter(
      (role) =>
        !role.managed &&
        role.id !== guild.id &&
        role.members.size === 0 &&
        role.position < botTop &&
        DANGEROUS_PERMS.some(([flag]) => role.permissions.has(flag)),
    );
    const removed = [];
    for (const role of targets.values()) {
      const done = await role.delete('Aegis server doctor: unused dangerous role').then(() => true).catch(() => false);
      if (done) removed.push(role.name);
    }
    await runDoctor(features, guild);
    return { fixed: `Deleted ${removed.length} unused role(s).`, removed };
  }

  if (kind === 'require_2fa') {
    await guild.setMFALevel(1, 'Aegis server doctor: require 2FA for moderation');
    await runDoctor(features, guild);
    return { fixed: 'Two-factor requirement enabled for moderation actions.' };
  }

  if (kind === 'set_verification') {
    const level = Math.max(2, guild.verificationLevel);
    await guild.setVerificationLevel(level, 'Aegis server doctor: raise verification');
    await runDoctor(features, guild);
    return { fixed: `Verification level raised to ${level}.` };
  }

  throw new Error(`Unknown fix "${kind}".`);
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('doctor')
      .setDescription('Audit the server for risky permissions, leaks and dead channels')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('run').setDescription('Audit the server now'))
      .addSubcommand((sub) =>
        sub
          .setName('fix')
          .setDescription('Apply a safe fix from the audit')
          .addStringOption((option) =>
            option
              .setName('fix')
              .setDescription('Which fix')
              .setRequired(true)
              .addChoices(
                { name: 'Delete unused dangerous roles', value: 'delete_unused_roles' },
                { name: 'Require 2FA for moderation', value: 'require_2fa' },
                { name: 'Raise verification level', value: 'set_verification' },
              ),
          ),
      ),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'fix') {
        await interaction.deferReply({ flags: 64 });
        try {
          const result = await applyDoctorFix(features, interaction.guild, interaction.options.getString('fix', true));
          await interaction.editReply({ embeds: [embed('Fix applied', result.fixed, COLORS.on)] });
        } catch (error) {
          await interaction.editReply({ embeds: [embed('Fix failed', error.message, COLORS.off)] });
        }
        return;
      }

      await interaction.deferReply({ flags: 64 });
      const report = await runDoctor(features, interaction.guild);
      await interaction.editReply({
        embeds: [
          embed(
            `🩺 Server doctor — ${report.score}/100 (${report.grade})`,
            report.checks.length
              ? report.checks
                  .map(
                    (entry) =>
                      `${entry.severity === 'high' ? '🔴' : entry.severity === 'medium' ? '🟠' : '🟡'} **${entry.title}**\n${entry.detail}${
                        entry.samples?.length ? `\n> ${entry.samples.slice(0, 4).join(', ')}` : ''
                      }${entry.fix ? `\n> fix: \`/doctor fix ${entry.fix}\`` : ''}`,
                  )
                  .join('\n\n')
              : 'Everything looks healthy. Nothing to fix.',
            report.score >= 85 ? COLORS.on : report.score >= 60 ? COLORS.warn : COLORS.off,
          ),
        ],
      });
    },
  },
];
