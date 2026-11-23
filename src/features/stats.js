import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, canManageGuild, embed, number } from './util.js';

const REFRESH_MS = 10 * 60_000;

export function statsState(features, guildId) {
  const config = features.store.guild(guildId);
  config.stats ??= { enabled: false, categoryId: null, channels: {}, lastRunAt: 0, lastNames: {} };
  return config.stats;
}

export function statsSummary(features, guildId) {
  const config = statsState(features, guildId);
  return {
    enabled: Boolean(config.enabled),
    categoryId: config.categoryId ?? null,
    channels: { ...(config.channels ?? {}) },
    lastRunAt: config.lastRunAt ?? 0,
    lastNames: { ...(config.lastNames ?? {}) },
  };
}

function namesFor(guild) {
  return {
    members: `👥 Members: ${number(guild.memberCount)}`,
    boosts: `🚀 Boosts: ${number(guild.premiumSubscriptionCount ?? 0)}`,
    channels: `#️⃣ Channels: ${number(guild.channels.cache.size)}`,
  };
}

export async function updateStats(features, guild) {
  const config = statsState(features, guild.id);
  if (!config.enabled) return { updated: 0 };
  const wanted = namesFor(guild);
  let updated = 0;
  for (const [key, channelId] of Object.entries(config.channels ?? {})) {
    const name = wanted[key];
    if (!name) continue;
    if (config.lastNames?.[key] === name) continue;
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel) continue;
    if (channel.name === name) {
      config.lastNames[key] = name;
      continue;
    }
    const done = await channel.setName(name, 'Aegis server stats').then(() => true).catch(() => false);
    if (done) {
      config.lastNames[key] = name;
      updated += 1;
    }
  }
  config.lastRunAt = Date.now();
  features.store.save();
  return { updated, names: wanted };
}

export async function setupStats(features, guild, { categoryName = '📊 Server Stats' } = {}) {
  const me = guild.members.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) throw new Error('Aegis needs **Manage Channels**.');
  const config = statsState(features, guild.id);
  let category = config.categoryId ? guild.channels.cache.get(config.categoryId) : null;
  if (!category || category.type !== ChannelType.GuildCategory) {
    category = await guild.channels.create({
      name: String(categoryName).slice(0, 90),
      type: ChannelType.GuildCategory,
      reason: 'Aegis server stats',
    });
    config.categoryId = category.id;
  }

  const keys = ['members', 'boosts', 'channels'];
  for (const key of keys) {
    const existing = config.channels?.[key] ? guild.channels.cache.get(config.channels[key]) : null;
    if (existing) continue;
    const channel = await guild.channels.create({
      name: namesFor(guild)[key],
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.Connect],
        },
      ],
      reason: 'Aegis server stats',
    });
    config.channels[key] = channel.id;
  }

  config.enabled = true;
  config.lastNames = {};
  config.lastRunAt = 0;
  features.store.save();
  const result = await updateStats(features, guild);
  return { category, names: result.names ?? namesFor(guild) };
}

export async function disableStats(features, guild) {
  const config = statsState(features, guild.id);
  config.enabled = false;
  for (const channelId of Object.values(config.channels ?? {})) {
    const channel = guild.channels.cache.get(channelId);
    await channel?.delete('Aegis server stats disabled').catch(() => {});
  }
  config.channels = {};
  config.lastNames = {};
  features.store.save();
  return true;
}

export async function sweepStats(features) {
  const client = features.client;
  if (!client) return;
  for (const guild of client.guilds.cache.values()) {
    const config = statsState(features, guild.id);
    if (!config.enabled) continue;
    if (Date.now() - (config.lastRunAt ?? 0) < REFRESH_MS - 60_000) continue;
    await updateStats(features, guild).catch((error) => {
      features.bot?.log('warn', `Stats refresh failed: ${error.message}`);
    });
  }
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Live member, boost and channel counters in voice channels')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Create the counter channels')
          .addStringOption((option) => option.setName('category').setDescription('Category name').setRequired(false).setMaxLength(90)),
      )
      .addSubcommand((sub) => sub.setName('off').setDescription('Remove the counter channels'))
      .addSubcommand((sub) => sub.setName('status').setDescription('Show counter settings')),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      const guild = interaction.guild;

      if (subcommand === 'status') {
        const summary = statsSummary(features, guild.id);
        await interaction.reply({
          embeds: [
            embed(
              summary.enabled ? '📊 Server stats are on' : 'Server stats are off',
              summary.enabled
                ? [
                    `**Category:** ${summary.categoryId ? `<#${summary.categoryId}>` : 'missing'}`,
                    ...Object.entries(summary.lastNames ?? {}).map(([key, name]) => `• ${name}`),
                    `**Last refresh:** ${summary.lastRunAt ? `<t:${Math.floor(summary.lastRunAt / 1000)}:R>` : 'never'}`,
                  ].join('\n')
                : 'Use `/stats setup` to create the counters.',
              summary.enabled ? COLORS.on : COLORS.muted,
            ),
          ],
          flags: 64,
        });
        return;
      }

      await interaction.deferReply({ flags: 64 });
      try {
        if (subcommand === 'off') {
          await disableStats(features, guild);
          await interaction.editReply({ embeds: [embed('Stats removed', 'The counter channels were deleted.', COLORS.muted)] });
          return;
        }
        const result = await setupStats(features, guild, {
          categoryName: interaction.options.getString('category') ?? '📊 Server Stats',
        });
        await interaction.editReply({
          embeds: [
            embed(
              '📊 Stats created',
              [
                `Category: <#${result.category.id}>`,
                ...Object.values(result.names).map((name) => `• ${name}`),
                '',
                '_They refresh every 10 minutes. Members cannot join them._',
              ].join('\n'),
              COLORS.on,
            ),
          ],
        });
      } catch (error) {
        await interaction.editReply({ embeds: [embed('Could not set up stats', error.message, COLORS.off)] });
      }
    },
  },
];
