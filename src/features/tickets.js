import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  COLORS,
  canManageGuild,
  embed,
  formatDuration,
  isStaffMember,
  relative,
  truncate,
} from './util.js';

export const PRIORITIES = {
  low: { label: 'Low', emoji: '🟢', color: COLORS.on },
  normal: { label: 'Normal', emoji: '🔵', color: COLORS.ticket },
  high: { label: 'High', emoji: '🟠', color: COLORS.warn },
  urgent: { label: 'Urgent', emoji: '🔴', color: COLORS.urgent },
};

function priorityOf(value) {
  return PRIORITIES[value] ?? PRIORITIES.normal;
}

function findCategory(config, categoryId) {
  return config.categories.find((category) => category.id === categoryId) ?? null;
}

function staffStat(config, userId) {
  if (!config.staff[userId]) {
    config.staff[userId] = {
      claimed: 0,
      closed: 0,
      responses: 0,
      responseTotal: 0,
      messages: 0,
    };
  }
  return config.staff[userId];
}

function ticketEmbed(record, category, guild, client) {
  const priority = priorityOf(record.priority);
  const built = embed(
    `${category?.emoji ?? '🎫'} ${category?.name ?? 'Support ticket'} · #${record.number}`,
    [
      `**Opened by:** <@${record.userId}>`,
      `**Category:** ${category?.name ?? 'General'}`,
      `**Priority:** ${priority.emoji} ${priority.label}`,
      `**Claimed by:** ${record.claimedBy ? `<@${record.claimedBy}>` : '_Unclaimed_'}`,
      `**Opened:** ${relative(record.createdAt)}`,
      '',
      category?.description || 'A staff member will be with you shortly. Describe your issue below.',
    ].join('\n'),
    priority.color,
  );
  built.setFooter({ text: `Ticket #${record.number} · ${guild.name}` });
  if (client?.user) built.setTimestamp();
  return built;
}

function ticketRows(record) {
  const priorities = new StringSelectMenuBuilder()
    .setCustomId(`tk:setpriority:${record.channelId}`)
    .setPlaceholder('Set priority')
    .addOptions(
      Object.entries(PRIORITIES).map(([value, meta]) => ({
        label: meta.label,
        value,
        emoji: meta.emoji,
        default: value === record.priority,
      })),
    );

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tk:claim:${record.channelId}`)
      .setLabel(record.claimedBy ? 'Unclaim' : 'Claim')
      .setStyle(record.claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setEmoji('🙋'),
    new ButtonBuilder()
      .setCustomId(`tk:transcript:${record.channelId}`)
      .setLabel('Transcript')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📄'),
    new ButtonBuilder()
      .setCustomId(`tk:close:${record.channelId}`)
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );

  return [new ActionRowBuilder().addComponents(priorities), actions];
}

function panelPayload(config) {
  const categories = config.categories;
  const built = embed(
    '🎫 Support tickets',
    [
      'Need help? Open a ticket and a staff member will pick it up.',
      '',
      ...categories.map((category) => `${category.emoji || '🎫'} **${category.name}** — ${category.description || 'Open a ticket'}`),
      '',
      'You can only have one open ticket at a time.',
    ].join('\n'),
    COLORS.ticket,
  );

  const rows = [];
  if (categories.length === 1) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`tk:open:${categories[0].id}`)
          .setLabel(`Open a ticket`)
          .setEmoji(categories[0].emoji || '🎫')
          .setStyle(ButtonStyle.Primary),
      ),
    );
  } else if (categories.length > 1) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('tk:select')
      .setPlaceholder('Choose a ticket category')
      .addOptions(
        categories.slice(0, 25).map((category) => ({
          label: category.name.slice(0, 100),
          value: category.id,
          description: (category.description || 'Open a ticket').slice(0, 100),
          emoji: category.emoji || '🎫',
        })),
      );
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  return { embeds: [built], components: rows };
}

async function postPanel(features, guild, config) {
  const channel = await guild.channels.fetch(config.panelChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('The ticket panel channel no longer exists.');
  if (config.panelMessageId) {
    const previous = await channel.messages.fetch(config.panelMessageId).catch(() => null);
    await previous?.delete().catch(() => {});
  }
  const message = await channel.send(panelPayload(config));
  config.panelMessageId = message.id;
  features.store.save();
  return message;
}

function openTicketsFor(config, userId) {
  return Object.values(config.open).filter((record) => record.userId === userId && !record.closedAt);
}

export async function createTicket(features, guild, member, categoryId) {
  const config = features.store.guild(guild.id).tickets;
  const category = findCategory(config, categoryId);
  if (!category) throw new Error('That ticket category no longer exists.');

  const existing = openTicketsFor(config, member.id)[0];
  if (existing) {
    const channel = guild.channels.cache.get(existing.channelId);
    throw new Error(`You already have an open ticket${channel ? ` in <#${existing.channelId}>` : ''}.`);
  }

  const everyone = guild.roles.everyone;
  const botId = features.client.user.id;
  const supportRoles = [...new Set([...(category.supportRoleIds ?? []), ...(config.supportRoleIds ?? [])])];
  const overwrites = [
    {
      id: everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    ...supportRoles.map((roleId) => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    })),
  ];

  config.counter = (config.counter ?? 0) + 1;
  const number = config.counter;
  const channel = await guild.channels.create({
    name: `ticket-${String(number).padStart(4, '0')}-${member.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: config.categoryChannelId || undefined,
    topic: `Aegis ticket #${number} · opener:${member.id} · category:${category.id}`,
    permissionOverwrites: overwrites,
    reason: `Ticket #${number} opened by ${member.user.tag}`,
  });

  const record = {
    channelId: channel.id,
    number,
    userId: member.id,
    userTag: member.user.tag,
    categoryId: category.id,
    priority: category.priority ?? 'normal',
    claimedBy: null,
    createdAt: Date.now(),
    firstResponseAt: null,
    closedAt: null,
    transcript: null,
    staffMessages: {},
  };
  config.open[channel.id] = record;
  features.store.save();

  const ping = [...new Set([...(category.pingRoleIds ?? []), ...supportRoles])]
    .map((roleId) => `<@&${roleId}>`)
    .join(' ');
  const panel = await channel.send({
    content: `<@${member.id}>${ping ? ` ${ping}` : ''}`,
    embeds: [ticketEmbed(record, category, guild, features.client)],
    components: ticketRows(record),
  });
  record.panelMessageId = panel.id;
  features.store.save();

  return { channel, record, category };
}

async function buildTranscript(features, channel, record) {
  const messages = [];
  let before;
  for (let page = 0; page < 10; page += 1) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const escape = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const rows = messages
    .map((message) => {
      const attachments = [...message.attachments.values()]
        .map((attachment) => `<a href="${escape(attachment.url)}">${escape(attachment.name)}</a>`)
        .join(' ');
      return `<article><header><strong>${escape(message.author?.tag ?? 'unknown')}</strong> <time>${new Date(
        message.createdTimestamp,
      ).toISOString()}</time></header><p>${escape(message.content || '(no text)').replace(/\n/g, '<br>')}</p>${
        attachments ? `<p>${attachments}</p>` : ''
      }</article>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Ticket #${record.number} transcript - ${escape(channel.guild.name)}</title>
<style>
body{background:#0b1020;color:#dbe4ff;font:15px/1.5 system-ui,Segoe UI,sans-serif;max-width:900px;margin:32px auto;padding:0 16px}
h1{font-size:22px}article{background:#141b33;border:1px solid #223059;border-radius:10px;padding:12px 14px;margin:10px 0}
header{display:flex;gap:12px;align-items:baseline;color:#8fa6d8;font-size:12px}strong{color:#7fe7c4;font-size:14px}
p{margin:6px 0 0;white-space:normal}a{color:#7fb4ff}
</style></head><body>
<h1>Ticket #${record.number} · ${escape(channel.guild.name)}</h1>
<p>Opened by ${escape(record.userTag ?? record.userId)} · Closed ${new Date().toISOString()} · ${messages.length} messages</p>
${rows}
</body></html>`;

  const dir = path.join(features.dataDir, 'transcripts');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${channel.guild.id}-ticket-${record.number}-${Date.now()}.html`);
  await writeFile(filePath, html, 'utf8');
  return {
    filePath,
    attachment: new AttachmentBuilder(Buffer.from(html), {
      name: `ticket-${record.number}-transcript.html`,
    }),
    count: messages.length,
  };
}

export async function closeTicket(features, guild, channel, closedBy) {
  const config = features.store.guild(guild.id).tickets;
  const record = config.open[channel.id];
  if (!record) throw new Error('This channel is not an open ticket.');
  if (record.closedAt) throw new Error('This ticket is already closed.');

  record.closedAt = Date.now();
  record.closedBy = closedBy.id;

  const transcript = await buildTranscript(features, channel, record).catch((error) => {
    features.bot?.log('warn', `Transcript failed: ${error.message}`);
    return null;
  });
  record.transcript = transcript?.filePath ?? null;

  if (transcript && config.transcriptChannelId) {
    const logChannel = await guild.channels.fetch(config.transcriptChannelId).catch(() => null);
    if (logChannel?.isTextBased?.()) {
      await logChannel
        .send({
          embeds: [
            embed(
              `Ticket #${record.number} closed`,
              `Closed by <@${closedBy.id}> · ${transcript.count} messages\n<@${record.userId}> opened it ${relative(record.createdAt)}.`,
              COLORS.muted,
            ),
          ],
          files: [transcript.attachment],
        })
        .catch(() => {});
    }
  }

  if (closedBy.id !== record.userId) {
    const stat = staffStat(config, closedBy.id);
    stat.closed += 1;
  }

  delete config.open[channel.id];
  config.closed[channel.id] = record;
  const closedIds = Object.keys(config.closed);
  if (closedIds.length > 200) {
    for (const id of closedIds.slice(0, closedIds.length - 200)) delete config.closed[id];
  }
  features.store.save();

  await channel
    .send({
      embeds: [
        embed(
          'Ticket closed',
          `Closed by <@${closedBy.id}>. A transcript was saved${transcript ? ' and sent to the transcript channel' : ''}. This channel is removed in a few seconds.`,
          COLORS.muted,
        ),
      ],
      files: transcript ? [transcript.attachment] : [],
    })
    .catch(() => {});
  setTimeout(() => channel.delete(`Ticket closed by ${closedBy.tag}`).catch(() => {}), 6000).unref?.();
  return { record, transcript };
}

export async function handleTicketComponent(features, interaction) {
  if (!interaction.guildId) return false;
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'tk') return false;

  const guild = interaction.guild;
  const config = features.store.guild(guild.id).tickets;
  const action = parts[1];

  if (action === 'open' || action === 'select') {
    const categoryId = action === 'open' ? parts[2] : interaction.values?.[0];
    try {
      const { channel } = await createTicket(features, guild, interaction.member, categoryId);
      await interaction.reply({
        embeds: [embed('Ticket opened', `Your ticket is ready in <#${channel.id}>.`, COLORS.on)],
        flags: 64,
      });
    } catch (error) {
      await interaction.reply({ embeds: [embed('Cannot open a ticket', error.message, COLORS.off)], flags: 64 });
    }
    return true;
  }

  const channelId = parts[2] ?? interaction.channelId;
  const record = config.open[channelId];
  if (!record) {
    await interaction.reply({
      embeds: [embed('Ticket not found', 'This ticket is already closed or was deleted.', COLORS.off)],
      flags: 64,
    });
    return true;
  }
  const category = findCategory(config, record.categoryId);
  const supportRoleIds = [...new Set([...(category?.supportRoleIds ?? []), ...(config.supportRoleIds ?? [])])];
  const staff = isStaffMember(interaction.member, supportRoleIds);

  if (action === 'claim') {
    if (!staff) {
      await interaction.reply({ embeds: [embed('Staff only', 'Only support staff can claim tickets.', COLORS.off)], flags: 64 });
      return true;
    }
    if (record.claimedBy && record.claimedBy !== interaction.user.id && !canManageGuild(interaction.member)) {
      await interaction.reply({
        embeds: [embed('Already claimed', `This ticket is claimed by <@${record.claimedBy}>.`, COLORS.warn)],
        flags: 64,
      });
      return true;
    }
    if (record.claimedBy === interaction.user.id) {
      record.claimedBy = null;
    } else {
      record.claimedBy = interaction.user.id;
      const stat = staffStat(config, interaction.user.id);
      stat.claimed += 1;
    }
    features.store.save();
    const channel = guild.channels.cache.get(channelId);
    await interaction.update({
      embeds: [ticketEmbed(record, category, guild, features.client)],
      components: ticketRows(record),
    });
    await channel?.send({
      embeds: [
        embed(
          record.claimedBy ? 'Ticket claimed' : 'Ticket released',
          record.claimedBy ? `<@${record.claimedBy}> is handling this.` : 'This ticket is unclaimed again.',
          record.claimedBy ? COLORS.on : COLORS.muted,
        ),
      ],
    });
    return true;
  }

  if (action === 'setpriority') {
    if (!staff) {
      await interaction.reply({ embeds: [embed('Staff only', 'Only support staff can change priority.', COLORS.off)], flags: 64 });
      return true;
    }
    const value = interaction.values?.[0];
    if (!PRIORITIES[value]) {
      await interaction.reply({ embeds: [embed('Unknown priority', 'Pick low, normal, high or urgent.', COLORS.off)], flags: 64 });
      return true;
    }
    record.priority = value;
    features.store.save();
    await interaction.update({
      embeds: [ticketEmbed(record, category, guild, features.client)],
      components: ticketRows(record),
    });
    return true;
  }

  if (action === 'close') {
    await interaction.reply({
      embeds: [
        embed(
          'Close this ticket?',
          'A transcript is generated and the channel is deleted. This cannot be undone.',
          COLORS.warn,
        ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`tk:closeconfirm:${channelId}`)
            .setLabel('Close ticket')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`tk:cancel:${channelId}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
      flags: 64,
    });
    return true;
  }

  if (action === 'closeconfirm') {
    if (!staff && record.userId !== interaction.user.id) {
      await interaction.reply({ embeds: [embed('Not allowed', 'Only the opener or staff can close this ticket.', COLORS.off)], flags: 64 });
      return true;
    }
    await interaction.update({ embeds: [embed('Closing…', 'Generating the transcript.', COLORS.muted)], components: [] });
    try {
      await closeTicket(features, guild, interaction.channel, interaction.user);
    } catch (error) {
      await interaction.followUp({ embeds: [embed('Could not close', error.message, COLORS.off)], flags: 64 });
    }
    return true;
  }

  if (action === 'cancel') {
    await interaction.update({ embeds: [embed('Cancelled', 'The ticket stays open.', COLORS.muted)], components: [] });
    return true;
  }

  if (action === 'transcript') {
    if (!staff && record.userId !== interaction.user.id) {
      await interaction.reply({ embeds: [embed('Not allowed', 'Only the opener or staff can download the transcript.', COLORS.off)], flags: 64 });
      return true;
    }
    await interaction.deferReply({ flags: 64 });
    const transcript = await buildTranscript(features, interaction.channel, {
      ...record,
      userTag: interaction.user.tag,
    });
    await interaction.editReply({
      embeds: [embed('Transcript ready', `${transcript.count} messages captured.`, COLORS.on)],
      files: [transcript.attachment],
    });
    return true;
  }

  return false;
}

export function trackTicketMessage(features, message) {
  if (!message.guild || message.author?.bot) return;
  const config = features.store.guild(message.guild.id).tickets;
  const record = config.open[message.channelId];
  if (!record || record.closedAt) return;
  if (message.author.id === record.userId) return;

  const category = findCategory(config, record.categoryId);
  const supportRoleIds = [...new Set([...(category?.supportRoleIds ?? []), ...(config.supportRoleIds ?? [])])];
  if (!isStaffMember(message.member, supportRoleIds)) return;

  const stat = staffStat(config, message.author.id);
  stat.messages += 1;
  if (!record.firstResponseAt) {
    record.firstResponseAt = Date.now();
    stat.responses += 1;
    stat.responseTotal += record.firstResponseAt - record.createdAt;
  }
  features.store.save();
}

/* ----------------------------------------------------------------- command --- */

const priorityChoices = Object.entries(PRIORITIES).map(([value, meta]) => ({
  name: `${meta.emoji} ${meta.label}`,
  value,
}));

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Advanced ticket system with categories, claiming and transcripts')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Set up the ticket system')
          .addChannelOption((option) =>
            option.setName('panel-channel').setDescription('Where the ticket panel is posted').setRequired(true).addChannelTypes(0),
          )
          .addChannelOption((option) =>
            option.setName('category').setDescription('Category that holds ticket channels').setRequired(false).addChannelTypes(ChannelType.GuildCategory),
          )
          .addRoleOption((option) =>
            option.setName('support-role').setDescription('Role that can see and claim tickets').setRequired(false),
          )
          .addChannelOption((option) =>
            option.setName('transcript-channel').setDescription('Where closed transcripts are sent').setRequired(false).addChannelTypes(0),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('category')
          .setDescription('Manage ticket categories')
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('Add, remove or list categories')
              .setRequired(true)
              .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' }),
          )
          .addStringOption((option) => option.setName('name').setDescription('Category name').setRequired(false).setMaxLength(80))
          .addStringOption((option) => option.setName('emoji').setDescription('Emoji').setRequired(false).setMaxLength(60))
          .addStringOption((option) =>
            option.setName('description').setDescription('Shown on the panel').setRequired(false).setMaxLength(100),
          )
          .addStringOption((option) =>
            option.setName('priority').setDescription('Default priority').setRequired(false).addChoices(...priorityChoices),
          )
          .addRoleOption((option) =>
            option.setName('support-role').setDescription('Extra role for this category').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('panel')
          .setDescription('Post or refresh the ticket panel')
          .addChannelOption((option) => option.setName('channel').setDescription('Panel channel').setRequired(false).addChannelTypes(0)),
      )
      .addSubcommand((sub) => sub.setName('close').setDescription('Close the current ticket'))
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a member to this ticket')
          .addUserOption((option) => option.setName('user').setDescription('Member to add').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a member from this ticket')
          .addUserOption((option) => option.setName('user').setDescription('Member to remove').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('priority')
          .setDescription('Change this ticket priority')
          .addStringOption((option) =>
            option.setName('level').setDescription('Priority').setRequired(true).addChoices(...priorityChoices),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('stats')
          .setDescription('Staff ticket statistics')
          .addUserOption((option) => option.setName('user').setDescription('One staff member').setRequired(false)),
      )
      .addSubcommand((sub) => sub.setName('transcript').setDescription('Download a transcript of this ticket')),

    async execute(interaction, { features }) {
      const guild = interaction.guild;
      const config = features.store.guild(guild.id).tickets;
      const subcommand = interaction.options.getSubcommand();
      const manager = canManageGuild(interaction.member);

      if (subcommand === 'setup') {
        if (!manager) {
          await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
          return;
        }
        config.panelChannelId = interaction.options.getChannel('panel-channel', true).id;
        const category = interaction.options.getChannel('category');
        if (category) config.categoryChannelId = category.id;
        const supportRole = interaction.options.getRole('support-role');
        if (supportRole) config.supportRoleIds = [...new Set([...(config.supportRoleIds ?? []), supportRole.id])];
        const transcripts = interaction.options.getChannel('transcript-channel');
        if (transcripts) config.transcriptChannelId = transcripts.id;
        if (config.categories.length === 0) {
          config.categories.push({
            id: 'general',
            name: 'General support',
            emoji: '🎫',
            description: 'Questions, help and anything else',
            priority: 'normal',
            supportRoleIds: supportRole ? [supportRole.id] : [],
            pingRoleIds: [],
          });
        }
        features.store.save();
        let panelError = null;
        const message = await postPanel(features, guild, config).catch((error) => {
          panelError = error.message;
          return null;
        });
        await interaction.reply({
          embeds: [
            embed(
              'Ticket system ready',
              [
                `Panel: <#${config.panelChannelId}>${message ? ` (${message.url})` : ''}`,
                `Categories: ${config.categories.map((entry) => entry.name).join(', ')}`,
                'Add more with `/ticket category action:Add`.',
                panelError ? `\n⚠️ Panel message failed: ${panelError}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
              panelError ? COLORS.warn : COLORS.on,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'category') {
        if (!manager) {
          await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
          return;
        }
        const action = interaction.options.getString('action', true);
        const name = interaction.options.getString('name');
        if (action === 'add') {
          if (!name) {
            await interaction.reply({ embeds: [embed('Name required', 'Give the category a name.', COLORS.off)], flags: 64 });
            return;
          }
          if (config.categories.length >= 25) {
            await interaction.reply({ embeds: [embed('Too many categories', 'Discord allows 25 dropdown options.', COLORS.off)], flags: 64 });
            return;
          }
          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) + '-' + Math.random().toString(36).slice(2, 5);
          const supportRole = interaction.options.getRole('support-role');
          config.categories.push({
            id,
            name,
            emoji: interaction.options.getString('emoji') ?? '🎫',
            description: interaction.options.getString('description') ?? 'Open a ticket',
            priority: interaction.options.getString('priority') ?? 'normal',
            supportRoleIds: supportRole ? [supportRole.id] : [],
            pingRoleIds: [],
          });
          features.store.save();
          if (config.panelChannelId) await postPanel(features, guild, config).catch(() => {});
          await interaction.reply({
            embeds: [embed('Category added', `**${name}** is now a ticket category${config.panelChannelId ? ' and the panel was refreshed' : ''}.`, COLORS.on)],
            flags: 64,
          });
          return;
        }
        if (action === 'remove') {
          const target = name
            ? config.categories.find((entry) => entry.name.toLowerCase() === name.toLowerCase() || entry.id === name)
            : null;
          if (!target) {
            await interaction.reply({ embeds: [embed('Not found', 'Give the exact category name.', COLORS.off)], flags: 64 });
            return;
          }
          config.categories = config.categories.filter((entry) => entry.id !== target.id);
          features.store.save();
          if (config.panelChannelId) await postPanel(features, guild, config).catch(() => {});
          await interaction.reply({ embeds: [embed('Category removed', `Removed **${target.name}**.`, COLORS.on)], flags: 64 });
          return;
        }
        await interaction.reply({
          embeds: [
            embed(
              'Ticket categories',
              config.categories.length
                ? config.categories
                    .map(
                      (entry) =>
                        `${entry.emoji || '🎫'} **${entry.name}** · \`${entry.id}\` · ${priorityOf(entry.priority).label} · ${
                          entry.supportRoleIds?.length ? entry.supportRoleIds.map((id) => `<@&${id}>`).join(' ') : 'server support role'
                        }`,
                    )
                    .join('\n')
                : 'No categories yet.',
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'panel') {
        if (!manager) {
          await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
          return;
        }
        const channel = interaction.options.getChannel('channel');
        if (channel) config.panelChannelId = channel.id;
        if (!config.panelChannelId) {
          await interaction.reply({ embeds: [embed('No panel channel', 'Run `/ticket setup` first.', COLORS.off)], flags: 64 });
          return;
        }
        const message = await postPanel(features, guild, config);
        await interaction.reply({ embeds: [embed('Panel posted', message.url, COLORS.on)], flags: 64 });
        return;
      }

      const record = config.open[interaction.channelId];
      if (['close', 'add', 'remove', 'priority', 'transcript'].includes(subcommand) && !record) {
        await interaction.reply({
          embeds: [embed('Not a ticket channel', 'Run this inside an open ticket.', COLORS.off)],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'close') {
        try {
          await interaction.reply({
            embeds: [embed('Closing ticket…', 'Generating the transcript and removing the channel.', COLORS.muted)],
            flags: 64,
          });
          await closeTicket(features, guild, interaction.channel, interaction.user);
        } catch (error) {
          await interaction.followUp({ embeds: [embed('Could not close', error.message, COLORS.off)], flags: 64 });
        }
        return;
      }

      if (subcommand === 'add' || subcommand === 'remove') {
        if (!manager && !isStaffMember(interaction.member, config.supportRoleIds ?? [])) {
          await interaction.reply({ embeds: [embed('Staff only', 'Only staff can change ticket access.', COLORS.off)], flags: 64 });
          return;
        }
        const user = interaction.options.getUser('user', true);
        if (subcommand === 'add') {
          await interaction.channel.permissionOverwrites.edit(user.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
          });
        } else {
          await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
        }
        await interaction.reply({
          embeds: [embed(subcommand === 'add' ? 'Member added' : 'Member removed', `<@${user.id}> ${subcommand === 'add' ? 'can now see this ticket' : 'no longer has access'}.`, COLORS.on)],
        });
        return;
      }

      if (subcommand === 'priority') {
        if (!manager && !isStaffMember(interaction.member, config.supportRoleIds ?? [])) {
          await interaction.reply({ embeds: [embed('Staff only', 'Only staff can change priority.', COLORS.off)], flags: 64 });
          return;
        }
        record.priority = interaction.options.getString('level', true);
        features.store.save();
        const category = findCategory(config, record.categoryId);
        const message = await interaction.channel.messages.fetch(record.panelMessageId ?? '').catch(() => null);
        if (message) {
          await message.edit({
            embeds: [ticketEmbed(record, category, guild, features.client)],
            components: ticketRows(record),
          });
        }
        await interaction.reply({
          embeds: [embed('Priority updated', `This ticket is now **${priorityOf(record.priority).label}**.`, priorityOf(record.priority).color)],
        });
        return;
      }

      if (subcommand === 'transcript') {
        await interaction.deferReply({ flags: 64 });
        const transcript = await buildTranscript(features, interaction.channel, {
          ...record,
          userTag: interaction.user.tag,
        });
        await interaction.editReply({
          embeds: [embed('Transcript ready', `${transcript.count} messages.`, COLORS.on)],
          files: [transcript.attachment],
        });
        return;
      }

      const target = interaction.options.getUser('user');
      const entries = Object.entries(config.staff)
        .filter(([userId, stat]) => stat.claimed || stat.closed || stat.responses || (target ? userId === target.id : false))
        .sort((a, b) => b[1].closed - a[1].closed || b[1].claimed - a[1].claimed);
      const chosen = target ? entries.filter(([userId]) => userId === target.id) : entries.slice(0, 15);
      if (chosen.length === 0) {
        await interaction.reply({ embeds: [embed('No ticket stats yet', 'Claim and close tickets to build statistics.', COLORS.muted)], flags: 64 });
        return;
      }
      await interaction.reply({
        embeds: [
          embed(
            target ? `Ticket stats for ${target.username}` : 'Ticket staff statistics',
            chosen
              .map(([userId, stat]) => {
                const average = stat.responses ? formatDuration(stat.responseTotal / stat.responses) : '—';
                return `<@${userId}> · **${stat.claimed}** claimed · **${stat.closed}** closed · avg first response **${average}**`;
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
