import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, canManageGuild, embed, formatDuration, randomId, truncate } from './util.js';
import { analyseActivity, healthReport } from './intel.js';
import { staffSnapshot } from './staff.js';

const TONES = [
  { name: 'Professional', value: 'professional' },
  { name: 'Friendly', value: 'friendly' },
  { name: 'Excited', value: 'excited' },
  { name: 'Serious', value: 'serious' },
  { name: 'Casual', value: 'casual' },
];

function aiSettings() {
  return {
    key: (process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '').trim(),
    baseUrl: (process.env.AI_BASE_URL || 'https://freebuff.com/api/v1/paid').replace(/\/+$/, ''),
    model: (process.env.AI_MODEL || 'gpt-4o-mini').trim(),
  };
}

export function aiConfigured() {
  return Boolean(aiSettings().key);
}

export async function askModel(system, prompt, { maxTokens = 700, temperature = 0.7 } = {}) {
  const settings = aiSettings();
  if (!settings.key) return { ok: false, reason: 'no-key' };
  try {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok) {
      return { ok: false, reason: `The AI service returned ${response.status}.` };
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: false, reason: 'The AI service returned an empty reply.' };
    return { ok: true, content };
  } catch (error) {
    return { ok: false, reason: `AI request failed: ${error.message}` };
  }
}

function splitDraft(content, fallbackTitle) {
  const lines = String(content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, array) => line.length > 0 || (index > 0 && index < array.length - 1));
  const first = lines[0] ?? '';
  if (first.length <= 100 && !/[.!?]$/.test(first)) {
    return { title: first.replace(/^#+\s*/, ''), body: lines.slice(1).join('\n').trim() };
  }
  return { title: fallbackTitle, body: lines.join('\n').trim() };
}

function localAnnouncement(topic, tone) {
  const intros = {
    professional: 'We have an update for the community.',
    friendly: 'Hey everyone — quick update for you!',
    excited: "Big news — you're going to love this!",
    serious: 'Please take a moment to read this update.',
    casual: 'Quick heads-up for everyone:',
  };
  const closes = {
    professional: 'Thank you for your continued support.',
    friendly: 'Thanks for being here — see you in the chats!',
    excited: 'Jump in and let us know what you think!',
    serious: 'Thank you for your cooperation.',
    casual: 'That is all — carry on!',
  };
  const body = String(topic ?? '').trim();
  return {
    title: body.length <= 70 ? body : 'Community update',
    body: `${intros[tone] ?? intros.friendly}\n\n${body}\n\n${closes[tone] ?? closes.friendly}`,
    generated: false,
  };
}

async function writeAnnouncement({ topic, tone, guildName }) {
  const result = await askModel(
    'You write Discord community announcements. Reply with a short headline on the first line (under 90 characters, no markdown heading), then a blank line, then the announcement body. Use markdown sparingly, keep it under 900 characters, never invent dates, links, prizes or facts that were not given. Do not wrap the reply in quotes.',
    `Server: ${guildName}\nTone: ${tone}\nInstructions: ${topic}`,
    { maxTokens: 500, temperature: 0.8 },
  );
  if (!result.ok) {
    return { ...localAnnouncement(topic, tone), note: result.reason };
  }
  const parsed = splitDraft(result.content, 'Community announcement');
  return {
    title: parsed.title || 'Community announcement',
    body: parsed.body || result.content,
    generated: true,
    note: null,
  };
}

function reportData(features, guild) {
  const analysis = analyseActivity(features, guild.id);
  const health = healthReport(features, guild);
  const staffConfig = features.store.guild(guild.id).staff;
  const staffRows = Object.keys(staffConfig.members ?? {})
    .map((userId) => staffSnapshot(features, guild.id, userId, guild.members.cache.get(userId)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const tickets = features.store.guild(guild.id).tickets;
  const closedThisWeek = Object.values(tickets.closed ?? {}).filter(
    (record) => Date.now() - (record.closedAt ?? 0) <= 7 * 86_400_000,
  ).length;
  const topChannels = [...analysis.last7.channels.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([channelId, count]) => ({ name: guild.channels.cache.get(channelId)?.name ?? channelId, count }));
  return { analysis, health, staffRows, closedThisWeek, topChannels };
}

function localReport(guild, data) {
  const { analysis, health, staffRows, closedThisWeek, topChannels } = data;
  return [
    `**Health score:** ${health.score}/100 (${health.grade})`,
    `**Messages:** ${analysis.last7.messages.toLocaleString('en-US')} this week (${
      analysis.trend >= 0 ? '+' : ''
    }${Math.round(analysis.trend * 100)}% vs the week before)`,
    `**Unique authors:** ${analysis.last7.authors.size}`,
    `**Joins / leaves:** ${analysis.last7.joins} / ${analysis.last7.leaves}`,
    `**Tickets closed:** ${closedThisWeek}`,
    '',
    topChannels.length
      ? `**Busiest channels**\n${topChannels.map((entry) => `• #${entry.name} — ${entry.count}`).join('\n')}`
      : '**Busiest channels**\nNo channel activity recorded yet.',
    '',
    staffRows.length
      ? `**Top staff**\n${staffRows
          .map((row) => `• <@${row.userId}> — ${row.messages} messages, ${row.tickets.closed} tickets`)
          .join('\n')}`
      : '**Top staff**\nNo staff activity tracked yet.',
    '',
    health.attention.length
      ? `**Needs attention**\n${health.attention.slice(0, 4).map((entry) => `• #${guild.channels.cache.get(entry.channelId)?.name ?? entry.channelId} — ${entry.reason}`).join('\n')}`
      : '**Needs attention**\nNo channel needs attention right now.',
  ].join('\n');
}

async function writeReport(features, guild) {
  const data = reportData(features, guild);
  const local = localReport(guild, data);
  const result = await askModel(
    'You are a community analyst writing a concise weekly Discord server report for the moderators. Use the supplied numbers exactly; never invent statistics. Structure: a two-sentence summary, then "What went well", "What needs attention", and one concrete recommendation. Markdown bullet points, under 1600 characters. Be measured, not alarmist.',
    `Server: ${guild.name}\nMembers: ${guild.memberCount}\nStats:\n${local}`,
    { maxTokens: 700, temperature: 0.5 },
  );
  return {
    content: result.ok ? result.content : local,
    generated: result.ok,
    note: result.ok ? null : result.reason,
    data,
  };
}

function previewPayload(draft, pending) {
  const built = embed(draft.title, draft.body, COLORS.brand);
  built.setFooter({
    text: pending.generated
      ? 'AI draft · review before sending'
      : 'Local draft · add an AI key for richer writing',
  });
  if (pending.image) built.setImage(pending.image);
  return {
    embeds: [built],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ai:send:${pending.id}`).setLabel('Send announcement').setStyle(ButtonStyle.Success).setEmoji('📣'),
        new ButtonBuilder().setCustomId(`ai:regen:${pending.id}`).setLabel('Regenerate').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
        new ButtonBuilder().setCustomId(`ai:cancel:${pending.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

export async function handleAiComponent(features, interaction) {
  const [prefix, action, id] = interaction.customId.split(':');
  if (prefix !== 'ai') return false;

  const pending = features.pendingAnnouncements?.get(id);
  if (!pending) {
    await interaction.reply({ embeds: [embed('Draft expired', 'Run `/announce` again to create a new draft.', COLORS.off)], flags: 64 });
    return true;
  }
  if (pending.userId !== interaction.user.id) {
    await interaction.reply({ embeds: [embed('Not your draft', 'Only the person who asked for this draft can use it.', COLORS.off)], flags: 64 });
    return true;
  }

  if (action === 'cancel') {
    features.pendingAnnouncements.delete(id);
    await interaction.update({ embeds: [embed('Draft discarded', 'Nothing was posted.', COLORS.muted)], components: [] });
    return true;
  }

  if (action === 'regen') {
    await interaction.deferUpdate();
    const draft = await writeAnnouncement(pending);
    pending.draft = draft;
    pending.generated = draft.generated;
    await interaction.editReply(previewPayload(draft, pending));
    return true;
  }

  if (action === 'send') {
    const channel = await interaction.guild.channels.fetch(pending.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      await interaction.reply({ embeds: [embed('Channel missing', 'That channel no longer exists.', COLORS.off)], flags: 64 });
      return true;
    }
    const built = embed(pending.draft.title, pending.draft.body, COLORS.brand);
    if (pending.image) built.setImage(pending.image);
    built.setFooter({ text: `Announcement by ${interaction.user.username}` });
    const content = pending.pingRoleId ? `<@&${pending.pingRoleId}>` : undefined;
    try {
      await channel.send({
        content,
        embeds: [built],
        allowedMentions: pending.pingRoleId ? { roles: [pending.pingRoleId] } : { parse: [] },
      });
      features.pendingAnnouncements.delete(id);
      await interaction.update({
        embeds: [embed('Announcement posted', `It is live in <#${channel.id}>.`, COLORS.on)],
        components: [],
      });
      features.bot?.log('info', `[${interaction.guild.name}] Announcement posted in #${channel.name}.`);
    } catch (error) {
      await interaction.reply({ embeds: [embed('Could not post', error.message, COLORS.off)], flags: 64 });
    }
    return true;
  }

  return false;
}

export async function postWeeklyReport(features, guild, channel, { manual = false } = {}) {
  const report = await writeReport(features, guild);
  const built = embed(manual ? 'Server report' : '📊 Weekly server report', report.content, COLORS.brand);
  built.setFooter({ text: report.generated ? 'AI-generated from real server metrics' : 'Generated from real server metrics' });
  const message = await channel.send({ embeds: [built] });
  const config = features.store.guild(guild.id).ai;
  config.lastReportAt = Date.now();
  features.store.save();
  return { message, report };
}

export async function sweepAiReports(features) {
  const week = 7 * 86_400_000;
  for (const guild of features.client?.guilds.cache.values() ?? []) {
    const config = features.store.guild(guild.id).ai;
    if (!config.reportChannelId) continue;
    if (Date.now() - (config.lastReportAt ?? 0) < week) continue;
    const channel = await guild.channels.fetch(config.reportChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    await postWeeklyReport(features, guild, channel).catch(() => {});
  }
}

/* ----------------------------------------------------------------- command --- */

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('announce')
      .setDescription('Write a professional announcement with AI')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((option) =>
        option.setName('channel').setDescription('Where to post it').setRequired(true).addChannelTypes(0),
      )
      .addStringOption((option) =>
        option.setName('topic').setDescription('What is the announcement about?').setRequired(true).setMaxLength(1000),
      )
      .addStringOption((option) =>
        option
          .setName('tone')
          .setDescription('Writing tone')
          .setRequired(false)
          .addChoices(...TONES),
      )
      .addRoleOption((option) => option.setName('ping-role').setDescription('Role to ping when posted').setRequired(false))
      .addStringOption((option) =>
        option.setName('image').setDescription('Optional image URL').setRequired(false).setMaxLength(500),
      ),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      const channel = interaction.options.getChannel('channel', true);
      const topic = interaction.options.getString('topic', true);
      const tone = interaction.options.getString('tone') ?? 'friendly';
      const image = interaction.options.getString('image');

      if (image && !/^https?:\/\//i.test(image)) {
        await interaction.reply({ embeds: [embed('Bad image link', 'The image must be an https URL.', COLORS.off)], flags: 64 });
        return;
      }

      await interaction.deferReply({ flags: 64 });
      const draft = await writeAnnouncement({ topic, tone, guildName: interaction.guild.name });
      const id = randomId(8);
      const pending = {
        id,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: channel.id,
        pingRoleId: interaction.options.getRole('ping-role')?.id ?? null,
        image: image ?? null,
        topic,
        tone,
        draft,
        generated: draft.generated,
      };
      features.pendingAnnouncements ??= new Map();
      features.pendingAnnouncements.set(id, pending);
      if (features.pendingAnnouncements.size > 50) {
        const oldest = features.pendingAnnouncements.keys().next().value;
        features.pendingAnnouncements.delete(oldest);
      }

      await interaction.editReply(previewPayload(draft, pending));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('report')
      .setDescription('AI activity reports for your server')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('now')
          .setDescription('Generate a report right now')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Where to post it').setRequired(false).addChannelTypes(0),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('schedule')
          .setDescription('Post a report automatically every week')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Report channel').setRequired(true).addChannelTypes(0),
          ),
      )
      .addSubcommand((sub) => sub.setName('status').setDescription('Show report settings')),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      const guild = interaction.guild;
      const config = features.store.guild(guild.id).ai;
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'schedule') {
        config.reportChannelId = interaction.options.getChannel('channel', true).id;
        config.lastReportAt = Date.now();
        features.store.save();
        await interaction.reply({
          embeds: [
            embed(
              'Weekly report scheduled',
              `A report is posted in <#${config.reportChannelId}> every 7 days, built from real activity, health and staff data.`,
              COLORS.on,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'status') {
        await interaction.reply({
          embeds: [
            embed(
              'Report settings',
              [
                `**Channel:** ${config.reportChannelId ? `<#${config.reportChannelId}>` : '_not scheduled_'}`,
                `**Last report:** ${config.lastReportAt ? `<t:${Math.floor(config.lastReportAt / 1000)}:R>` : 'never'}`,
                `**AI writing:** ${aiConfigured() ? 'configured' : 'not configured — local reports are used'}`,
                '',
                aiConfigured()
                  ? '_Reports use your AI key from the host runner environment._'
                  : '_Set `OPENAI_API_KEY` (or `AI_API_KEY`) on the host runner to enable AI narration._',
              ].join('\n'),
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      await interaction.deferReply({ flags: 64 });
      try {
        await postWeeklyReport(features, guild, channel, { manual: true });
        await interaction.editReply({
          embeds: [embed('Report posted', `It is live in <#${channel.id}>.`, COLORS.on)],
        });
      } catch (error) {
        await interaction.editReply({ embeds: [embed('Report failed', error.message, COLORS.off)] });
      }
    },
  },
];
