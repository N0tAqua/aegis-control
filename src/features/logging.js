import {
  AuditLogEvent,
  ButtonStyle,
  EmbedBuilder,
  Events,
  SlashCommandBuilder,
  InteractionContextType,
  PermissionFlagsBits,
} from 'discord.js';
import { COLORS, canManageGuild, embed, truncate } from './util.js';

export const LOG_TYPES = [
  { name: 'messages', label: 'Messages (edits and deletes)' },
  { name: 'members', label: 'Members (joins, leaves, roles)' },
  { name: 'roles', label: 'Roles (created, edited, deleted)' },
  { name: 'channels', label: 'Channels (created, edited, deleted)' },
  { name: 'moderation', label: 'Moderation (bans, kicks, timeouts)' },
  { name: 'voice', label: 'Voice (joins, leaves, moves)' },
];

const TYPE_SET = new Set(LOG_TYPES.map((type) => type.name));

function authorLine(author) {
  if (!author) return 'Unknown user';
  return `<@${author.id}> · ${author.tag ?? author.username ?? author.id}${
    author.bot ? ' `BOT`' : ''
  }`;
}

async function executorFromAudit(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 8 });
    const now = Date.now();
    const entry = logs.entries.find(
      (item) =>
        item.targetId === targetId && now - Number(item.createdTimestamp) < 20_000,
    );
    return entry?.executor ?? null;
  } catch {
    return null;
  }
}

/** Send one log line if that log type has a channel and is enabled. */
export async function sendLog(features, guild, type, payload) {
  if (!guild || !TYPE_SET.has(type)) return null;
  const config = features.store.guild(guild.id).logging;
  if (config.enabled?.[type] === false) return null;
  const channelId = config.channels?.[type];
  if (!channelId) return null;
  const channel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased?.()) return null;
  try {
    return await channel.send(payload);
  } catch {
    return null;
  }
}

function logEmbed(title, color, fields) {
  const built = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp();
  for (const field of fields.filter(Boolean)) {
    built.addFields({ name: field.name, value: truncate(field.value, 1020), inline: field.inline ?? false });
  }
  return built;
}

export function registerLogging(features, client) {
  const log = (guild, type, payload) => sendLog(features, guild, type, payload);

  client.on(Events.MessageDelete, async (message) => {
    if (!message.guild || message.author?.bot) return;
    const partial = message.partial;
    await log(message.guild, 'messages', {
      embeds: [
        logEmbed('Message deleted', COLORS.off, [
          { name: 'Author', value: authorLine(message.author) },
          { name: 'Channel', value: `<#${message.channelId}>` },
          {
            name: 'Content',
            value: partial ? '_Message was not cached, so its text is unavailable._' : truncate(message.content || '_No text (embed or attachment only)_'),
          },
        ]),
      ],
    });
  });

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (!newMessage.guild || newMessage.author?.bot) return;
    const before = oldMessage?.content ?? '';
    const after = newMessage.content ?? '';
    if (before === after) return;
    await log(newMessage.guild, 'messages', {
      embeds: [
        logEmbed('Message edited', COLORS.warn, [
          { name: 'Author', value: authorLine(newMessage.author) },
          { name: 'Channel', value: `<#${newMessage.channelId}>` },
          { name: 'Before', value: truncate(before || '_empty_') },
          { name: 'After', value: truncate(after || '_empty_') },
          { name: 'Jump', value: `[Open message](${newMessage.url})` },
        ]),
      ],
    });
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.user?.bot) return;
    const ageDays = Math.max(0, (Date.now() - member.user.createdTimestamp) / 86_400_000);
    await log(member.guild, 'members', {
      embeds: [
        logEmbed('Member joined', COLORS.on, [
          { name: 'Member', value: authorLine(member.user) },
          { name: 'Account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F> (${ageDays.toFixed(1)} days ago)` },
          { name: 'Member count', value: String(member.guild.memberCount) },
          { name: 'Risk note', value: ageDays < 7 ? '⚠️ New account (under 7 days old).' : 'Account is older than 7 days.' },
        ]),
      ],
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (member.user?.bot) return;
    const kick = await executorFromAudit(member.guild, AuditLogEvent.MemberKick, member.id);
    await log(member.guild, 'members', {
      embeds: [
        logEmbed(kick ? 'Member kicked' : 'Member left', kick ? COLORS.warn : COLORS.muted, [
          { name: 'Member', value: authorLine(member.user) },
          ...(kick ? [{ name: 'Kicked by', value: authorLine(kick) }] : []),
          {
            name: 'Joined',
            value: member.joinedTimestamp
              ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`
              : 'Unknown',
          },
          { name: 'Roles', value: String(Math.max(0, (member.roles?.cache?.size ?? 1) - 1)) },
        ]),
      ],
    });
    if (kick) {
      await log(member.guild, 'moderation', {
        embeds: [
          logEmbed('Kick', COLORS.warn, [
            { name: 'Member', value: authorLine(member.user) },
            { name: 'Moderator', value: authorLine(kick) },
          ]),
        ],
      });
    }
  });

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    const guild = newMember.guild;
    const added = [...newMember.roles.cache.keys()].filter((id) => !oldMember.roles.cache.has(id));
    const removed = [...oldMember.roles.cache.keys()].filter((id) => !newMember.roles.cache.has(id));
    if (added.length || removed.length) {
      await log(guild, 'members', {
        embeds: [
          logEmbed('Member roles updated', COLORS.brand, [
            { name: 'Member', value: authorLine(newMember.user) },
            ...(added.length ? [{ name: 'Added', value: added.map((id) => `<@&${id}>`).join(', ') }] : []),
            ...(removed.length ? [{ name: 'Removed', value: removed.map((id) => `<@&${id}>`).join(', ') }] : []),
          ]),
        ],
      });
    }
    if (oldMember.nickname !== newMember.nickname) {
      await log(guild, 'members', {
        embeds: [
          logEmbed('Nickname changed', COLORS.brand, [
            { name: 'Member', value: authorLine(newMember.user) },
            { name: 'Before', value: oldMember.nickname ?? oldMember.user.username },
            { name: 'After', value: newMember.nickname ?? newMember.user.username },
          ]),
        ],
      });
    }
    if (Boolean(oldMember.communicationDisabledUntilTimestamp) !== Boolean(newMember.communicationDisabledUntilTimestamp)) {
      const until = newMember.communicationDisabledUntilTimestamp;
      await log(guild, 'moderation', {
        embeds: [
          logEmbed(until ? 'Member timed out' : 'Timeout removed', until ? COLORS.warn : COLORS.on, [
            { name: 'Member', value: authorLine(newMember.user) },
            ...(until ? [{ name: 'Until', value: `<t:${Math.floor(until / 1000)}:F>` }] : []),
          ]),
        ],
      });
    }
  });

  client.on(Events.GuildBanAdd, async (ban) => {
    const executor = await executorFromAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    await log(ban.guild, 'moderation', {
      embeds: [
        logEmbed('Member banned', COLORS.off, [
          { name: 'User', value: authorLine(ban.user) },
          { name: 'Moderator', value: executor ? authorLine(executor) : 'Unknown' },
          { name: 'Reason', value: ban.reason || '_No reason provided_' },
        ]),
      ],
    });
  });

  client.on(Events.GuildBanRemove, async (ban) => {
    const executor = await executorFromAudit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    await log(ban.guild, 'moderation', {
      embeds: [
        logEmbed('Ban removed', COLORS.on, [
          { name: 'User', value: authorLine(ban.user) },
          { name: 'Moderator', value: executor ? authorLine(executor) : 'Unknown' },
        ]),
      ],
    });
  });

  client.on(Events.RoleCreate, async (role) => {
    await log(role.guild, 'roles', {
      embeds: [
        logEmbed('Role created', COLORS.on, [
          { name: 'Role', value: `<@&${role.id}> (${role.name})` },
          { name: 'Colour', value: `#${role.color.toString(16).padStart(6, '0')}` },
          { name: 'Hoisted', value: role.hoist ? 'Yes' : 'No', inline: true },
        ]),
      ],
    });
  });

  client.on(Events.RoleDelete, async (role) => {
    await log(role.guild, 'roles', {
      embeds: [
        logEmbed('Role deleted', COLORS.off, [
          { name: 'Role', value: `${role.name} (\`${role.id}\`)` },
          { name: 'Members had it', value: String(role.members?.size ?? 0) },
        ]),
      ],
    });
  });

  client.on(Events.RoleUpdate, async (oldRole, newRole) => {
    const changes = [];
    if (oldRole.name !== newRole.name) changes.push(`Name: **${oldRole.name}** → **${newRole.name}**`);
    if (oldRole.color !== newRole.color) {
      changes.push(
        `Colour: \`#${oldRole.color.toString(16).padStart(6, '0')}\` → \`#${newRole.color
          .toString(16)
          .padStart(6, '0')}\``,
      );
    }
    if (oldRole.hoist !== newRole.hoist) changes.push(`Hoisted: ${oldRole.hoist} → ${newRole.hoist}`);
    if (oldRole.mentionable !== newRole.mentionable) {
      changes.push(`Mentionable: ${oldRole.mentionable} → ${newRole.mentionable}`);
    }
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
      changes.push('Permissions changed');
    }
    if (changes.length === 0) return;
    await log(newRole.guild, 'roles', {
      embeds: [
        logEmbed('Role updated', COLORS.brand, [
          { name: 'Role', value: `<@&${newRole.id}> (${newRole.name})` },
          { name: 'Changes', value: changes.join('\n') },
        ]),
      ],
    });
  });

  client.on(Events.ChannelCreate, async (channel) => {
    if (!channel.guild) return;
    await log(channel.guild, 'channels', {
      embeds: [
        logEmbed('Channel created', COLORS.on, [
          { name: 'Channel', value: `<#${channel.id}> (${channel.name ?? 'unnamed'})` },
          { name: 'Type', value: String(channel.type) },
        ]),
      ],
    });
  });

  client.on(Events.ChannelDelete, async (channel) => {
    if (!channel.guild) return;
    await log(channel.guild, 'channels', {
      embeds: [
        logEmbed('Channel deleted', COLORS.off, [
          { name: 'Channel', value: `#${channel.name ?? 'unnamed'} (\`${channel.id}\`)` },
          { name: 'Type', value: String(channel.type) },
        ]),
      ],
    });
  });

  client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    if (!newChannel.guild) return;
    const changes = [];
    if (oldChannel.name !== newChannel.name) changes.push(`Name: **${oldChannel.name}** → **${newChannel.name}**`);
    if (oldChannel.parentId !== newChannel.parentId) changes.push('Moved to a different category');
    if ('topic' in oldChannel && oldChannel.topic !== newChannel.topic) changes.push('Topic changed');
    if (changes.length === 0) return;
    await log(newChannel.guild, 'channels', {
      embeds: [
        logEmbed('Channel updated', COLORS.brand, [
          { name: 'Channel', value: `<#${newChannel.id}>` },
          { name: 'Changes', value: changes.join('\n') },
        ]),
      ],
    });
  });

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const guild = newState.guild ?? oldState.guild;
    if (!guild || newState.member?.user?.bot) return;
    if (oldState.channelId === newState.channelId) return;
    const config = features.store.guild(guild.id).logging;
    if (config.enabled?.voice === false || !config.channels?.voice) return;
    let detail;
    if (!oldState.channelId && newState.channelId) detail = `Joined <#${newState.channelId}>`;
    else if (oldState.channelId && !newState.channelId) detail = `Left <#${oldState.channelId}>`;
    else detail = `Moved <#${oldState.channelId}> → <#${newState.channelId}>`;
    await log(guild, 'voice', {
      embeds: [
        logEmbed('Voice update', COLORS.muted, [
          { name: 'Member', value: authorLine(newState.member?.user) },
          { name: 'Change', value: detail },
        ]),
      ],
    });
  });
}

/* ----------------------------------------------------------------- command --- */

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('logs')
      .setDescription('Configure detailed server logging')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Send every log type to one channel')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel that receives the logs')
              .setRequired(true)
              .addChannelTypes(0),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Route one log type to its own channel')
          .addStringOption((option) =>
            option
              .setName('type')
              .setDescription('Log type')
              .setRequired(true)
              .addChoices(...LOG_TYPES.map((type) => ({ name: type.label, value: type.name }))),
          )
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Where to send it').setRequired(true).addChannelTypes(0),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('Turn one log type on or off')
          .addStringOption((option) =>
            option
              .setName('type')
              .setDescription('Log type')
              .setRequired(true)
              .addChoices(...LOG_TYPES.map((type) => ({ name: type.label, value: type.name }))),
          )
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('On or off').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the current logging setup')),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({
          embeds: [embed('Missing permission', 'You need **Manage Server** to configure logging.', COLORS.off)],
          flags: 64,
        });
        return;
      }
      const config = features.store.guild(interaction.guildId).logging;
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'setup') {
        const channel = interaction.options.getChannel('channel', true);
        for (const type of LOG_TYPES) config.channels[type.name] = channel.id;
        for (const type of LOG_TYPES) config.enabled[type.name] = true;
        features.store.save();
        await interaction.reply({
          embeds: [
            embed(
              'Logging enabled',
              `All log types now go to <#${channel.id}>. Use \`/logs channel\` to split them up, or \`/logs toggle\` to mute a type.`,
              COLORS.on,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'channel') {
        const type = interaction.options.getString('type', true);
        const channel = interaction.options.getChannel('channel', true);
        config.channels[type] = channel.id;
        features.store.save();
        await interaction.reply({
          embeds: [embed('Log channel updated', `**${type}** logs now go to <#${channel.id}>.`, COLORS.on)],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'toggle') {
        const type = interaction.options.getString('type', true);
        const enabled = interaction.options.getBoolean('enabled', true);
        config.enabled[type] = enabled;
        features.store.save();
        await interaction.reply({
          embeds: [
            embed(
              `Logging ${enabled ? 'enabled' : 'disabled'}`,
              `**${type}** logging is now **${enabled ? 'on' : 'off'}**.`,
              enabled ? COLORS.on : COLORS.off,
            ),
          ],
          flags: 64,
        });
        return;
      }

      const lines = LOG_TYPES.map((type) => {
        const channelId = config.channels[type.name];
        const state = config.enabled[type.name] === false ? 'off' : 'on';
        return `${state === 'on' ? '🟢' : '⚪'} **${type.name}** → ${
          channelId ? `<#${channelId}>` : '_not set_'
        }`;
      });
      await interaction.reply({
        embeds: [embed('Logging status', lines.join('\n'), COLORS.brand, )],
        flags: 64,
      });
    },
  },
];
