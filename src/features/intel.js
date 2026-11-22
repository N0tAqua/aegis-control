import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  COLORS,
  canManageGuild,
  bar,
  dateKey,
  dayKeys,
  embed,
  formatDuration,
  number,
  percent,
  relative,
  similarName,
  truncate,
} from './util.js';

const MAX_DAYS = 40;
const DAY_MS = 86_400_000;

function configFor(features, guildId) {
  return features.store.guild(guildId).intel;
}

function activityFor(features, guildId) {
  return features.store.guild(guildId).activity;
}

function dayBucket(features, guildId, timestamp = Date.now()) {
  const activity = activityFor(features, guildId);
  const key = dateKey(timestamp);
  if (!activity.days[key]) {
    activity.days[key] = { messages: 0, joins: 0, leaves: 0, authors: {}, channels: {}, hours: new Array(24).fill(0) };
  }
  const keys = Object.keys(activity.days).sort();
  if (keys.length > MAX_DAYS) {
    for (const old of keys.slice(0, keys.length - MAX_DAYS)) delete activity.days[old];
  }
  return activity.days[key];
}

export function recordMessageActivity(features, message) {
  if (!message.guild || message.author?.bot) return;
  const bucket = dayBucket(features, message.guild.id, message.createdTimestamp || Date.now());
  bucket.messages += 1;
  bucket.authors[message.author.id] = (bucket.authors[message.author.id] ?? 0) + 1;
  bucket.channels[message.channelId] = (bucket.channels[message.channelId] ?? 0) + 1;
  const hour = new Date(message.createdTimestamp || Date.now()).getUTCHours();
  bucket.hours[hour] = (bucket.hours[hour] ?? 0) + 1;
  features.store.save();
}

export function recordMemberActivity(features, guildId, kind, member) {
  const bucket = dayBucket(features, guildId);
  if (kind === 'join') bucket.joins += 1;
  else bucket.leaves += 1;

  if (kind === 'join' && member?.user) {
    const config = configFor(features, guildId);
    config.joins ??= [];
    config.joins.push({
      userId: member.user.id,
      username: member.user.username,
      at: Date.now(),
      accountCreatedAt: member.user.createdTimestamp,
    });
    if (config.joins.length > 400) config.joins = config.joins.slice(-400);
  }
  features.store.save();
}

/* ------------------------------------------------------------------ stats --- */

function sumDays(days, keys) {
  let messages = 0;
  let joins = 0;
  let leaves = 0;
  const authors = new Set();
  const channels = new Map();
  const hours = new Array(24).fill(0);
  for (const key of keys) {
    const day = days[key];
    if (!day) continue;
    messages += day.messages ?? 0;
    joins += day.joins ?? 0;
    leaves += day.leaves ?? 0;
    for (const userId of Object.keys(day.authors ?? {})) authors.add(userId);
    for (const [channelId, count] of Object.entries(day.channels ?? {})) {
      channels.set(channelId, (channels.get(channelId) ?? 0) + count);
    }
    for (let hour = 0; hour < 24; hour += 1) hours[hour] += day.hours?.[hour] ?? 0;
  }
  return { messages, joins, leaves, authors, channels, hours };
}

export function analyseActivity(features, guildId) {
  const activity = activityFor(features, guildId);
  const days = activity.days ?? {};
  const todayKey = dateKey();
  const yesterdayKey = dateKey(Date.now() - DAY_MS);
  const last7Keys = dayKeys(7);
  const prev7Keys = dayKeys(7, Date.now() - 7 * DAY_MS);
  const last3Keys = dayKeys(3);
  const prev3Keys = dayKeys(3, Date.now() - 3 * DAY_MS);

  const last7 = sumDays(days, last7Keys);
  const prev7 = sumDays(days, prev7Keys);
  const last3 = sumDays(days, last3Keys);
  const prev3 = sumDays(days, prev3Keys);
  const today = days[todayKey] ?? { messages: 0 };
  const yesterday = days[yesterdayKey] ?? { messages: 0 };

  const baselineKeys = [...dayKeys(7, Date.now() - DAY_MS)];
  const baselineValues = baselineKeys.map((key) => days[key]?.messages ?? 0);
  const baseline = baselineValues.length
    ? baselineValues.reduce((total, value) => total + value, 0) / baselineValues.length
    : 0;

  const hours = Math.max(1, new Date().getUTCHours() + new Date().getUTCMinutes() / 60);
  const expectedToday = baseline * (hours / 24);

  return {
    today: today.messages ?? 0,
    yesterday: yesterday.messages ?? 0,
    last7,
    prev7,
    last3,
    prev3,
    baseline,
    expectedToday,
    trend: prev7.messages > 0 ? (last7.messages - prev7.messages) / prev7.messages : 0,
    trend3: prev3.messages > 0 ? (last3.messages - prev3.messages) / prev3.messages : 0,
    series: dayKeys(7).map((key) => ({ key, messages: days[key]?.messages ?? 0 })),
  };
}

function channelName(guild, channelId) {
  return guild.channels.cache.get(channelId)?.name ?? channelId;
}

export function healthReport(features, guild) {
  const analysis = analyseActivity(features, guild.id);
  const members = Math.max(1, guild.memberCount ?? guild.members.cache.size ?? 1);

  const activityScore = (() => {
    if (analysis.baseline <= 0) return analysis.last7.messages > 0 ? 18 : 8;
    const ratio = analysis.last3.messages / Math.max(1, analysis.prev3.messages);
    return Math.max(0, Math.min(30, Math.round(30 * Math.min(1, ratio / 1.1) * (analysis.last3.messages > 0 ? 1 : 0.35))));
  })();

  const participation = Math.min(
    30,
    Math.round((analysis.last7.authors.size / members) * 240),
  );

  const joinRetention = (() => {
    const config = configFor(features, guild.id);
    const recent = (config.joins ?? []).filter((join) => Date.now() - join.at <= 14 * DAY_MS);
    if (recent.length === 0) return 15;
    const stillHere = recent.filter((join) => guild.members.cache.has(join.userId)).length;
    return Math.round(20 * (stillHere / recent.length));
  })();

  const textChannels = [...guild.channels.cache.values()].filter(
    (channel) => channel.type === ChannelType.GuildText,
  );
  const activeChannels = analysis.last7.channels.size;
  const spread = Math.min(20, Math.round((activeChannels / Math.max(1, textChannels.length)) * 20));

  const score = Math.max(0, Math.min(100, activityScore + participation + joinRetention + spread));

  const attention = [];
  for (const channel of textChannels) {
    const recentCount = daysChannelCount(features, guild.id, channel.id, dayKeys(3));
    const previousCount = daysChannelCount(features, guild.id, channel.id, dayKeys(3, Date.now() - 3 * DAY_MS));
    if (previousCount >= 15 && recentCount === 0) {
      attention.push({
        channelId: channel.id,
        reason: `Had ${previousCount} messages three days ago, nothing since.`,
        severity: 'high',
      });
    } else if (previousCount >= 40 && recentCount < previousCount * 0.35) {
      attention.push({
        channelId: channel.id,
        reason: `Activity fell from ${previousCount} to ${recentCount} messages.`,
        severity: 'medium',
      });
    }
  }

  const dormant = textChannels.filter(
    (channel) => daysChannelCount(features, guild.id, channel.id, dayKeys(7)) === 0,
  );
  for (const channel of dormant.slice(0, 5)) {
    if (attention.some((entry) => entry.channelId === channel.id)) continue;
    attention.push({ channelId: channel.id, reason: 'No messages in the last 7 days.', severity: 'low' });
  }

  return {
    score,
    grade: score >= 80 ? 'Healthy' : score >= 60 ? 'Stable' : score >= 40 ? 'Needs attention' : 'At risk',
    components: { activity: activityScore, participation, retention: joinRetention, spread },
    analysis,
    attention: attention.slice(0, 10),
    dormant: dormant.length,
    textChannels: textChannels.length,
  };
}

function daysChannelCount(features, guildId, channelId, keys) {
  const days = activityFor(features, guildId).days ?? {};
  return keys.reduce((total, key) => total + (days[key]?.channels?.[channelId] ?? 0), 0);
}

/* ----------------------------------------------------------------- alerts --- */

function pushAlert(features, guild, alert) {
  const config = configFor(features, guild.id);
  config.alerts ??= [];
  config.alerts.unshift({ ...alert, id: Math.random().toString(36).slice(2, 8), at: Date.now() });
  if (config.alerts.length > 60) config.alerts = config.alerts.slice(0, 60);
  features.store.save();
  return config.alerts[0];
}

async function deliverAlert(features, guild, alert, { force = false } = {}) {
  const config = configFor(features, guild.id);
  if (!config.enabled) return;
  const last = config.lastAlertAt?.[alert.kind] ?? 0;
  if (!force && Date.now() - last < 6 * 3_600_000) return;
  config.lastAlertAt ??= {};
  config.lastAlertAt[alert.kind] = Date.now();
  pushAlert(features, guild, alert);
  if (!config.channelId) return;
  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  await channel
    .send({
      embeds: [
        embed(
          `🛡️ ${alert.title}`,
          `${alert.message}\n\n_Automated signal, not a confirmed incident. Review before acting._`,
          alert.severity === 'high' ? COLORS.urgent : COLORS.warn,
        ),
      ],
    })
    .catch(() => {});
}

export async function scanGuild(features, guild) {
  const config = configFor(features, guild.id);
  config.lastScanAt = Date.now();
  const analysis = analyseActivity(features, guild.id);
  const health = healthReport(features, guild);

  if (analysis.expectedToday >= 12 && analysis.today < analysis.expectedToday * 0.45) {
    await deliverAlert(features, guild, {
      kind: 'activity-drop',
      severity: 'high',
      title: 'Unusual activity drop',
      message: `Today has **${analysis.today}** messages so far, but the recent daily average suggests about **${Math.round(
        analysis.expectedToday,
      )}** by now. Check whether a channel is locked or the community is moving elsewhere.`,
    });
  } else if (analysis.trend3 <= -0.5 && analysis.prev3.messages >= 50) {
    await deliverAlert(features, guild, {
      kind: 'activity-drop',
      severity: 'medium',
      title: 'Conversation volume falling',
      message: `The last three days are **${Math.abs(Math.round(analysis.trend3 * 100))}%** below the previous three days.`,
    });
  }

  const joins = config.joins ?? [];
  const recentJoins = joins.filter((join) => Date.now() - join.at <= 10 * 60_000);
  const freshAccounts = recentJoins.filter((join) => join.at - join.accountCreatedAt <= 7 * DAY_MS);
  if (recentJoins.length >= 8 && freshAccounts.length / Math.max(1, recentJoins.length) >= 0.5) {
    await deliverAlert(
      features,
      guild,
      {
        kind: 'raid',
        severity: 'high',
        title: 'Possible raid pattern',
        message: `**${recentJoins.length}** accounts joined in the last 10 minutes and **${freshAccounts.length}** were created within the last week. Consider raising verification temporarily.`,
      },
      { force: true },
    );
  } else if (recentJoins.length >= 4 && freshAccounts.length >= 3) {
    await deliverAlert(features, guild, {
      kind: 'new-accounts',
      severity: 'medium',
      title: 'Suspicious join pattern',
      message: `${recentJoins.length} accounts joined recently and ${freshAccounts.length} are under a week old. No action is required yet — this is a pattern worth watching.`,
    });
  }

  for (const item of health.attention.filter((entry) => entry.severity === 'high').slice(0, 2)) {
    await deliverAlert(features, guild, {
      kind: `channel-${item.channelId}`,
      severity: 'medium',
      title: 'Channel needs attention',
      message: `<#${item.channelId}>: ${item.reason}`,
    });
  }

  features.store.save();
  return { analysis, health };
}

export async function startMonitor(features) {
  for (const guild of features.client?.guilds.cache.values() ?? []) {
    await scanGuild(features, guild).catch(() => {});
  }
}

/* ------------------------------------------------------------- alt signals --- */

export function altSignals(features, guild, member, { cohort = null } = {}) {
  const signals = [];
  if (!member?.user) return { score: 0, confidence: 'low', signals, summary: 'No member data.' };
  const now = Date.now();
  const ageDays = (now - member.user.createdTimestamp) / DAY_MS;

  if (ageDays < 7) signals.push({ label: `Account is only ${ageDays.toFixed(1)} days old`, weight: 3 });
  else if (ageDays < 30) signals.push({ label: `Account is ${Math.floor(ageDays)} days old`, weight: 2 });
  else if (ageDays < 90) signals.push({ label: `Account is ${Math.floor(ageDays)} days old`, weight: 1 });

  const avatar = member.user.avatar;
  if (!avatar) signals.push({ label: 'Uses the default Discord avatar', weight: 1 });

  if (member.roles?.cache && member.roles.cache.size <= 1) {
    signals.push({ label: 'Has no roles beyond @everyone', weight: 1 });
  }

  const joins = cohort ?? configFor(features, guild.id).joins ?? [];
  const mine = joins.find((join) => join.userId === member.id);
  const nearJoins = mine
    ? joins.filter(
        (join) =>
          join.userId !== member.id &&
          Math.abs(join.at - mine.at) <= 15 * 60_000 &&
          join.at - join.accountCreatedAt <= 30 * DAY_MS,
      )
    : [];
  if (nearJoins.length >= 2) {
    signals.push({
      label: `Joined with ${nearJoins.length} other new account(s) within 15 minutes`,
      weight: 2,
    });
  }

  let bestMatch = null;
  for (const other of guild.members.cache.values()) {
    if (other.id === member.id || other.user?.bot) continue;
    const similarity = similarName(member.user.username, other.user?.username ?? '');
    if (similarity >= 0.8 && (!bestMatch || similarity > bestMatch.similarity)) {
      bestMatch = { other, similarity };
    }
  }
  if (bestMatch) {
    signals.push({
      label: `Username is ${Math.round(bestMatch.similarity * 100)}% similar to ${bestMatch.other.user.username}`,
      weight: 2,
    });
  }

  const joinedDays = member.joinedTimestamp ? (now - member.joinedTimestamp) / DAY_MS : 0;
  if (joinedDays >= 3 && ageDays < 90) {
    signals.push({ label: 'Very new account with little history in the server', weight: 1 });
  }

  const score = signals.reduce((total, signal) => total + signal.weight, 0);
  const confidence = score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
  return {
    score,
    confidence,
    signals,
    summary:
      confidence === 'high'
        ? 'Several independent signals line up. Review manually; this is not proof of an alt.'
        : confidence === 'medium'
          ? 'Some signals line up. Could be a new member rather than an alt.'
          : 'No strong pattern. Most new members look like this.',
  };
}

function suspiciousRoster(features, guild) {
  const config = configFor(features, guild.id);
  const joins = config.joins ?? [];
  const since = Date.now() - 7 * DAY_MS;
  const userIds = new Set(
    joins.filter((join) => join.at >= since).map((join) => join.userId),
  );
  const results = [];
  for (const userId of userIds) {
    const member = guild.members.cache.get(userId);
    if (!member) continue;
    results.push({ member, ...altSignals(features, guild, member) });
  }
  return results.sort((a, b) => b.score - a.score);
}

/* ----------------------------------------------------------------- command --- */

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('intel')
      .setDescription('Server behaviour intelligence, community health and alt-account signals')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('overview').setDescription('Activity trend and unusual behaviour'))
      .addSubcommand((sub) => sub.setName('health').setDescription('Community health score and channels needing attention'))
      .addSubcommand((sub) => sub.setName('alerts').setDescription('Recent intelligence alerts'))
      .addSubcommand((sub) =>
        sub
          .setName('alts')
          .setDescription('Score suspicious account patterns')
          .addUserOption((option) => option.setName('user').setDescription('Inspect one member').setRequired(false)),
      )
      .addSubcommand((sub) => sub.setName('scan').setDescription('Run an intelligence scan now'))
      .addSubcommand((sub) =>
        sub
          .setName('watch')
          .setDescription('Choose where alerts are posted')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Alert channel').setRequired(true).addChannelTypes(0),
          )
          .addBooleanOption((option) => option.setName('enabled').setDescription('Turn monitoring on or off').setRequired(false)),
      ),

    async execute(interaction, { features }) {
      const guild = interaction.guild;
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      const config = configFor(features, guild.id);

      if (subcommand === 'watch') {
        config.channelId = interaction.options.getChannel('channel', true).id;
        config.enabled = interaction.options.getBoolean('enabled') ?? true;
        features.store.save();
        await interaction.reply({
          embeds: [
            embed(
              'Intelligence alerts',
              `Alerts are **${config.enabled ? 'on' : 'off'}** and post to <#${config.channelId}>.\nAegis checks activity, join patterns and channel health every 30 minutes.`,
              COLORS.on,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'scan') {
        await interaction.deferReply({ flags: 64 });
        const { health } = await scanGuild(features, guild);
        await interaction.editReply({
          embeds: [
            embed(
              'Scan complete',
              `Health score **${health.score}/100** (${health.grade}). ${health.attention.length} channel(s) need attention.`,
              COLORS.on,
            ),
          ],
        });
        return;
      }

      if (subcommand === 'alerts') {
        const alerts = (config.alerts ?? []).slice(0, 10);
        await interaction.reply({
          embeds: [
            embed(
              'Recent intelligence alerts',
              alerts.length
                ? alerts
                    .map(
                      (alert) =>
                        `${alert.severity === 'high' ? '🔴' : '🟠'} **${alert.title}** · ${relative(alert.at)}\n${truncate(alert.message, 300)}`,
                    )
                    .join('\n\n')
                : 'No alerts yet. Aegis is still building an activity baseline.',
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'alts') {
        const user = interaction.options.getUser('user');
        if (user) {
          const member = guild.members.cache.get(user.id) ?? (await guild.members.fetch(user.id).catch(() => null));
          if (!member) {
            await interaction.reply({ embeds: [embed('Not in the server', 'That user is not a member here.', COLORS.off)], flags: 64 });
            return;
          }
          const result = altSignals(features, guild, member);
          await interaction.reply({
            embeds: [
              embed(
                `Alt-account signals · ${user.username}`,
                [
                  `**Score:** ${result.score} · **Confidence:** ${result.confidence}`,
                  result.summary,
                  '',
                  result.signals.length
                    ? result.signals.map((signal) => `• ${signal.label} (+${signal.weight})`).join('\n')
                    : '• No notable signals found.',
                  '',
                  '_Signals are heuristics, not accusations. Never moderate on one signal alone._',
                ].join('\n'),
                result.confidence === 'high' ? COLORS.urgent : result.confidence === 'medium' ? COLORS.warn : COLORS.brand,
              ),
            ],
            flags: 64,
          });
          return;
        }

        await interaction.deferReply({ flags: 64 });
        if (guild.members.cache.size < guild.memberCount) {
          await guild.members.fetch().catch(() => {});
        }
        const roster = suspiciousRoster(features, guild).slice(0, 6);
        await interaction.editReply({
          embeds: [
            embed(
              'Suspicious account patterns',
              roster.length
                ? roster
                    .map((entry) => {
                      const top = entry.signals.slice(0, 3).map((signal) => signal.label).join('; ');
                      return `<@${entry.member.id}> · score **${entry.score}** (${entry.confidence})\n${truncate(top || 'No signals', 260)}`;
                    })
                    .join('\n\n') +
                  '\n\n_Signals are heuristics. Review context before acting._'
                : 'No recent joins show a suspicious pattern.',
              COLORS.brand,
            ),
          ],
        });
        return;
      }

      if (subcommand === 'health') {
        const report = healthReport(features, guild);
        const analysis = report.analysis;
        await interaction.reply({
          embeds: [
            embed(
              `Community health · ${report.score}/100`,
              [
                `**${report.grade}**`,
                `Activity ${bar(report.components.activity, 30)} ${report.components.activity}/30`,
                `Participation ${bar(report.components.participation, 30)} ${report.components.participation}/30`,
                `Retention ${bar(report.components.retention, 20)} ${report.components.retention}/20`,
                `Channel spread ${bar(report.components.spread, 20)} ${report.components.spread}/20`,
                '',
                `**Unique authors (7d):** ${analysis.last7.authors.size}`,
                `**Messages (7d):** ${number(analysis.last7.messages)} (${analysis.trend >= 0 ? '+' : ''}${Math.round(
                  analysis.trend * 100,
                )}% vs previous week)`,
                `**Joins / leaves (7d):** ${analysis.last7.joins} / ${analysis.last7.leaves}`,
                `**Dormant text channels:** ${report.dormant} of ${report.textChannels}`,
                report.attention.length
                  ? `\n**Needs attention**\n${report.attention
                      .map((entry) => `• <#${entry.channelId}> — ${entry.reason}`)
                      .join('\n')}`
                  : '\nNo channel needs attention right now.',
              ].join('\n'),
              report.score >= 70 ? COLORS.on : report.score >= 45 ? COLORS.warn : COLORS.off,
            ),
          ],
          flags: 64,
        });
        return;
      }

      const analysis = analyseActivity(features, guild.id);
      const peak = Math.max(1, ...analysis.series.map((entry) => entry.messages));
      const hourTotal = analysis.last7.hours.reduce((total, value) => total + value, 0);
      const maxHour = hourTotal > 0 ? analysis.last7.hours.indexOf(Math.max(...analysis.last7.hours)) : -1;
      await interaction.reply({
        embeds: [
          embed(
            'Server intelligence',
            [
              `**Today:** ${number(analysis.today)} messages · average by now ≈ ${Math.round(analysis.expectedToday)}`,
              `**Last 7 days:** ${number(analysis.last7.messages)} messages (${analysis.trend >= 0 ? '+' : ''}${Math.round(
                analysis.trend * 100,
              )}% vs the week before)`,
              `**Unique authors (7d):** ${analysis.last7.authors.size}`,
              `**Joins / leaves (7d):** ${analysis.last7.joins} / ${analysis.last7.leaves}`,
              `**Peak hour (UTC):** ${maxHour === -1 ? '—' : `${String(maxHour).padStart(2, '0')}:00`}`,
              '',
              '**Last 7 days**',
              analysis.series
                .map((entry) => `\`${entry.key.slice(5)}\` ${bar(entry.messages, peak, 8)} ${entry.messages}`)
                .join('\n'),
              '',
              `**Baseline:** ${Math.round(analysis.baseline)} messages/day`,
              `**Alerts on record:** ${(config.alerts ?? []).length}`,
              '',
              config.channelId ? `Alerts post in <#${config.channelId}>.` : 'Set an alert channel with `/intel watch`.',
            ].join('\n'),
            analysis.trend < -0.35 ? COLORS.warn : COLORS.brand,
          ),
        ],
        flags: 64,
      });
    },
  },
];
