import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  InteractionContextType,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { COLORS, canManageGuild, embed, formatDuration } from './util.js';

const LIMIT_OPTIONS = [0, 2, 3, 4, 5, 10, 15, 25];

function configFor(features, guildId) {
  return features.store.guild(guildId).tempVoice;
}

function recordFor(features, guildId, channelId) {
  return configFor(features, guildId).channels[channelId] ?? null;
}

function controlPanel(record) {
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tv:rename:${record.channelId}`)
      .setLabel('Rename')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`tv:lock:${record.channelId}`)
      .setLabel(record.locked ? 'Unlock' : 'Lock')
      .setEmoji(record.locked ? '🔓' : '🔒')
      .setStyle(record.locked ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`tv:claim:${record.channelId}`)
      .setLabel('Claim')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`tv:delete:${record.channelId}`)
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );

  const limits = new StringSelectMenuBuilder()
    .setCustomId(`tv:limit:${record.channelId}`)
    .setPlaceholder(`User limit: ${record.limit ? record.limit : 'unlimited'}`)
    .addOptions(
      LIMIT_OPTIONS.map((value) => ({
        label: value === 0 ? 'Unlimited' : `${value} people`,
        value: String(value),
        default: (record.limit ?? 0) === value,
      })),
    );

  return [
    new ActionRowBuilder().addComponents(limits),
    buttons,
  ];
}

async function panelMessage(channel, record, ownerId) {
  const built = embed(
    '🔊 Your temporary voice channel',
    [
      `Owner: <@${ownerId}>`,
      `Status: ${record.locked ? '🔒 Locked' : '🔓 Open'}`,
      `Limit: ${record.limit ? `${record.limit} people` : 'unlimited'}`,
      '',
      'Use the buttons below to manage it. The channel is deleted when everyone leaves.',
    ].join('\n'),
    record.locked ? COLORS.warn : COLORS.brand,
  );
  return channel.send({ embeds: [built], components: controlPanel(record) });
}

async function ownerOnly(features, interaction, record) {
  if (interaction.user.id === record.ownerId) return true;
  if (canManageGuild(interaction.member)) return true;
  await interaction.reply({
    embeds: [embed('Not your channel', 'Only the channel owner (or **Manage Server**) can do that.', COLORS.off)],
    flags: 64,
  });
  return false;
}

export async function createTempChannel(features, guild, member) {
  const config = configFor(features, guild.id);
  if (!config.creatorChannelId) return null;

  const existing = Object.values(config.channels).find((record) => record.ownerId === member.id);
  if (existing) {
    const channel = guild.channels.cache.get(existing.channelId);
    if (channel) {
      await member.voice.setChannel(channel).catch(() => {});
      return channel;
    }
    delete config.channels[existing.channelId];
  }

  const name = `🔊 ${member.displayName ?? member.user.username}`.slice(0, 95);
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: config.categoryId || undefined,
    topic: `Aegis temporary voice • owner:${member.id}`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
      },
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.MuteMembers,
          PermissionFlagsBits.DeafenMembers,
        ],
      },
      {
        id: features.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.MoveMembers,
        ],
      },
    ],
    reason: `Temporary voice for ${member.user.tag}`,
  });

  const record = {
    channelId: channel.id,
    ownerId: member.id,
    createdAt: Date.now(),
    locked: false,
    limit: 0,
    panelMessageId: null,
  };
  config.channels[channel.id] = record;
  features.store.save();

  await member.voice.setChannel(channel).catch(() => {});
  const panel = await panelMessage(channel, record, member.id).catch(() => null);
  if (panel) {
    record.panelMessageId = panel.id;
    features.store.save();
  }
  features.bot?.log('info', `[${guild.name}] Created temporary voice channel for ${member.user.tag}.`);
  return channel;
}

export async function handleTempVoiceState(features, oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;
  const config = configFor(features, guild.id);
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  if (newState.channelId && newState.channelId === config.creatorChannelId) {
    await createTempChannel(features, guild, member).catch((error) => {
      features.bot?.log('warn', `Could not create a temporary channel: ${error.message}`);
    });
  }

  const leftChannelId = oldState.channelId;
  if (!leftChannelId || leftChannelId === newState.channelId) return;
  const record = config.channels[leftChannelId];
  if (!record) return;

  const channel = guild.channels.cache.get(leftChannelId);
  if (!channel) {
    delete config.channels[leftChannelId];
    features.store.save();
    return;
  }

  if (channel.members.size > 0) return;
  scheduleEmptyCheck(features, guild, channel, record);
}

function scheduleEmptyCheck(features, guild, channel, record) {
  features.tempTimers ??= new Map();
  if (features.tempTimers.has(channel.id)) return;
  const timer = setTimeout(async () => {
    features.tempTimers.delete(channel.id);
    const fresh = guild.channels.cache.get(channel.id) ?? (await guild.channels.fetch(channel.id).catch(() => null));
    if (!fresh) {
      const config = configFor(features, guild.id);
      delete config.channels[channel.id];
      features.store.save();
      return;
    }
    if (fresh.members.size > 0) return;
    const config = configFor(features, guild.id);
    delete config.channels[channel.id];
    features.store.save();
    await fresh.delete('Temporary voice channel is empty').catch(() => {});
  }, 5000);
  timer.unref?.();
  features.tempTimers.set(channel.id, timer);
}

export async function handleTempVoiceComponent(features, interaction) {
  if (!interaction.guildId) return false;
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'tv') return false;

  const guild = interaction.guild;
  const action = parts[1];
  const channelId = parts[2];
  const record = recordFor(features, guild.id, channelId);
  if (!record) {
    await interaction.reply({ embeds: [embed('Channel closed', 'This temporary channel no longer exists.', COLORS.off)], flags: 64 });
    return true;
  }

  if (action === 'rename') {
    if (!(await ownerOnly(features, interaction, record))) return true;
    const modal = new ModalBuilder()
      .setCustomId(`tv:rename-modal:${channelId}`)
      .setTitle('Rename your voice channel');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('New channel name')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(90)
          .setRequired(true)
          .setValue((guild.channels.cache.get(channelId)?.name ?? '').replace(/^🔊\s*/, '')),
      ),
    );
    await interaction.showModal(modal);
    return true;
  }

  if (action === 'rename-modal') {
    const name = interaction.fields.getTextInputValue('name').trim();
    if (!name) {
      await interaction.reply({ embeds: [embed('Name required', 'Give the channel a name.', COLORS.off)], flags: 64 });
      return true;
    }
    await guild.channels.cache.get(channelId)?.setName(name.slice(0, 95)).catch(() => {});
    await interaction.reply({ embeds: [embed('Renamed', `The channel is now **${name.slice(0, 95)}**.`, COLORS.on)], flags: 64 });
    return true;
  }

  if (action === 'limit') {
    if (!(await ownerOnly(features, interaction, record))) return true;
    const limit = Math.min(99, Math.max(0, Number(interaction.values?.[0]) || 0));
    record.limit = limit;
    features.store.save();
    const channel = guild.channels.cache.get(channelId);
    await channel?.setUserLimit(limit).catch(() => {});
    await interaction.update({ components: controlPanel(record) });
    await interaction.followUp({
      embeds: [embed('User limit updated', limit ? `This channel now holds **${limit}** people.` : 'The channel is unlimited again.', COLORS.on)],
      flags: 64,
    });
    return true;
  }

  if (action === 'lock') {
    if (!(await ownerOnly(features, interaction, record))) return true;
    record.locked = !record.locked;
    features.store.save();
    const channel = guild.channels.cache.get(channelId);
    await channel?.permissionOverwrites
      .edit(guild.roles.everyone.id, { Connect: !record.locked }, { reason: `Temporary voice ${record.locked ? 'locked' : 'unlocked'}` })
      .catch(() => {});
    await interaction.update({ components: controlPanel(record) });
    await interaction.followUp({
      embeds: [
        embed(
          record.locked ? 'Channel locked' : 'Channel unlocked',
          record.locked ? 'Only people with explicit access can join.' : 'Everyone can join again.',
          record.locked ? COLORS.warn : COLORS.on,
        ),
      ],
      flags: 64,
    });
    return true;
  }

  if (action === 'claim') {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      await interaction.reply({ embeds: [embed('Channel gone', 'This channel was deleted.', COLORS.off)], flags: 64 });
      return true;
    }
    const owner = guild.members.cache.get(record.ownerId);
    const ownerHere = owner && channel.members.has(record.ownerId);
    if (ownerHere && record.ownerId !== interaction.user.id) {
      await interaction.reply({ embeds: [embed('Owner still here', 'You can claim the channel once the owner leaves.', COLORS.warn)], flags: 64 });
      return true;
    }
    const previous = record.ownerId;
    record.ownerId = interaction.user.id;
    features.store.save();
    await channel.permissionOverwrites
      .edit(previous, { ManageChannels: false })
      .catch(() => {});
    await channel.permissionOverwrites
      .edit(interaction.user.id, {
        ViewChannel: true,
        Connect: true,
        ManageChannels: true,
        MoveMembers: true,
        MuteMembers: true,
        DeafenMembers: true,
      })
      .catch(() => {});
    await channel.setTopic(`Aegis temporary voice • owner:${interaction.user.id}`).catch(() => {});
    await interaction.update({ components: controlPanel(record) });
    await interaction.followUp({
      embeds: [embed('Channel claimed', `<@${interaction.user.id}> now owns this channel.`, COLORS.on)],
    });
    return true;
  }

  if (action === 'delete') {
    if (!(await ownerOnly(features, interaction, record))) return true;
    const config = configFor(features, guild.id);
    delete config.channels[channelId];
    features.store.save();
    const channel = guild.channels.cache.get(channelId);
    await interaction.reply({ embeds: [embed('Channel deleted', 'Your temporary channel is being removed.', COLORS.muted)], flags: 64 });
    await channel?.delete(`Temporary voice deleted by ${interaction.user.tag}`).catch(() => {});
    return true;
  }

  return false;
}

export async function resumeTempVoice(features) {
  for (const guild of features.client?.guilds.cache.values() ?? []) {
    const config = configFor(features, guild.id);
    for (const [channelId, record] of Object.entries(config.channels)) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        delete config.channels[channelId];
        continue;
      }
      if (channel.members.size === 0) {
        delete config.channels[channelId];
        await channel.delete('Temporary voice left empty after restart').catch(() => {});
        continue;
      }
      const panel = record.panelMessageId
        ? await channel.messages.fetch(record.panelMessageId).catch(() => null)
        : null;
      if (!panel) {
        const message = await panelMessage(channel, record, record.ownerId).catch(() => null);
        if (message) record.panelMessageId = message.id;
      }
    }
    features.store.save();
  }
}

export async function cleanupTempVoice(features, guild) {
  const config = configFor(features, guild.id);
  let removed = 0;
  for (const [channelId, record] of Object.entries(config.channels)) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.members.size === 0) {
      delete config.channels[channelId];
      removed += 1;
      if (channel) await channel.delete('Temporary voice cleanup').catch(() => {});
    }
  }
  features.store.save();
  return removed;
}

/* ----------------------------------------------------------------- command --- */

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('tempvoice')
      .setDescription('Automatic temporary voice channels')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Choose the join-to-create channel')
          .addChannelOption((option) =>
            option.setName('creator').setDescription('Members join this to get a channel').setRequired(true).addChannelTypes(ChannelType.GuildVoice),
          )
          .addChannelOption((option) =>
            option.setName('category').setDescription('Category for new channels').setRequired(false).addChannelTypes(ChannelType.GuildCategory),
          ),
      )
      .addSubcommand((sub) => sub.setName('status').setDescription('Show temporary voice setup'))
      .addSubcommand((sub) => sub.setName('cleanup').setDescription('Remove empty temporary channels'))
      .addSubcommand((sub) =>
        sub
          .setName('rename')
          .setDescription('Rename your temporary channel')
          .addStringOption((option) => option.setName('name').setDescription('New name').setRequired(true).setMaxLength(90)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('limit')
          .setDescription('Set your channel user limit')
          .addIntegerOption((option) => option.setName('number').setDescription('0 for unlimited').setRequired(true).setMinValue(0).setMaxValue(99)),
      )
      .addSubcommand((sub) => sub.setName('lock').setDescription('Lock your temporary channel'))
      .addSubcommand((sub) => sub.setName('unlock').setDescription('Unlock your temporary channel'))
      .addSubcommand((sub) => sub.setName('claim').setDescription('Claim an abandoned channel'))
      .addSubcommand((sub) => sub.setName('delete').setDescription('Delete your temporary channel')),

    async execute(interaction, { features }) {
      const guild = interaction.guild;
      const config = configFor(features, guild.id);
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'setup') {
        if (!canManageGuild(interaction.member)) {
          await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
          return;
        }
        config.creatorChannelId = interaction.options.getChannel('creator', true).id;
        config.categoryId = interaction.options.getChannel('category')?.id ?? null;
        features.store.save();
        await interaction.reply({
          embeds: [
            embed(
              'Temporary voice ready',
              `Members who join <#${config.creatorChannelId}> get their own channel${
                config.categoryId ? ` in **${guild.channels.cache.get(config.categoryId)?.name ?? 'the category'}**` : ''
              }.\nMake sure Aegis has **Manage Channels** and **Move Members**.`,
              COLORS.on,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'status') {
        const active = Object.values(config.channels);
        await interaction.reply({
          embeds: [
            embed(
              'Temporary voice',
              [
                `Creator channel: ${config.creatorChannelId ? `<#${config.creatorChannelId}>` : '_not set_'}`,
                `Category: ${config.categoryId ? `<#${config.categoryId}>` : '_server default_'}`,
                `Active channels: **${active.length}**`,
                ...active.slice(0, 10).map((record) => `<#${record.channelId}> · owner <@${record.ownerId}> · ${record.locked ? 'locked' : 'open'}`),
              ].join('\n'),
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'cleanup') {
        if (!canManageGuild(interaction.member)) {
          await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
          return;
        }
        const removed = await cleanupTempVoice(features, guild);
        await interaction.reply({ embeds: [embed('Cleanup complete', `Removed **${removed}** empty temporary channel(s).`, COLORS.on)], flags: 64 });
        return;
      }

      const record = recordFor(features, guild.id, interaction.member.voice?.channelId ?? '');
      if (!record) {
        await interaction.reply({
          embeds: [embed('Join your channel first', 'Use these commands while connected to your temporary voice channel.', COLORS.off)],
          flags: 64,
        });
        return;
      }
      const channel = guild.channels.cache.get(record.channelId);

      if (subcommand === 'claim') {
        const ownerHere = channel?.members.has(record.ownerId);
        if (ownerHere && record.ownerId !== interaction.user.id) {
          await interaction.reply({ embeds: [embed('Owner still here', 'Wait until the owner leaves.', COLORS.warn)], flags: 64 });
          return;
        }
        const previous = record.ownerId;
        record.ownerId = interaction.user.id;
        features.store.save();
        await channel?.permissionOverwrites.edit(previous, { ManageChannels: false }).catch(() => {});
        await channel?.permissionOverwrites
          .edit(interaction.user.id, { ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true })
          .catch(() => {});
        await channel?.setTopic(`Aegis temporary voice • owner:${interaction.user.id}`).catch(() => {});
        await interaction.reply({ embeds: [embed('Channel claimed', 'You now own this channel.', COLORS.on)], flags: 64 });
        return;
      }

      if (!(await ownerOnly(features, interaction, record))) return;

      if (subcommand === 'rename') {
        const name = interaction.options.getString('name', true).trim().slice(0, 90);
        await channel?.setName(name).catch(() => {});
        await interaction.reply({ embeds: [embed('Renamed', `The channel is now **${name}**.`, COLORS.on)], flags: 64 });
        return;
      }
      if (subcommand === 'limit') {
        record.limit = interaction.options.getInteger('number', true);
        features.store.save();
        await channel?.setUserLimit(record.limit).catch(() => {});
        await interaction.reply({
          embeds: [embed('Limit updated', record.limit ? `Now limited to **${record.limit}** people.` : 'Unlimited again.', COLORS.on)],
          flags: 64,
        });
        return;
      }
      if (subcommand === 'lock' || subcommand === 'unlock') {
        record.locked = subcommand === 'lock';
        features.store.save();
        await channel?.permissionOverwrites.edit(guild.roles.everyone.id, { Connect: !record.locked }).catch(() => {});
        await interaction.reply({
          embeds: [embed(record.locked ? 'Channel locked' : 'Channel unlocked', record.locked ? 'Nobody new can join.' : 'Everyone can join again.', record.locked ? COLORS.warn : COLORS.on)],
          flags: 64,
        });
        return;
      }
      if (subcommand === 'delete') {
        delete config.channels[record.channelId];
        features.store.save();
        await interaction.reply({ embeds: [embed('Deleting channel', 'Your temporary channel is being removed.', COLORS.muted)], flags: 64 });
        await channel?.delete(`Temporary voice deleted by ${interaction.user.tag}`).catch(() => {});
        return;
      }
    },
  },
];
