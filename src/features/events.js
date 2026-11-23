import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, canManageGuild, embed, formatDuration, parseDuration, randomId, truncate } from './util.js';

export function eventsState(features, guildId) {
  const config = features.store.guild(guildId);
  config.events ??= { enabled: true, items: {}, counter: 0 };
  return config.events;
}

export function eventSummary(features, guildId) {
  const config = eventsState(features, guildId);
  return {
    enabled: Boolean(config.enabled),
    items: Object.values(config.items ?? {})
      .sort((a, b) => a.startsAt - b.startsAt)
      .slice(0, 20)
      .map((item) => ({
        id: item.id,
        title: item.title,
        channelId: item.channelId,
        startsAt: item.startsAt,
        capacity: item.capacity,
        going: item.going?.length ?? 0,
        waitlist: item.waitlist?.length ?? 0,
        maybe: item.maybe?.length ?? 0,
        checkedIn: item.checkedIn?.length ?? 0,
        status: item.status,
        hostId: item.hostId,
      })),
  };
}

function eventEmbed(item, guild) {
  const going = item.going ?? [];
  const waitlist = item.waitlist ?? [];
  const maybe = item.maybe ?? [];
  const lines = [
    item.description ? `${truncate(item.description, 700)}\n` : '',
    `📅 **Starts:** <t:${Math.floor(item.startsAt / 1000)}:F> (<t:${Math.floor(item.startsAt / 1000)}:R>)`,
    item.capacity > 0 ? `👥 **Capacity:** ${going.length}/${item.capacity}${waitlist.length ? ` (+${waitlist.length} waitlist)` : ''}` : `👥 **Going:** ${going.length}`,
    `🙋 **Maybe:** ${maybe.length}`,
    `🎙️ **Host:** <@${item.hostId}>`,
  ];
  if (item.checkedIn?.length) lines.push(`✅ **Checked in:** ${item.checkedIn.length}`);
  if (item.status === 'cancelled') lines.push('\n**This event was cancelled.**');
  const built = embed(item.title, lines.filter(Boolean).join('\n'), item.status === 'cancelled' ? COLORS.off : COLORS.brand);
  built.setFooter({ text: `Event ${item.id} · RSVP below` });
  return built;
}

function eventRows(item) {
  const going = item.going ?? [];
  const waitlist = item.waitlist ?? [];
  const maybe = item.maybe ?? [];
  const disabled = item.status === 'cancelled';
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ev:go:${item.id}`)
        .setLabel(`Going (${going.length})`)
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`ev:maybe:${item.id}`)
        .setLabel(`Maybe (${maybe.length})`)
        .setEmoji('🤔')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`ev:no:${item.id}`)
        .setLabel('Can’t go')
        .setEmoji('✖️')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`ev:check:${item.id}`)
        .setLabel(`Check in (${item.checkedIn?.length ?? 0})`)
        .setEmoji('🎟️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled || Date.now() < item.startsAt - 30 * 60_000),
    ),
  ];
}

async function refreshMessage(features, guild, item) {
  const channel = guild.channels.cache.get(item.channelId) ?? (await guild.channels.fetch(item.channelId).catch(() => null));
  if (!channel?.isTextBased?.()) return;
  const message = await channel.messages.fetch(item.messageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [eventEmbed(item, guild)], components: eventRows(item) }).catch(() => {});
}

export async function createEvent(features, guild, channel, { title, description = '', startsIn = '1h', capacity = 0, hostId = null } = {}) {
  const duration = parseDuration(startsIn);
  if (!duration) throw new Error('Give the start time as a duration, like `45m`, `2h` or `1d`.');
  const cleanTitle = String(title ?? '').trim().slice(0, 100);
  if (!cleanTitle) throw new Error('Give the event a title.');
  const config = eventsState(features, guild.id);
  const item = {
    id: randomId(6),
    title: cleanTitle,
    description: String(description ?? '').slice(0, 900),
    channelId: channel.id,
    startsAt: Date.now() + duration,
    capacity: Math.max(0, Math.min(500, Number(capacity) || 0)),
    hostId: hostId ?? guild.ownerId,
    going: [],
    maybe: [],
    no: [],
    waitlist: [],
    checkedIn: [],
    status: 'open',
    createdAt: Date.now(),
    messageId: null,
    reminded60: false,
    reminded5: false,
    noShowPosted: false,
  };
  const message = await channel.send({ embeds: [eventEmbed(item, guild)], components: eventRows(item) });
  item.messageId = message.id;
  config.items[item.id] = item;
  features.store.save();
  return item;
}

export async function cancelEvent(features, guild, eventId) {
  const config = eventsState(features, guild.id);
  const item = config.items?.[eventId];
  if (!item) throw new Error('That event no longer exists.');
  item.status = 'cancelled';
  features.store.save();
  await refreshMessage(features, guild, item);
  return item;
}

async function dm(user, content) {
  await user?.send({ embeds: [content] }).catch(() => {});
}

export async function handleEventComponent(features, interaction) {
  if (!interaction.customId.startsWith('ev:')) return false;
  const [, action, eventId] = interaction.customId.split(':');
  const config = eventsState(features, interaction.guildId);
  const item = config.items?.[eventId];
  if (!item) {
    await interaction.reply({ embeds: [embed('Event gone', 'This event was removed.', COLORS.off)], flags: 64 });
    return true;
  }
  if (item.status === 'cancelled') {
    await interaction.reply({ embeds: [embed('Event cancelled', 'This event was cancelled.', COLORS.off)], flags: 64 });
    return true;
  }
  const userId = interaction.user.id;
  for (const key of ['going', 'maybe', 'no', 'waitlist', 'checkedIn']) item[key] ??= [];
  const remove = (list) => (item[list] = (item[list] ?? []).filter((id) => id !== userId));

  if (action === 'go') {
    if (item.going.includes(userId)) {
      remove('going');
      if (item.waitlist.length) {
        const promoted = item.waitlist.shift();
        item.going.push(promoted);
        await dm(features.client?.users?.cache?.get(promoted), embed('You are in!', `A spot opened for **${item.title}** — you are on the going list.`, COLORS.on));
      }
    } else if (item.capacity > 0 && item.going.length >= item.capacity) {
      if (!item.waitlist.includes(userId)) item.waitlist.push(userId);
      remove('maybe');
      remove('no');
      await interaction.reply({
        embeds: [embed('Added to the waitlist', `**${item.title}** is full — you are #${item.waitlist.length} in line.`, COLORS.warn)],
        flags: 64,
      });
      features.store.save();
      await refreshMessage(features, interaction.guild, item);
      return true;
    } else {
      item.going.push(userId);
      item.waitlist = item.waitlist.filter((id) => id !== userId);
      remove('maybe');
      remove('no');
    }
  } else if (action === 'maybe') {
    if (item.maybe.includes(userId)) remove('maybe');
    else {
      item.maybe.push(userId);
      remove('going');
      remove('no');
      item.waitlist = item.waitlist.filter((id) => id !== userId);
    }
  } else if (action === 'no') {
    if (item.no.includes(userId)) remove('no');
    else {
      item.no.push(userId);
      remove('going');
      remove('maybe');
      item.waitlist = item.waitlist.filter((id) => id !== userId);
    }
  } else if (action === 'check') {
    const open = Date.now() >= item.startsAt - 30 * 60_000 && Date.now() <= item.startsAt + 2 * 3_600_000;
    if (!open) {
      await interaction.reply({ embeds: [embed('Check-in is closed', 'Check-in opens 30 minutes before the event.', COLORS.off)], flags: 64 });
      return true;
    }
    if (item.checkedIn.includes(userId)) remove('checkedIn');
    else {
      item.checkedIn.push(userId);
      if (!item.going.includes(userId)) item.going.push(userId);
    }
  }

  features.store.save();
  await refreshMessage(features, interaction.guild, item);
  const state = item.going.includes(userId)
    ? `You are going to **${item.title}**.`
    : item.maybe.includes(userId)
      ? `You might go to **${item.title}**.`
      : item.no.includes(userId)
        ? `You can’t go to **${item.title}**.`
        : item.checkedIn.includes(userId)
          ? `Checked in for **${item.title}**.`
          : `You are no longer on the list for **${item.title}**.`;
  await interaction.reply({
    embeds: [embed(item.checkedIn.includes(userId) && action === 'check' ? 'Checked in ✅' : 'RSVP saved', state, COLORS.on)],
    flags: 64,
  });
  return true;
}

export async function sweepEvents(features) {
  const client = features.client;
  if (!client) return;
  for (const guild of client.guilds.cache.values()) {
    const config = eventsState(features, guild.id);
    for (const item of Object.values(config.items ?? {})) {
      if (item.status !== 'open') continue;
      const left = item.startsAt - Date.now();
      if (left <= 60 * 60_000 && left > 5 * 60_000 && !item.reminded60) {
        item.reminded60 = true;
        features.store.save();
        for (const userId of [...item.going, ...item.maybe]) {
          const user = await client.users.fetch(userId).catch(() => null);
          await dm(
            user,
            embed('Starting in an hour', `**${item.title}** starts <t:${Math.floor(item.startsAt / 1000)}:R> in <#${item.channelId}>.`, COLORS.brand),
          );
        }
      }
      if (left <= 5 * 60_000 && left > -60_000 && !item.reminded5) {
        item.reminded5 = true;
        features.store.save();
        for (const userId of item.going) {
          const user = await client.users.fetch(userId).catch(() => null);
          await dm(user, embed('Starting in 5 minutes', `**${item.title}** is about to begin — head to <#${item.channelId}>.`, COLORS.warn));
        }
      }
      if (!item.noShowPosted && Date.now() > item.startsAt + 30 * 60_000) {
        item.noShowPosted = true;
        features.store.save();
        const channel = guild.channels.cache.get(item.channelId);
        const missing = item.going.filter((userId) => !item.checkedIn.includes(userId));
        if (channel?.isTextBased?.()) {
          await channel
            .send({
              embeds: [
                embed(
                  'Event check-in closed',
                  `**${item.title}** — ${item.checkedIn.length}/${item.going.length} checked in.${
                    missing.length ? `\nNo-shows: ${missing.slice(0, 20).map((id) => `<@${id}>`).join(', ')}` : ''
                  }`,
                  missing.length ? COLORS.warn : COLORS.on,
                ),
              ],
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
        }
      }
    }
  }
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('event')
      .setDescription('Plan a community event with RSVPs, reminders and check-in')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Post an event with RSVP buttons')
          .addStringOption((option) => option.setName('title').setDescription('Event name').setRequired(true).setMaxLength(100))
          .addStringOption((option) => option.setName('starts').setDescription('Starts in, e.g. 45m, 2h, 1d').setRequired(true).setMaxLength(20))
          .addChannelOption((option) => option.setName('channel').setDescription('Where to post it').setRequired(false).addChannelTypes(0))
          .addIntegerOption((option) => option.setName('capacity').setDescription('Max people, 0 for unlimited').setRequired(false).setMinValue(0).setMaxValue(500))
          .addStringOption((option) => option.setName('description').setDescription('What is happening?').setRequired(false).setMaxLength(900)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Upcoming events'))
      .addSubcommand((sub) =>
        sub
          .setName('cancel')
          .setDescription('Cancel an event')
          .addStringOption((option) => option.setName('id').setDescription('Event ID from /event list').setRequired(true)),
      ),

    async execute(interaction, { features }) {
      const guild = interaction.guild;
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'list') {
        const summary = eventSummary(features, guild.id);
        await interaction.reply({
          embeds: [
            embed(
              '📅 Upcoming events',
              summary.items.length
                ? summary.items
                    .map(
                      (item) =>
                        `${item.status === 'cancelled' ? '~~' : ''}**${item.title}**${item.status === 'cancelled' ? '~~' : ''} — <t:${Math.floor(
                          item.startsAt / 1000,
                        )}:R> · ${item.going} going${item.waitlist ? `, ${item.waitlist} waitlist` : ''}\n> id: \`${item.id}\` in <#${item.channelId}>`,
                    )
                    .join('\n')
                : 'No events yet. Create one with `/event create`.',
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'cancel') {
        if (!canManageGuild(interaction.member) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
          await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Events**.', COLORS.off)], flags: 64 });
          return;
        }
        try {
          const item = await cancelEvent(features, guild, interaction.options.getString('id', true).trim());
          await interaction.reply({ embeds: [embed('Event cancelled', `**${item.title}** is cancelled.`, COLORS.muted)], flags: 64 });
        } catch (error) {
          await interaction.reply({ embeds: [embed('Could not cancel', error.message, COLORS.off)], flags: 64 });
        }
        return;
      }

      if (!canManageGuild(interaction.member) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Events**.', COLORS.off)], flags: 64 });
        return;
      }

      await interaction.deferReply({ flags: 64 });
      try {
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        const item = await createEvent(features, guild, channel, {
          title: interaction.options.getString('title', true),
          description: interaction.options.getString('description') ?? '',
          startsIn: interaction.options.getString('starts', true),
          capacity: interaction.options.getInteger('capacity') ?? 0,
          hostId: interaction.user.id,
        });
        await interaction.editReply({
          embeds: [
            embed(
              'Event posted',
              `**${item.title}** starts in ${formatDuration(item.startsAt - Date.now())} in <#${item.channelId}>.\nRSVPs, reminders and check-in are automatic.`,
              COLORS.on,
            ),
          ],
        });
      } catch (error) {
        await interaction.editReply({ embeds: [embed('Could not create the event', error.message, COLORS.off)] });
      }
    },
  },
];
