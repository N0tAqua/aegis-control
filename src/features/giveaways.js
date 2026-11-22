import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  COLORS,
  canManageGuild,
  embed,
  formatDuration,
  parseDuration,
  randomId,
  relative,
} from './util.js';

function requirementLines(item) {
  const requirements = item.requirements ?? {};
  const lines = [];
  if (requirements.roleId) lines.push(`Must have <@&${requirements.roleId}>`);
  if (requirements.minAccountAgeDays) lines.push(`Account at least **${requirements.minAccountAgeDays}** days old`);
  if (requirements.minServerAgeDays) lines.push(`In the server for at least **${requirements.minServerAgeDays}** days`);
  return lines;
}

function giveawayEmbed(item, guild) {
  const requirements = requirementLines(item);
  const built = embed(
    `🎉 ${item.prize}`,
    [
      item.description || 'Click the button below to enter. Good luck!',
      '',
      `**Ends:** ${relative(item.endsAt)} (<t:${Math.floor(item.endsAt / 1000)}:f>)`,
      `**Winners:** ${item.winners}`,
      `**Entries:** ${item.entries.length}`,
      `**Hosted by:** <@${item.hostId}>`,
      requirements.length ? `\n**Requirements**\n${requirements.map((line) => `• ${line}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    item.endedAt ? COLORS.muted : COLORS.on,
  );
  if (guild?.iconURL()) built.setThumbnail(guild.iconURL({ size: 128 }));
  built.setFooter({ text: `Giveaway ${item.id}${item.endedAt ? ' · ended' : ''}` });
  return built;
}

function giveawayRows(item, { ended = false } = {}) {
  if (ended) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gw:reroll:${item.id}`)
          .setLabel('Reroll winners')
          .setEmoji('🔄')
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
  }
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gw:enter:${item.id}`)
        .setLabel('Enter giveaway')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`gw:leave:${item.id}`)
        .setLabel('Leave')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function findMessage(features, item) {
  const guild = features.client?.guilds.cache.get(item.guildId);
  if (!guild) return null;
  const channel = guild.channels.cache.get(item.channelId) ?? (await guild.channels.fetch(item.channelId).catch(() => null));
  if (!channel?.isTextBased?.()) return null;
  return channel.messages.fetch(item.messageId).catch(() => null);
}

async function refreshMessage(features, item, ended = false) {
  const message = await findMessage(features, item);
  if (!message) return;
  const guild = features.client?.guilds.cache.get(item.guildId);
  await message
    .edit({ embeds: [giveawayEmbed(item, guild)], components: giveawayRows(item, { ended }) })
    .catch(() => {});
}

export function meetsRequirements(features, guild, userId, requirements = {}, memberOverride = null) {
  const member = memberOverride ?? guild.members.cache.get(userId);
  if (!member) return { ok: false, reason: 'You need to be in the server to enter.' };
  if (requirements.roleId && !member.roles.cache.has(requirements.roleId)) {
    return { ok: false, reason: `You need the <@&${requirements.roleId}> role to enter.` };
  }
  if (requirements.minAccountAgeDays) {
    const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    if (ageDays < requirements.minAccountAgeDays) {
      return {
        ok: false,
        reason: `Your account must be at least **${requirements.minAccountAgeDays}** days old (it is ${Math.floor(ageDays)}).`,
      };
    }
  }
  if (requirements.minServerAgeDays) {
    const joined = member.joinedTimestamp ?? Date.now();
    const days = (Date.now() - joined) / 86_400_000;
    if (days < requirements.minServerAgeDays) {
      return {
        ok: false,
        reason: `You must be in the server for **${requirements.minServerAgeDays}** days (you joined ${Math.floor(days)} days ago).`,
      };
    }
  }
  return { ok: true, member };
}

function drawWinners(item, count, exclude = []) {
  const pool = item.entries.filter((userId) => !exclude.includes(userId));
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, count);
}

async function announceWinners(features, item, winners, { reroll = false } = {}) {
  const guild = features.client?.guilds.cache.get(item.guildId);
  const channel = guild?.channels.cache.get(item.channelId);
  if (!guild || !channel?.isTextBased?.()) return;
  const mentions = winners.map((id) => `<@${id}>`).join(', ');
  if (winners.length === 0) {
    await channel
      .send({
        embeds: [
          embed(
            reroll ? 'No reroll winners' : 'Giveaway ended',
            `**${item.prize}** had no eligible entries, so there is no winner.`,
            COLORS.warn,
          ),
        ],
      })
      .catch(() => {});
    return;
  }
  await channel
    .send({
      content: `🎉 ${mentions}`,
      embeds: [
        embed(
          reroll ? '🔄 New winner(s)' : '🎉 Giveaway ended',
          `**${item.prize}**\n\n${
            winners.length === 1 ? 'Winner' : 'Winners'
          }: ${mentions}\nEntries: ${item.entries.length}${reroll ? '\nThis was a reroll.' : ''}`,
          COLORS.on,
        ),
      ],
      allowedMentions: { users: winners },
    })
    .catch(() => {});
}

export async function endGiveaway(features, item, { by = null, reroll = false } = {}) {
  const guild = features.client?.guilds.cache.get(item.guildId);
  if (!guild) return null;

  const missing = item.entries.filter((userId) => !guild.members.cache.get(userId)).slice(0, 100);
  if (missing.length) {
    await guild.members.fetch({ user: missing }).catch(() => {});
  }
  const eligible = item.entries.filter(
    (userId) => meetsRequirements(features, guild, userId, item.requirements ?? {}).ok,
  );
  item.entries = eligible;
  const previous = item.winnerIds ?? [];
  const winners = drawWinners(item, item.winners, reroll ? previous : []);
  item.winnerIds = reroll ? [...new Set([...previous, ...winners])] : winners;
  item.endedAt = Date.now();
  item.endedBy = by?.id ?? null;
  features.store.save();

  await refreshMessage(features, item, true);
  await announceWinners(features, item, winners, { reroll });
  features.bot?.log(
    'info',
    `[${guild.name}] Giveaway ${item.id} (${item.prize}) ${reroll ? 'rerolled' : 'ended'} with ${winners.length} winner(s).`,
  );
  return winners;
}

export async function sweepGiveaways(features) {
  const now = Date.now();
  for (const guild of features.client?.guilds.cache.values() ?? []) {
    const config = features.store.guild(guild.id).giveaways;
    for (const item of Object.values(config.items)) {
      if (!item.endedAt && item.endsAt <= now) {
        item.guildId = guild.id;
        await endGiveaway(features, item).catch((error) => {
          features.bot?.log('warn', `Giveaway ${item.id} could not be ended: ${error.message}`);
        });
      }
    }
  }
}

export async function handleGiveawayComponent(features, interaction) {
  if (!interaction.guildId) return false;
  const [prefix, action, id] = interaction.customId.split(':');
  if (prefix !== 'gw') return false;

  const config = features.store.guild(interaction.guildId).giveaways;
  const item = config.items[id];
  if (!item) {
    await interaction.reply({ embeds: [embed('Giveaway not found', 'This giveaway was removed.', COLORS.off)], flags: 64 });
    return true;
  }
  item.guildId = interaction.guildId;
  item.entries ??= [];

  if (action === 'enter' || action === 'leave') {
    if (item.endedAt) {
      await interaction.reply({ embeds: [embed('Giveaway ended', 'This giveaway is already over.', COLORS.off)], flags: 64 });
      return true;
    }
    if (action === 'leave') {
      const before = item.entries.length;
      item.entries = item.entries.filter((userId) => userId !== interaction.user.id);
      features.store.save();
      await refreshMessage(features, item);
      await interaction.reply({
        embeds: [
          embed(
            before === item.entries.length ? 'You were not entered' : 'You left the giveaway',
            before === item.entries.length ? 'You can enter any time before it ends.' : `**${item.prize}** — you can re-enter before it ends.`,
            COLORS.muted,
          ),
        ],
        flags: 64,
      });
      return true;
    }
    const check = meetsRequirements(
      features,
      interaction.guild,
      interaction.user.id,
      item.requirements ?? {},
      interaction.member,
    );
    if (!check.ok) {
      await interaction.reply({ embeds: [embed('Requirement not met', check.reason, COLORS.off)], flags: 64 });
      return true;
    }
    if (item.entries.includes(interaction.user.id)) {
      await interaction.reply({ embeds: [embed('Already entered', `You are entry **${item.entries.length}** for **${item.prize}**.`, COLORS.warn)], flags: 64 });
      return true;
    }
    if (item.entries.length >= 5000) {
      await interaction.reply({ embeds: [embed('Entry limit reached', 'This giveaway has reached its entry cap.', COLORS.off)], flags: 64 });
      return true;
    }
    item.entries.push(interaction.user.id);
    features.store.save();
    await refreshMessage(features, item);
    await interaction.reply({
      embeds: [embed('You are in! 🎉', `Entry **${item.entries.length}** for **${item.prize}**. Ends ${relative(item.endsAt)}.`, COLORS.on)],
      flags: 64,
    });
    return true;
  }

  if (action === 'reroll') {
    if (!canManageGuild(interaction.member) && interaction.user.id !== item.hostId) {
      await interaction.reply({ embeds: [embed('Not allowed', 'Only the host or **Manage Server** can reroll.', COLORS.off)], flags: 64 });
      return true;
    }
    if (!item.endedAt) {
      await interaction.reply({ embeds: [embed('Still running', 'End the giveaway before rerolling.', COLORS.off)], flags: 64 });
      return true;
    }
    await interaction.deferReply();
    const winners = await endGiveaway(features, item, { by: interaction.user, reroll: true });
    await interaction.editReply({
      embeds: [
        embed(
          'Reroll complete',
          winners?.length ? `New winner(s): ${winners.map((userId) => `<@${userId}>`).join(', ')}` : 'No eligible entries were left to reroll.',
          COLORS.on,
        ),
      ],
    });
    return true;
  }

  return false;
}

export async function startGiveaway(features, interaction, options) {
  const guild = interaction.guild;
  const channelId = options.channelId ?? interaction.channelId;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('Pick a text channel for the giveaway.');

  const config = features.store.guild(guild.id).giveaways;
  config.counter = (config.counter ?? 0) + 1;
  const id = `g${config.counter}${randomId(3)}`;
  const duration = parseDuration(options.duration);
  if (!duration) throw new Error('Duration looks wrong. Try `10m`, `2h` or `1d`.');
  if (duration < 30_000) throw new Error('A giveaway must run for at least 30 seconds.');
  if (duration > 90 * 86_400_000) throw new Error('That duration is too long (90 days max).');

  const item = {
    id,
    guildId: guild.id,
    channelId,
    messageId: null,
    prize: String(options.prize).slice(0, 200),
    description: options.description ? String(options.description).slice(0, 1000) : null,
    winners: Math.min(20, Math.max(1, Number(options.winners) || 1)),
    endsAt: Date.now() + duration,
    hostId: interaction.user.id,
    entries: [],
    winnerIds: [],
    endedAt: null,
    requirements: {
      roleId: options.roleId ?? null,
      minAccountAgeDays: Math.max(0, Number(options.minAccountAgeDays) || 0),
      minServerAgeDays: Math.max(0, Number(options.minServerAgeDays) || 0),
    },
  };
  config.items[id] = item;

  const message = await channel.send({
    embeds: [giveawayEmbed(item, guild)],
    components: giveawayRows(item),
  });
  item.messageId = message.id;
  features.store.save();
  features.bot?.log('info', `[${guild.name}] Giveaway started: ${item.prize} (${formatDuration(duration)}).`);
  return item;
}

/* ----------------------------------------------------------------- command --- */

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Create and manage giveaways')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('start')
          .setDescription('Start a giveaway')
          .addStringOption((option) => option.setName('prize').setDescription('What are you giving away?').setRequired(true).setMaxLength(200))
          .addStringOption((option) => option.setName('duration').setDescription('How long, e.g. 2h or 1d').setRequired(true).setMaxLength(20))
          .addIntegerOption((option) =>
            option.setName('winners').setDescription('Number of winners (1-20)').setRequired(false).setMinValue(1).setMaxValue(20),
          )
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Where to post it (default: here)').setRequired(false).addChannelTypes(0),
          )
          .addStringOption((option) => option.setName('description').setDescription('Extra text').setRequired(false).setMaxLength(1000))
          .addRoleOption((option) => option.setName('required-role').setDescription('Only this role can enter').setRequired(false))
          .addIntegerOption((option) =>
            option.setName('min-account-age').setDescription('Minimum account age in days').setRequired(false).setMinValue(0).setMaxValue(3650),
          )
          .addIntegerOption((option) =>
            option.setName('min-server-age').setDescription('Minimum days in the server').setRequired(false).setMinValue(0).setMaxValue(3650),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('end')
          .setDescription('End a giveaway now')
          .addStringOption((option) => option.setName('id').setDescription('Giveaway ID').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reroll')
          .setDescription('Draw new winners')
          .addStringOption((option) => option.setName('id').setDescription('Giveaway ID').setRequired(true))
          .addIntegerOption((option) =>
            option.setName('winners').setDescription('How many winners to draw').setRequired(false).setMinValue(1).setMaxValue(20),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List giveaways')),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server** to run giveaways.', COLORS.off)], flags: 64 });
        return;
      }
      const config = features.store.guild(interaction.guildId).giveaways;
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'start') {
        try {
          const item = await startGiveaway(features, interaction, {
            prize: interaction.options.getString('prize', true),
            duration: interaction.options.getString('duration', true),
            winners: interaction.options.getInteger('winners') ?? 1,
            channelId: interaction.options.getChannel('channel')?.id,
            description: interaction.options.getString('description'),
            roleId: interaction.options.getRole('required-role')?.id,
            minAccountAgeDays: interaction.options.getInteger('min-account-age'),
            minServerAgeDays: interaction.options.getInteger('min-server-age'),
          });
          await interaction.reply({
            embeds: [embed('Giveaway started', `**${item.prize}** ends ${relative(item.endsAt)} in <#${item.channelId}>.`, COLORS.on)],
            flags: 64,
          });
        } catch (error) {
          await interaction.reply({ embeds: [embed('Could not start', error.message, COLORS.off)], flags: 64 });
        }
        return;
      }

      if (subcommand === 'list') {
        const items = Object.values(config.items).sort((a, b) => b.endsAt - a.endsAt).slice(0, 20);
        await interaction.reply({
          embeds: [
            embed(
              'Giveaways',
              items.length
                ? items
                    .map(
                      (item) =>
                        `\`${item.id}\` · **${item.prize}** · ${
                          item.endedAt ? `ended ${relative(item.endedAt)}` : `ends ${relative(item.endsAt)}`
                        } · ${item.entries.length} entries`,
                    )
                    .join('\n')
                : 'No giveaways yet. Start one with `/giveaway start`.',
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      const id = interaction.options.getString('id', true).trim();
      const item = config.items[id];
      if (!item) {
        await interaction.reply({ embeds: [embed('Giveaway not found', `No giveaway with ID \`${id}\`.`, COLORS.off)], flags: 64 });
        return;
      }
      item.guildId = interaction.guildId;

      if (subcommand === 'end') {
        if (item.endedAt) {
          await interaction.reply({ embeds: [embed('Already ended', 'Use `/giveaway reroll` to draw new winners.', COLORS.warn)], flags: 64 });
          return;
        }
        await interaction.deferReply({ flags: 64 });
        const winners = await endGiveaway(features, item, { by: interaction.user });
        await interaction.editReply({
          embeds: [
            embed(
              'Giveaway ended',
              winners?.length
                ? `Winner(s): ${winners.map((userId) => `<@${userId}>`).join(', ')}`
                : 'No eligible entries, so there is no winner.',
              winners?.length ? COLORS.on : COLORS.warn,
            ),
          ],
        });
        return;
      }

      if (subcommand === 'reroll') {
        const requested = interaction.options.getInteger('winners');
        if (requested) item.winners = requested;
        if (!item.endedAt) item.endedAt = Date.now();
        await interaction.deferReply({ flags: 64 });
        const winners = await endGiveaway(features, item, { by: interaction.user, reroll: true });
        await interaction.editReply({
          embeds: [
            embed(
              'Rerolled',
              winners?.length
                ? `New winner(s): ${winners.map((userId) => `<@${userId}>`).join(', ')}`
                : 'No eligible entries were left.',
              COLORS.on,
            ),
          ],
        });
      }
    },
  },
];
