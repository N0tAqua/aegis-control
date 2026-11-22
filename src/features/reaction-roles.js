import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { COLORS, canManageGuild, embed, randomId, truncate } from './util.js';

function panelRow(panel) {
  const options = panel.options ?? [];
  if (panel.mode === 'select') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rr:s:${panel.id}`)
      .setPlaceholder(truncate(panel.title || 'Choose your roles', 100))
      .setMinValues(panel.multiple ? 0 : 0)
      .setMaxValues(panel.multiple ? Math.max(1, options.length) : 1);
    for (const option of options.slice(0, 25)) {
      menu.addOptions({
        label: truncate(option.label || option.roleId, 100),
        value: option.roleId,
        description: option.description ? truncate(option.description, 100) : undefined,
        emoji: option.emoji || undefined,
      });
    }
    return [new ActionRowBuilder().addComponents(menu)];
  }

  const rows = [];
  for (let index = 0; index < options.length && rows.length < 5; index += 5) {
    const row = new ActionRowBuilder();
    for (const option of options.slice(index, index + 5)) {
      const button = new ButtonBuilder()
        .setCustomId(`rr:t:${panel.id}:${option.roleId}`)
        .setLabel(truncate(option.label || option.roleId, 80))
        .setStyle(ButtonStyle.Secondary);
      if (option.emoji) button.setEmoji(option.emoji);
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

function panelPayload(panel) {
  const built = embed(panel.title || 'Self-assignable roles', panel.description || 'Pick the roles you want below.', COLORS.brand);
  const options = panel.options ?? [];
  if (options.length === 0) built.setFooter({ text: 'No roles added yet.' });
  else built.setFooter({ text: `${options.length} role(s) · ${panel.mode === 'select' ? 'dropdown' : 'buttons'}` });
  return { embeds: [built], components: options.length ? panelRow(panel) : [] };
}

async function postPanel(features, guild, panel) {
  const channel =
    guild.channels.cache.get(panel.channelId) ?? (await guild.channels.fetch(panel.channelId).catch(() => null));
  if (!channel?.isTextBased?.()) throw new Error('The panel channel no longer exists.');

  if (panel.messageId) {
    const previous = await channel.messages.fetch(panel.messageId).catch(() => null);
    if (previous) await previous.delete().catch(() => {});
    panel.messageId = null;
  }

  const message = await channel.send(panelPayload(panel));
  panel.messageId = message.id;
  features.store.save();
  return message;
}

async function checkRole(features, guild, roleId) {
  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) return { error: 'That role no longer exists. Remove it from the panel.' };
  if (role.id === guild.id) return { error: 'The @everyone role cannot be self-assigned.' };
  if (role.managed) return { error: 'That role is managed by an integration and cannot be self-assigned.' };
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { error: 'Aegis needs the **Manage Roles** permission.' };
  }
  if (role.position >= me.roles.highest.position) {
    return { error: `**${role.name}** is above Aegis's highest role. Move Aegis's role higher to manage it.` };
  }
  return { role };
}

export async function handleReactionRoleComponent(features, interaction) {
  if (!interaction.guildId || !interaction.member) return false;
  const [prefix, kind, panelId, roleId] = interaction.customId.split(':');
  if (prefix !== 'rr') return false;

  const guild = interaction.guild;
  const config = features.store.guild(guild.id).reactionRoles;
  const panel = config.panels[panelId];
  if (!panel) {
    await interaction.reply({ embeds: [embed('Panel expired', 'That role panel no longer exists.', COLORS.off)], flags: 64 });
    return true;
  }

  if (kind === 't') {
    const option = panel.options.find((entry) => entry.roleId === roleId);
    if (!option) {
      await interaction.reply({ embeds: [embed('Role removed', 'That role is no longer on this panel.', COLORS.off)], flags: 64 });
      return true;
    }
    const checked = await checkRole(features, guild, roleId);
    if (checked.error) {
      await interaction.reply({ embeds: [embed('Cannot assign that role', checked.error, COLORS.off)], flags: 64 });
      return true;
    }
    const hasRole = interaction.member.roles.cache.has(roleId);
    if (!panel.multiple && !hasRole) {
      for (const other of panel.options) {
        if (other.roleId !== roleId && interaction.member.roles.cache.has(other.roleId)) {
          await interaction.member.roles.remove(other.roleId, 'Reaction roles: single choice').catch(() => {});
        }
      }
    }
    try {
      if (hasRole) await interaction.member.roles.remove(roleId, 'Self-assigned via role panel');
      else await interaction.member.roles.add(roleId, 'Self-assigned via role panel');
    } catch (error) {
      await interaction.reply({
        embeds: [embed('Could not update your roles', error.message, COLORS.off)],
        flags: 64,
      });
      return true;
    }
    await interaction.reply({
      embeds: [
        embed(
          hasRole ? 'Role removed' : 'Role added',
          `${hasRole ? 'Removed' : 'Added'} **${checked.role.name}**.`,
          hasRole ? COLORS.off : COLORS.on,
        ),
      ],
      flags: 64,
    });
    return true;
  }

  if (kind === 's') {
    const selected = new Set(interaction.values ?? []);
    const added = [];
    const removed = [];
    for (const option of panel.options) {
      const checked = await checkRole(features, guild, option.roleId);
      if (checked.error) continue;
      const hasRole = interaction.member.roles.cache.has(option.roleId);
      if (selected.has(option.roleId) && !hasRole) {
        await interaction.member.roles.add(option.roleId, 'Self-assigned via role dropdown').catch(() => {});
        added.push(checked.role.name);
      } else if (!selected.has(option.roleId) && hasRole) {
        await interaction.member.roles.remove(option.roleId, 'Self-assigned via role dropdown').catch(() => {});
        removed.push(checked.role.name);
      }
    }
    await interaction.reply({
      embeds: [
        embed(
          'Roles updated',
          [
            added.length ? `➕ ${added.join(', ')}` : null,
            removed.length ? `➖ ${removed.join(', ')}` : null,
            !added.length && !removed.length ? 'Nothing changed.' : null,
          ]
            .filter(Boolean)
            .join('\n'),
          COLORS.on,
        ),
      ],
      flags: 64,
    });
    return true;
  }

  return false;
}

/* ----------------------------------------------------------------- command --- */

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('reactionroles')
      .setDescription('Self-assignable roles with buttons or a dropdown')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand((sub) =>
        sub
          .setName('panel')
          .setDescription('Create or edit a role panel')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Channel for the panel').setRequired(true).addChannelTypes(0),
          )
          .addStringOption((option) =>
            option.setName('title').setDescription('Panel title').setRequired(false).setMaxLength(200),
          )
          .addStringOption((option) =>
            option.setName('description').setDescription('Panel text').setRequired(false).setMaxLength(1500),
          )
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('Buttons or a dropdown')
              .setRequired(false)
              .addChoices({ name: 'Buttons', value: 'buttons' }, { name: 'Dropdown', value: 'select' }),
          )
          .addBooleanOption((option) =>
            option.setName('multiple').setDescription('Allow more than one role (dropdown)').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a role to a panel')
          .addStringOption((option) => option.setName('panel').setDescription('Panel ID').setRequired(true))
          .addRoleOption((option) => option.setName('role').setDescription('Role to hand out').setRequired(true))
          .addStringOption((option) => option.setName('label').setDescription('Button label').setRequired(false).setMaxLength(80))
          .addStringOption((option) => option.setName('emoji').setDescription('Optional emoji').setRequired(false).setMaxLength(60))
          .addStringOption((option) =>
            option.setName('description').setDescription('Dropdown description').setRequired(false).setMaxLength(100),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a role from a panel')
          .addStringOption((option) => option.setName('panel').setDescription('Panel ID').setRequired(true))
          .addRoleOption((option) => option.setName('role').setDescription('Role to remove').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('post')
          .setDescription('Post or refresh the panel message')
          .addStringOption((option) => option.setName('panel').setDescription('Panel ID').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List role panels'))
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a panel and its message')
          .addStringOption((option) => option.setName('panel').setDescription('Panel ID').setRequired(true)),
      ),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({
          embeds: [embed('Missing permission', 'You need **Manage Server** to edit role panels.', COLORS.off)],
          flags: 64,
        });
        return;
      }
      const config = features.store.guild(interaction.guildId).reactionRoles;
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'panel') {
        const channel = interaction.options.getChannel('channel', true);
        const id = randomId(5);
        const panel = {
          id,
          channelId: channel.id,
          messageId: null,
          title: interaction.options.getString('title') ?? 'Self-assignable roles',
          description:
            interaction.options.getString('description') ?? 'Pick the roles you want below.',
          mode: interaction.options.getString('mode') ?? 'buttons',
          multiple: interaction.options.getBoolean('multiple') ?? true,
          options: [],
          createdAt: Date.now(),
        };
        config.panels[id] = panel;
        features.store.save();
        await interaction.reply({
          embeds: [
            embed(
              'Role panel created',
              `Panel ID: \`${id}\`\nAdd roles with \`/reactionroles add panel:${id} role:@Role\`, then post it with \`/reactionroles post panel:${id}\`.`,
              COLORS.on,
            ),
          ],
          flags: 64,
        });
        return;
      }

      const panelId = interaction.options.getString('panel');
      const panel = panelId ? config.panels[panelId] : null;
      if (panelId && !panel) {
        await interaction.reply({ embeds: [embed('Panel not found', `No panel with ID \`${panelId}\`.`, COLORS.off)], flags: 64 });
        return;
      }

      if (subcommand === 'add') {
        if (panel.options.length >= 25) {
          await interaction.reply({ embeds: [embed('Panel full', 'A panel supports up to 25 roles.', COLORS.off)], flags: 64 });
          return;
        }
        const role = interaction.options.getRole('role', true);
        const checked = await checkRole(features, interaction.guild, role.id);
        if (checked.error) {
          await interaction.reply({ embeds: [embed('Cannot use that role', checked.error, COLORS.off)], flags: 64 });
          return;
        }
        if (panel.options.some((option) => option.roleId === role.id)) {
          await interaction.reply({ embeds: [embed('Already added', `**${role.name}** is already on this panel.`, COLORS.warn)], flags: 64 });
          return;
        }
        panel.options.push({
          roleId: role.id,
          label: interaction.options.getString('label') ?? role.name,
          emoji: interaction.options.getString('emoji') ?? null,
          description: interaction.options.getString('description') ?? null,
        });
        features.store.save();
        if (panel.messageId) await postPanel(features, interaction.guild, panel).catch(() => {});
        await interaction.reply({
          embeds: [
            embed(
              'Role added',
              `**${role.name}** is on panel \`${panel.id}\`${panel.messageId ? ' and the message was refreshed' : '. Post it with `/reactionroles post`'}.`,
              COLORS.on,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'remove') {
        const role = interaction.options.getRole('role', true);
        const before = panel.options.length;
        panel.options = panel.options.filter((option) => option.roleId !== role.id);
        features.store.save();
        if (panel.messageId && panel.options.length !== before) {
          await postPanel(features, interaction.guild, panel).catch(() => {});
        }
        await interaction.reply({
          embeds: [
            embed(
              before === panel.options.length ? 'Not on the panel' : 'Role removed',
              before === panel.options.length
                ? `**${role.name}** was not on panel \`${panel.id}\`.`
                : `Removed **${role.name}** from panel \`${panel.id}\`.`,
              before === panel.options.length ? COLORS.warn : COLORS.on,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'post') {
        if (panel.options.length === 0) {
          await interaction.reply({ embeds: [embed('Nothing to post', 'Add at least one role first.', COLORS.warn)], flags: 64 });
          return;
        }
        const message = await postPanel(features, interaction.guild, panel);
        await interaction.reply({
          embeds: [embed('Panel posted', `Posted in <#${panel.channelId}>: ${message.url}`, COLORS.on)],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'delete') {
        const channel = await interaction.guild.channels.fetch(panel.channelId).catch(() => null);
        if (channel?.isTextBased?.() && panel.messageId) {
          const message = await channel.messages.fetch(panel.messageId).catch(() => null);
          await message?.delete().catch(() => {});
        }
        delete config.panels[panel.id];
        features.store.save();
        await interaction.reply({
          embeds: [embed('Panel deleted', `Panel \`${panel.id}\` was removed.`, COLORS.on)],
          flags: 64,
        });
        return;
      }

      const panels = Object.values(config.panels);
      if (panels.length === 0) {
        await interaction.reply({
          embeds: [embed('No role panels', 'Create one with `/reactionroles panel`.', COLORS.muted)],
          flags: 64,
        });
        return;
      }
      await interaction.reply({
        embeds: [
          embed(
            'Role panels',
            panels
              .map(
                (entry) =>
                  `\`${entry.id}\` · <#${entry.channelId}> · ${entry.options.length} role(s) · ${
                    entry.mode === 'select' ? 'dropdown' : 'buttons'
                  }`,
              )
              .join('\n'),
            COLORS.brand,
          ),
        ],
        flags: 64,
      });
    },
  },
];
