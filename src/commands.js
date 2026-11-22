import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { featureCommands } from './features/commands.js';

const ON_COLOR = 0x38e8b0;
const OFF_COLOR = 0xff6482;
const INFO_COLOR = 0x6f9bff;

const EIGHT_BALL = [
  'It is certain.',
  'Without a doubt.',
  'Yes — definitely.',
  'Most likely.',
  'Outlook good.',
  'Signs point to yes.',
  'Reply hazy, try again.',
  'Ask again later.',
  'Cannot predict now.',
  "Don't count on it.",
  'My reply is no.',
  'Very doubtful.',
];

function embed(title, description, color = INFO_COLOR, footer) {
  const message = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
  if (footer) message.setFooter({ text: footer });
  return message;
}

function memberLine(guild, role) {
  return `**${role.name}** · ${role.members.size} member(s)`;
}

function roleColorText(role) {
  return `#${role.color.toString(16).padStart(6, '0')}`;
}

function hierarchyProblem(guild, role) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'Aegis is missing the **Manage Roles** permission.';
  }
  if (role.id === guild.id) return 'The @everyone role cannot be changed or deleted.';
  if (role.managed) return 'That role is managed by an integration and cannot be changed.';
  if (role.position >= me.roles.highest.position) {
    return "That role sits at or above Aegis's highest role, so Aegis cannot manage it. Move Aegis's role higher.";
  }
  return null;
}

/* ------------------------------------------------------------- protection --- */

function buildProtectionCommand({ name, description, key, label }) {
  return {
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .setContexts(InteractionContextType.Guild)
      .addUserOption((option) =>
        option
          .setName('user')
          .setDescription('Apply to one member only (omit to cover the whole server)')
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('enabled')
          .setDescription('On or off; omit to flip the current value')
          .setRequired(false),
      ),

    async execute(interaction, { bot }) {
      const guildId = interaction.guildId;
      const target = interaction.options.getUser('user');
      const requested = interaction.options.getBoolean('enabled');

      if (!target) {
        const current = bot.getGuildSettings(guildId)[key];
        const next = requested === null ? !current : requested;
        const settings = await bot.setGuildSetting(guildId, key, next);
        const on = settings[key];
        await interaction.reply({
          embeds: [
            embed(
              `${label}: ${on ? 'ON' : 'OFF'}`,
              on
                ? `Every member in this server is protected from **${label.toLowerCase()}**.`
                : `Server-wide ${label.toLowerCase()} is off. Per-member rules still apply.`,
              on ? ON_COLOR : OFF_COLOR,
              `Requested by ${interaction.user.tag}`,
            ),
          ],
          ephemeral: true,
        });
        return;
      }

      const current = bot.getMemberSettings(guildId, target.id)[key];
      const inherited = bot.getGuildSettings(guildId)[key];
      const effective = current === null ? inherited : current;
      const next = requested === null ? !effective : requested;
      await bot.setMemberSetting(guildId, target.id, key, next);

      await interaction.reply({
        embeds: [
          embed(
            `${label} for @${target.username}: ${next ? 'ON' : 'OFF'}`,
            next
              ? `This overrides the server setting for that member. Aegis will remove any **${label.toLowerCase()}** they receive.`
              : `That member is now exempt from **${label.toLowerCase()}**, even if the server-wide switch is on.`,
            next ? ON_COLOR : OFF_COLOR,
            `Requested by ${interaction.user.tag}`,
          ),
        ],
        ephemeral: true,
      });
    },
  };
}

function buildForceCommand({ name, description, forceKey, kindLabel }) {
  return {
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .setContexts(InteractionContextType.Guild)
      .addUserOption((option) =>
        option.setName('user').setDescription('The member to hold in place').setRequired(true),
      )
      .addBooleanOption((option) =>
        option
          .setName('enabled')
          .setDescription('On or off; omit to flip the current value')
          .setRequired(false),
      ),

    async execute(interaction, { bot }) {
      const guild = interaction.guild;
      const user = interaction.options.getUser('user', true);
      const requested = interaction.options.getBoolean('enabled');
      const current = bot.getMemberSettings(guild.id, user.id)[forceKey];
      const next = requested === null ? !current : requested;

      await bot.setMemberSetting(guild.id, user.id, forceKey, next);
      const applied = next ? await bot.enforceMember(guild, user.id) : false;

      await interaction.reply({
        embeds: [
          embed(
            `${kindLabel} for @${user.username}: ${next ? 'LOCKED' : 'released'}`,
            next
              ? `Aegis will keep this member server-${kindLabel.toLowerCase()}ed. If it is removed while they are in voice, it is re-applied immediately. ${
                  applied ? 'Applied now.' : 'They are not in a voice channel right now, so it applies when they join.'
                }`
              : 'Aegis stopped re-applying that state. Any current voice state is left as it is.',
            next ? ON_COLOR : OFF_COLOR,
            `Requested by ${interaction.user.tag}`,
          ),
        ],
        ephemeral: true,
      });
    },
  };
}

/* ------------------------------------------------------------------ roles --- */

function buildRoleCreateCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('rolecreate')
      .setDescription('Create a new role')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) =>
        option.setName('name').setDescription('Role name').setRequired(true).setMaxLength(100),
      )
      .addStringOption((option) =>
        option
          .setName('color')
          .setDescription('Hex colour like #ff6600 (optional)')
          .setRequired(false)
          .setMaxLength(7),
      )
      .addBooleanOption((option) =>
        option.setName('hoist').setDescription('Show members separately in the sidebar').setRequired(false),
      ),

    async execute(interaction, { bot }) {
      const guild = interaction.guild;
      const me = guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({ content: 'Aegis needs the **Manage Roles** permission.', ephemeral: true });
        return;
      }

      const name = interaction.options.getString('name', true).trim();
      const colorInput = interaction.options.getString('color');
      const hoist = interaction.options.getBoolean('hoist') ?? false;

      let color = 0;
      if (colorInput) {
        const match = /^#?([0-9a-f]{6})$/i.exec(colorInput.trim());
        if (!match) {
          await interaction.reply({ content: 'Colour must be hex like `#ff6600`.', ephemeral: true });
          return;
        }
        color = Number.parseInt(match[1], 16);
      }

      const role = await guild.roles.create({ name, color, hoist, reason: `Created by ${interaction.user.tag}` });
      bot.log('info', `[${guild.name}] Created role ${role.name} (${role.id}).`);

      await interaction.reply({
        embeds: [
          embed(
            'Role created',
            `**${role.name}**\nID: \`${role.id}\`\nColour: ${roleColorText(role)}`,
            ON_COLOR,
            `Requested by ${interaction.user.tag}`,
          ),
        ],
        ephemeral: true,
      });
    },
  };
}

function buildRoleListCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('roles')
      .setDescription('List roles in this server')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const guild = interaction.guild;
      const roles = [...guild.roles.cache.values()]
        .filter((role) => role.id !== guild.id)
        .sort((a, b) => b.position - a.position);

      if (roles.length === 0) {
        await interaction.reply({ content: 'This server has no roles besides @everyone.', ephemeral: true });
        return;
      }

      const lines = roles
        .slice(0, 40)
        .map((role) => `**${role.name}** · \`${role.id}\` · ${role.members.size} member(s)`);

      await interaction.reply({
        embeds: [
          embed(
            `Roles (${roles.length})`,
            lines.join('\n') +
              (roles.length > 40 ? `\n…and ${roles.length - 40} more.` : ''),
            INFO_COLOR,
            `Server: ${guild.name}`,
          ),
        ],
        ephemeral: true,
      });
    },
  };
}

function buildRoleMemberCommand({ name, description, add }) {
  return {
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .setContexts(InteractionContextType.Guild)
      .addUserOption((option) =>
        option.setName('user').setDescription('Member to change').setRequired(true),
      )
      .addRoleOption((option) => option.setName('role').setDescription('Role to use').setRequired(true)),

    async execute(interaction, { bot }) {
      const guild = interaction.guild;
      const user = interaction.options.getUser('user', true);
      const role = interaction.options.getRole('role', true);

      const problem = hierarchyProblem(guild, role);
      if (problem) {
        await interaction.reply({ content: problem, ephemeral: true });
        return;
      }

      const member =
        guild.members.cache.get(user.id) ?? (await guild.members.fetch(user.id).catch(() => null));
      if (!member) {
        await interaction.reply({ content: 'That member is not in this server.', ephemeral: true });
        return;
      }

      if (add) await member.roles.add(role, `Added by ${interaction.user.tag}`);
      else await member.roles.remove(role, `Removed by ${interaction.user.tag}`);

      bot.log(
        'info',
        `[${guild.name}] ${add ? 'Added' : 'Removed'} role ${role.name} ${add ? 'to' : 'from'} ${user.tag}.`,
      );

      await interaction.reply({
        embeds: [
          embed(
            add ? 'Role added' : 'Role removed',
            `**${role.name}** ${add ? 'added to' : 'removed from'} @${user.username}.`,
            add ? ON_COLOR : OFF_COLOR,
            `Requested by ${interaction.user.tag}`,
          ),
        ],
        ephemeral: true,
      });
    },
  };
}

function buildRoleDeleteCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('roledelete')
      .setDescription('Delete a role after confirming')
      .setContexts(InteractionContextType.Guild)
      .addRoleOption((option) =>
        option.setName('role').setDescription('Role to delete').setRequired(true),
      ),

    async execute(interaction, { bot }) {
      const guild = interaction.guild;
      const role = interaction.options.getRole('role', true);

      const problem = hierarchyProblem(guild, role);
      if (problem) {
        await interaction.reply({ content: problem, ephemeral: true });
        return;
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('role-delete-confirm')
          .setLabel('Delete role')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('role-delete-cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.reply({
        content: `Delete **${role.name}**? It will be removed from ${role.members.size} member(s) and this cannot be undone.`,
        components: [row],
        ephemeral: true,
      });

      const message = await interaction.fetchReply();
      const confirmation = await message
        .awaitMessageComponent({ componentType: ComponentType.Button, time: 30_000 })
        .catch(() => null);

      if (!confirmation) {
        await interaction.editReply({ content: 'Deletion timed out — nothing was removed.', components: [] });
        return;
      }

      if (confirmation.customId === 'role-delete-cancel') {
        await confirmation.update({ content: 'Cancelled. Nothing was removed.', components: [] });
        return;
      }

      await confirmation.update({ content: 'Deleting…', components: [] });
      await role.delete(`Deleted by ${interaction.user.tag}`);
      bot.log('info', `[${guild.name}] Deleted role ${role.name} (${role.id}).`);
      await confirmation.editReply({ content: `Deleted role **${role.name}**.` });
    },
  };
}

/* -------------------------------------------------------------------- fun --- */

function buildRollCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('roll')
      .setDescription('Roll dice, e.g. 1d20 or 3d6')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) =>
        option.setName('dice').setDescription('Dice notation (default 1d20)').setRequired(false),
      ),

    async execute(interaction) {
      const input = (interaction.options.getString('dice') ?? '1d20').trim().toLowerCase();
      const match = /^(\d{0,2})d(\d{1,4})$/.exec(input.replace(/\s+/g, ''));
      const plain = /^\d{1,4}$/.exec(input);

      let count = 1;
      let sides = 20;
      if (match) {
        count = match[1] ? Number(match[1]) : 1;
        sides = Number(match[2]);
      } else if (plain) {
        sides = Number(plain[0]);
      } else {
        await interaction.reply({ content: 'Use dice notation like `1d20` or a number like `6`.', ephemeral: true });
        return;
      }

      if (count < 1 || count > 20 || sides < 2 || sides > 1000) {
        await interaction.reply({ content: 'Keep it between 1-20 dice with 2-1000 sides.', ephemeral: true });
        return;
      }

      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      const total = rolls.reduce((sum, value) => sum + value, 0);
      await interaction.reply({
        embeds: [
          embed(
            `Rolled ${count}d${sides}`,
            `**${total}**${count > 1 ? `\nDice: ${rolls.join(', ')}` : ''}`,
            INFO_COLOR,
            `Rolled by ${interaction.user.tag}`,
          ),
        ],
      });
    },
  };
}

function buildCoinflipCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('coinflip')
      .setDescription('Flip a coin')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
      await interaction.reply({
        embeds: [embed('Coin flip', `**${result}**`, INFO_COLOR, `Flipped by ${interaction.user.tag}`)],
      });
    },
  };
}

function build8BallCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('8ball')
      .setDescription('Ask the magic 8-ball a question')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) =>
        option.setName('question').setDescription('What do you want to know?').setRequired(true).setMaxLength(300),
      ),

    async execute(interaction) {
      const question = interaction.options.getString('question', true);
      const answer = EIGHT_BALL[Math.floor(Math.random() * EIGHT_BALL.length)];
      await interaction.reply({
        embeds: [embed('🎱 ' + answer, `> ${question}`, INFO_COLOR, `Asked by ${interaction.user.tag}`)],
      });
    },
  };
}

/* ------------------------------------------------------------------- info --- */

function buildPingCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check Aegis latency')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const roundTrip = Date.now() - interaction.createdTimestamp;
      await interaction.reply({
        embeds: [
          embed(
            'Pong',
            `Round trip: **${roundTrip} ms**\nGateway: **${Math.round(interaction.client.ws.ping)} ms**`,
            INFO_COLOR,
          ),
        ],
        ephemeral: true,
      });
    },
  };
}

function buildServerInfoCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('serverinfo')
      .setDescription('Show information about this server')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const guild = interaction.guild;
      await interaction.reply({
        embeds: [
          embed(
            guild.name,
            [
              `**ID:** ${guild.id}`,
              `**Owner:** <@${guild.ownerId}>`,
              `**Members:** ${guild.memberCount}`,
              `**Channels:** ${guild.channels.cache.size}`,
              `**Roles:** ${guild.roles.cache.size}`,
              `**Boosts:** ${guild.premiumSubscriptionCount ?? 0}`,
              `**Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:F>`,
            ].join('\n'),
            INFO_COLOR,
          ),
        ],
        ephemeral: true,
      });
    },
  };
}

function buildUserInfoCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Show info about a member')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((option) =>
        option.setName('user').setDescription('Member to inspect (default: you)').setRequired(false),
      ),

    async execute(interaction) {
      const guild = interaction.guild;
      const user = interaction.options.getUser('user') ?? interaction.user;
      const member =
        guild.members.cache.get(user.id) ?? (await guild.members.fetch(user.id).catch(() => null));

      const voiceBits = [];
      if (member?.voice?.channel) voiceBits.push(`channel: <#${member.voice.channel.id}>`);
      if (member?.voice?.serverMute) voiceBits.push('server muted');
      if (member?.voice?.serverDeaf) voiceBits.push('server deafened');

      await interaction.reply({
        embeds: [
          embed(
            user.username,
            [
              `**Tag:** ${user.tag}`,
              `**ID:** ${user.id}`,
              `**Account created:** <t:${Math.floor(user.createdTimestamp / 1000)}:D>`,
              member ? `**Joined:** <t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : '**Joined:** unknown',
              member ? `**Roles:** ${Math.max(0, member.roles.cache.size - 1)}` : null,
              voiceBits.length ? `**Voice:** ${voiceBits.join(', ')}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            INFO_COLOR,
          ),
        ],
        ephemeral: true,
      });
    },
  };
}

function buildProtectionsCommand() {
  return {
    data: new SlashCommandBuilder()
      .setName('protections')
      .setDescription('Show active protection rules')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((option) =>
        option.setName('user').setDescription('Inspect one member').setRequired(false),
      ),

    async execute(interaction, { bot }) {
      const guildId = interaction.guildId;
      const target = interaction.options.getUser('user');

      if (target) {
        const rules = bot.getEffectiveRules(guildId, target.id);
        await interaction.reply({
          embeds: [
            embed(
              `Rules for @${target.username}`,
              [
                `**Anti server mute:** ${rules.effectiveAntiServerMute ? 'on' : 'off'} ${
                  rules.antiServerMute === null ? '(server default)' : '(personal)'
                }`,
                `**Anti server deafen:** ${rules.effectiveAntiServerDeafen ? 'on' : 'off'} ${
                  rules.antiServerDeafen === null ? '(server default)' : '(personal)'
                }`,
                `**Forced server mute:** ${rules.forceServerMute ? 'on' : 'off'}`,
                `**Forced server deafen:** ${rules.forceServerDeafen ? 'on' : 'off'}`,
              ].join('\n'),
              INFO_COLOR,
            ),
          ],
          ephemeral: true,
        });
        return;
      }

      const settings = bot.getGuildSettings(guildId);
      const memberEntries = Object.entries(settings.members)
        .slice(0, 15)
        .map(([id, member]) => {
          const rules = bot.getEffectiveRules(guildId, id);
          const flags = [
            rules.effectiveAntiServerMute ? 'anti-mute' : null,
            rules.effectiveAntiServerDeafen ? 'anti-deafen' : null,
            member.forceServerMute ? 'force-mute' : null,
            member.forceServerDeafen ? 'force-deafen' : null,
          ].filter(Boolean);
          return `<@${id}> — ${flags.length ? flags.join(', ') : 'no active rules'}`;
        });

      await interaction.reply({
        embeds: [
          embed(
            'Protection rules',
            [
              `**Server anti-mute:** ${settings.antiServerMute ? 'on' : 'off'}`,
              `**Server anti-deafen:** ${settings.antiServerDeafen ? 'on' : 'off'}`,
              `**Managed members:** ${Object.keys(settings.members).length}`,
              memberEntries.length ? `\n${memberEntries.join('\n')}` : '',
              Object.keys(settings.members).length > 15 ? '…' : '',
            ]
              .filter(Boolean)
              .join('\n'),
            INFO_COLOR,
          ),
        ],
        ephemeral: true,
      });
    },
  };
}

export const commands = [
  buildProtectionCommand({
    name: 'antiservermute',
    description: 'Remove server mutes, server-wide or for one member',
    key: 'antiServerMute',
    label: 'Anti server mute',
  }),
  buildProtectionCommand({
    name: 'antiserverdefen',
    description: 'Remove server deafens, server-wide or for one member',
    key: 'antiServerDeafen',
    label: 'Anti server deafen',
  }),
  buildForceCommand({
    name: 'forceservermute',
    description: 'Keep a member server-muted, re-applying it if removed',
    forceKey: 'forceServerMute',
    kindLabel: 'Force server mute',
  }),
  buildForceCommand({
    name: 'forceserverdefen',
    description: 'Keep a member server-deafened, re-applying it if removed',
    forceKey: 'forceServerDeafen',
    kindLabel: 'Force server deafen',
  }),
  buildProtectionsCommand(),
  buildRoleCreateCommand(),
  buildRoleListCommand(),
  buildRoleMemberCommand({
    name: 'roleadd',
    description: 'Give a role to a member',
    add: true,
  }),
  buildRoleMemberCommand({
    name: 'roleremove',
    description: 'Take a role away from a member',
    add: false,
  }),
  buildRoleDeleteCommand(),
  buildRollCommand(),
  buildCoinflipCommand(),
  build8BallCommand(),
  buildPingCommand(),
  buildServerInfoCommand(),
  buildUserInfoCommand(),
  ...featureCommands,
];

export const commandsByName = new Map(commands.map((command) => [command.data.name, command]));
