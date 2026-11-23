import {
  ActionRowBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { COLORS, canManageGuild, embed, number, randomId } from './util.js';

export function economyState(features, guildId) {
  const config = features.store.guild(guildId);
  config.economy ??= {
    enabled: true,
    perMessage: 3,
    perVoiceMinute: 2,
    cooldownSec: 45,
    minLength: 6,
    items: {},
    balances: {},
    log: [],
  };
  return config.economy;
}

export function shopItems(features, guildId) {
  const config = economyState(features, guildId);
  return Object.entries(config.items ?? {}).map(([id, item]) => ({
    id,
    ...item,
    name: item.name || item.roleName || 'Role reward',
  }));
}

export function economySummary(features, guildId) {
  const config = economyState(features, guildId);
  const balances = Object.entries(config.balances ?? {});
  const top = balances
    .map(([userId, entry]) => ({ userId, coins: Number(entry.coins) || 0, earned: Number(entry.earned) || 0 }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 8);
  return {
    enabled: Boolean(config.enabled),
    perMessage: config.perMessage,
    perVoiceMinute: config.perVoiceMinute,
    cooldownSec: config.cooldownSec,
    minLength: config.minLength,
    items: shopItems(features, guildId),
    top,
    holders: balances.length,
    total: balances.reduce((sum, [, entry]) => sum + (Number(entry.coins) || 0), 0),
    recent: (config.log ?? []).slice(0, 8),
  };
}

function balanceFor(config, userId) {
  config.balances ??= {};
  if (!config.balances[userId]) config.balances[userId] = { coins: 0, earned: 0, spent: 0, lastEarn: 0 };
  return config.balances[userId];
}

function log(config, text) {
  config.log = [{ at: Date.now(), text: String(text).slice(0, 180) }, ...(config.log ?? [])].slice(0, 30);
}

export function recordEconomyMessage(features, message) {
  if (!message.guild || message.author?.bot) return;
  const config = economyState(features, message.guild.id);
  if (!config.enabled) return;
  const text = String(message.content ?? '');
  if (text.length < Math.max(0, config.minLength) && (message.attachments?.size ?? 0) === 0) return;
  const entry = balanceFor(config, message.author.id);
  const cooldown = Math.max(0, Number(config.cooldownSec) || 0) * 1000;
  if (Date.now() - (entry.lastEarn ?? 0) < cooldown) return;
  const amount = Math.max(1, Math.round(Number(config.perMessage) || 3));
  entry.coins += amount;
  entry.earned += amount;
  entry.lastEarn = Date.now();
  features.store.save();
}

export function trackEconomyVoice(features, oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  const member = newState.member ?? oldState.member;
  if (!guild || !member || member.user?.bot) return;
  const config = economyState(features, guild.id);
  if (!config.enabled || !Number(config.perVoiceMinute)) return;

  features.economyVoice ??= new Map();
  const key = `${guild.id}:${member.id}`;
  const wasIn = Boolean(oldState.channelId) && oldState.channelId !== guild.afkChannelId;
  const isIn = Boolean(newState.channelId) && newState.channelId !== guild.afkChannelId;

  if (!wasIn && isIn) {
    features.economyVoice.set(key, Date.now());
    return;
  }
  if (wasIn && !isIn) {
    const started = features.economyVoice.get(key);
    features.economyVoice.delete(key);
    if (!started) return;
    const minutes = Math.min(240, Math.floor((Date.now() - started) / 60_000));
    if (minutes < 1) return;
    const amount = minutes * Math.max(0, Math.round(Number(config.perVoiceMinute) || 0));
    if (amount <= 0) return;
    const entry = balanceFor(config, member.id);
    entry.coins += amount;
    entry.earned += amount;
    features.store.save();
  }
}

export async function buyItem(features, guild, member, itemId) {
  const config = economyState(features, guild.id);
  const item = config.items?.[itemId];
  if (!item) throw new Error('That reward is no longer in the shop.');
  const entry = balanceFor(config, member.id);
  const price = Math.max(0, Math.round(Number(item.price) || 0));
  if (entry.coins < price) {
    throw new Error(`You need **${number(price)}** coins — you have **${number(entry.coins)}**.`);
  }
  if (Number(item.stock) === 0) throw new Error('That reward is sold out.');
  const role = guild.roles.cache.get(item.roleId);
  if (!role) throw new Error('The shop role no longer exists.');
  if (member.roles.cache.has(role.id)) throw new Error(`You already have **${role.name}**.`);
  if (!role.editable) throw new Error('Aegis cannot give that role — it is above Aegis in the role list.');

  await member.roles.add(role, `Aegis shop purchase (${price} coins)`);
  entry.coins -= price;
  entry.spent = (entry.spent ?? 0) + price;
  if (Number(item.stock) > 0) item.stock = Number(item.stock) - 1;
  log(config, `${member.user.tag} bought ${role.name} for ${price} coins.`);
  features.store.save();
  return { role, price, balance: entry.coins };
}

function shopMenu(features, guild, member) {
  const config = economyState(features, guild.id);
  const entry = balanceFor(config, member.id);
  const items = shopItems(features, guild.id).slice(0, 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('eco:buy')
    .setPlaceholder(items.length ? 'Choose a reward to buy' : 'The shop is empty')
    .setDisabled(items.length === 0)
    .addOptions(
      items.map((item) => {
        const role = guild.roles.cache.get(item.roleId);
        const stock = Number(item.stock) === 0 ? ' · sold out' : Number(item.stock) > 0 ? ` · ${item.stock} left` : '';
        return {
          label: `${item.name} — ${number(item.price)} coins`.slice(0, 100),
          description: `${role ? `Gives @${role.name}` : 'Role missing'}${stock}`.slice(0, 100),
          value: item.id,
          emoji: '🛍️',
        };
      }),
    );
  return {
    embeds: [
      embed(
        '🛍️ Server shop',
        [
          `You have **${number(entry.coins)}** coins.`,
          items.length
            ? items.map((item) => `• **${item.name}** — ${number(item.price)} coins${Number(item.stock) === 0 ? ' _(sold out)_' : ''}`).join('\n')
            : 'No rewards yet. Add one with `/shop add`.',
          '',
          '_Earn coins by chatting and hanging out in voice._',
        ].join('\n'),
        COLORS.brand,
      ),
    ],
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

export async function handleEconomyComponent(features, interaction) {
  if (!interaction.customId.startsWith('eco:')) return false;
  const action = interaction.customId.split(':')[1];
  if (action !== 'buy') return false;
  const itemId = interaction.values?.[0];
  try {
    const result = await buyItem(features, interaction.guild, interaction.member, itemId);
    await interaction.reply({
      embeds: [embed('Purchase complete', `You now have <@&${result.role.id}> — **${number(result.balance)}** coins left.`, COLORS.on)],
      flags: 64,
    });
  } catch (error) {
    await interaction.reply({ embeds: [embed('Could not buy that', error.message, COLORS.off)], flags: 64 });
  }
  return true;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('coins')
      .setDescription('Server currency earned from chatting and voice')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) =>
        sub
          .setName('balance')
          .setDescription('Show your balance, or someone else’s')
          .addUserOption((option) => option.setName('user').setDescription('Who to check').setRequired(false)),
      )
      .addSubcommand((sub) => sub.setName('top').setDescription('Richest members'))
      .addSubcommand((sub) =>
        sub
          .setName('give')
          .setDescription('Add coins to a member (staff only)')
          .addUserOption((option) => option.setName('user').setDescription('Who receives them').setRequired(true))
          .addIntegerOption((option) => option.setName('amount').setDescription('How many').setRequired(true).setMinValue(1).setMaxValue(100000)),
      ),

    async execute(interaction, { features }) {
      const config = economyState(features, interaction.guild.id);
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'balance') {
        const user = interaction.options.getUser('user') ?? interaction.user;
        const entry = balanceFor(config, user.id);
        await interaction.reply({
          embeds: [
            embed(
              `${user.username}’s balance`,
              [`**${number(entry.coins)}** coins`, `Earned ${number(entry.earned)} · spent ${number(entry.spent ?? 0)}`].join('\n'),
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'top') {
        const summary = economySummary(features, interaction.guild.id);
        await interaction.reply({
          embeds: [
            embed(
              '💰 Coin leaderboard',
              summary.top.length
                ? summary.top.map((row, index) => `**${index + 1}.** <@${row.userId}> — ${number(row.coins)}`).join('\n')
                : 'Nobody has earned coins yet.',
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      const user = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      const entry = balanceFor(config, user.id);
      entry.coins += amount;
      entry.earned += amount;
      log(config, `${interaction.user.username} gave ${amount} coins to ${user.tag}.`);
      features.store.save();
      await interaction.reply({
        embeds: [embed('Coins added', `<@${user.id}> now has **${number(entry.coins)}** coins.`, COLORS.on)],
        flags: 64,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('shop')
      .setDescription('Spend server coins on roles')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) => sub.setName('browse').setDescription('Open the shop'))
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a role reward (staff only)')
          .addRoleOption((option) => option.setName('role').setDescription('Role to sell').setRequired(true))
          .addIntegerOption((option) => option.setName('price').setDescription('Coins needed').setRequired(true).setMinValue(0).setMaxValue(1000000))
          .addIntegerOption((option) => option.setName('stock').setDescription('How many can be bought, 0 for unlimited').setRequired(false).setMinValue(0).setMaxValue(10000))
          .addStringOption((option) => option.setName('label').setDescription('Shop name, defaults to the role name').setRequired(false).setMaxLength(80)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a reward (staff only)')
          .addStringOption((option) => option.setName('id').setDescription('Reward ID from /shop browse').setRequired(true)),
      ),

    async execute(interaction, { features }) {
      const guild = interaction.guild;
      const config = economyState(features, guild.id);
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'browse') {
        const payload = shopMenu(features, guild, interaction.member);
        await interaction.reply({ ...payload, flags: 64 });
        return;
      }

      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }

      if (subcommand === 'remove') {
        const id = interaction.options.getString('id', true).trim();
        if (!config.items?.[id]) {
          await interaction.reply({ embeds: [embed('No such reward', 'Copy the ID shown in the shop footer.', COLORS.off)], flags: 64 });
          return;
        }
        const name = config.items[id].name;
        delete config.items[id];
        features.store.save();
        await interaction.reply({ embeds: [embed('Reward removed', `**${name}** is no longer in the shop.`, COLORS.muted)], flags: 64 });
        return;
      }

      const role = interaction.options.getRole('role', true);
      const price = interaction.options.getInteger('price', true);
      const itemId = randomId(6);
      config.items ??= {};
      config.items[itemId] = {
        roleId: role.id,
        name: interaction.options.getString('label')?.trim() || role.name,
        price,
        stock: interaction.options.getInteger('stock') ?? 0,
        createdBy: interaction.user.id,
        createdAt: Date.now(),
      };
      features.store.save();
      await interaction.reply({
        embeds: [
          embed(
            'Reward added',
            `<@&${role.id}> costs **${number(price)}** coins${Number(config.items[itemId].stock) > 0 ? `, ${config.items[itemId].stock} in stock` : ''}.\nReward ID: \`${itemId}\``,
            COLORS.on,
          ),
        ],
        flags: 64,
      });
    },
  },
];
