import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { COLORS, canManageGuild, embed, randomId, truncate } from './util.js';

const MAX_BACKUPS = 15;
const RESTORABLE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildStageVoice,
]);

function backupDir(features, guildId) {
  return path.join(features.dataDir, 'backups', guildId);
}

function backupPath(features, guildId, id) {
  return path.join(backupDir(features, guildId), `${id}.json`);
}

function summarizeBackup(data) {
  return {
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    roles: data.roles.length,
    channels: data.channels.length,
    categories: data.categories.length,
  };
}

export async function createBackup(features, guild, name) {
  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id && !role.managed)
    .sort((a, b) => a.position - b.position)
    .map((role) => ({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      position: role.position,
      permissions: role.permissions.bitfield.toString(),
    }));

  const categories = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position)
    .map((channel) => ({ name: channel.name, position: channel.position }));

  const channels = [...guild.channels.cache.values()]
    .filter((channel) => channel.type !== ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position)
    .map((channel) => ({
      name: channel.name,
      type: channel.type,
      parentName: channel.parent?.name ?? null,
      topic: channel.topic ?? null,
      nsfw: channel.nsfw ?? false,
      slowmode: channel.rateLimitPerUser ?? 0,
      bitrate: channel.bitrate ?? null,
      userLimit: channel.userLimit ?? null,
      position: channel.position,
    }));

  const data = {
    id: randomId(8),
    version: 1,
    name: (name || `Backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`).slice(0, 80),
    createdAt: Date.now(),
    guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }) },
    roles,
    categories,
    channels,
  };

  await mkdir(backupDir(features, guild.id), { recursive: true });
  await writeFile(backupPath(features, guild.id, data.id), JSON.stringify(data, null, 2), 'utf8');

  const config = features.store.guild(guild.id);
  config.backups ??= [];
  config.backups.unshift(summarizeBackup(data));
  while (config.backups.length > MAX_BACKUPS) {
    const removed = config.backups.pop();
    await unlink(backupPath(features, guild.id, removed.id)).catch(() => {});
  }
  features.store.save();
  return data;
}

export async function loadBackup(features, guildId, id) {
  const raw = await readFile(backupPath(features, guildId, id), 'utf8');
  return JSON.parse(raw);
}

export async function restoreBackup(features, guild, data) {
  const result = {
    rolesCreated: 0,
    rolesSkipped: 0,
    categoriesCreated: 0,
    channelsCreated: 0,
    channelsSkipped: 0,
    errors: [],
  };

  const rolesByName = new Map(
    [...guild.roles.cache.values()].map((role) => [role.name.toLowerCase(), role]),
  );

  for (const entry of [...(data.roles ?? [])].sort((a, b) => a.position - b.position)) {
    if (rolesByName.has(entry.name.toLowerCase())) {
      result.rolesSkipped += 1;
      continue;
    }
    try {
      const role = await guild.roles.create({
        name: entry.name,
        color: entry.color,
        hoist: Boolean(entry.hoist),
        mentionable: Boolean(entry.mentionable),
        permissions: BigInt(entry.permissions ?? '0'),
        reason: `Aegis backup restore (${data.name})`,
      });
      rolesByName.set(role.name.toLowerCase(), role);
      result.rolesCreated += 1;
    } catch (error) {
      result.errors.push(`Role ${entry.name}: ${error.message}`);
    }
  }

  const categoriesByName = new Map(
    [...guild.channels.cache.values()]
      .filter((channel) => channel.type === ChannelType.GuildCategory)
      .map((channel) => [channel.name.toLowerCase(), channel]),
  );

  for (const entry of [...(data.categories ?? [])].sort((a, b) => a.position - b.position)) {
    if (categoriesByName.has(entry.name.toLowerCase())) continue;
    try {
      const category = await guild.channels.create({
        name: entry.name,
        type: ChannelType.GuildCategory,
        reason: `Aegis backup restore (${data.name})`,
      });
      categoriesByName.set(category.name.toLowerCase(), category);
      result.categoriesCreated += 1;
    } catch (error) {
      result.errors.push(`Category ${entry.name}: ${error.message}`);
    }
  }

  const existing = new Set(
    [...guild.channels.cache.values()].map((channel) => `${channel.type}:${channel.name.toLowerCase()}`),
  );

  for (const entry of [...(data.channels ?? [])].sort((a, b) => a.position - b.position)) {
    const key = `${entry.type}:${entry.name.toLowerCase()}`;
    if (existing.has(key)) {
      result.channelsSkipped += 1;
      continue;
    }
    if (!RESTORABLE_TYPES.has(entry.type) || entry.type === ChannelType.GuildCategory) {
      result.channelsSkipped += 1;
      continue;
    }
    const parent = entry.parentName
      ? categoriesByName.get(String(entry.parentName).toLowerCase())
      : null;
    try {
      await guild.channels.create({
        name: entry.name,
        type: entry.type,
        parent: parent?.id,
        topic: entry.topic ? truncate(entry.topic, 1000) : undefined,
        nsfw: entry.nsfw || undefined,
        rateLimitPerUser: entry.slowmode || undefined,
        bitrate: entry.bitrate || undefined,
        userLimit: entry.userLimit || undefined,
        reason: `Aegis backup restore (${data.name})`,
      });
      existing.add(key);
      result.channelsCreated += 1;
    } catch (error) {
      result.errors.push(`Channel ${entry.name}: ${error.message}`);
    }
  }

  return result;
}

export async function deleteBackup(features, guildId, id) {
  const config = features.store.guild(guildId);
  config.backups = (config.backups ?? []).filter((entry) => entry.id !== id);
  features.store.save();
  await unlink(backupPath(features, guildId, id)).catch(() => {});
}

export async function handleBackupComponent(features, interaction) {
  if (!interaction.guildId) return false;
  const [prefix, action, id] = interaction.customId.split(':');
  if (prefix !== 'bk') return false;

  const config = features.store.guild(interaction.guildId);
  const meta = (config.backups ?? []).find((entry) => entry.id === id);
  if (!meta) {
    await interaction.reply({ embeds: [embed('Backup not found', 'That backup was deleted.', COLORS.off)], flags: 64 });
    return true;
  }

  if (action === 'cancel') {
    await interaction.update({ embeds: [embed('Restore cancelled', 'Nothing was changed.', COLORS.muted)], components: [] });
    return true;
  }

  if (!canManageGuild(interaction.member)) {
    await interaction.reply({ embeds: [embed('Not allowed', 'Only **Manage Server** can restore a backup.', COLORS.off)], flags: 64 });
    return true;
  }

  await interaction.update({
    embeds: [embed('Restoring backup…', `Applying **${meta.name}**. This can take a moment.`, COLORS.warn)],
    components: [],
  });

  try {
    const data = await loadBackup(features, interaction.guildId, id);
    const result = await restoreBackup(features, interaction.guild, data);
    await interaction.followup({
      embeds: [
        embed(
          'Backup restored',
          [
            `Roles created: **${result.rolesCreated}** (${result.rolesSkipped} already existed)`,
            `Categories created: **${result.categoriesCreated}**`,
            `Channels created: **${result.channelsCreated}** (${result.channelsSkipped} skipped)`,
            '',
            'Nothing was deleted. Existing roles and channels were left exactly as they were.',
            result.errors.length ? `\n**Warnings**\n${result.errors.slice(0, 8).map((line) => `• ${line}`).join('\n')}` : '',
          ].join('\n'),
          result.errors.length ? COLORS.warn : COLORS.on,
        ),
      ],
      flags: 64,
    });
  } catch (error) {
    await interaction.followup({
      embeds: [embed('Restore failed', error.message, COLORS.off)],
      flags: 64,
    });
  }
  return true;
}

/* ----------------------------------------------------------------- command --- */

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('backup')
      .setDescription('Save and restore your server configuration')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Save roles and channels to a snapshot')
          .addStringOption((option) => option.setName('name').setDescription('Snapshot name').setRequired(false).setMaxLength(80)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List saved backups'))
      .addSubcommand((sub) =>
        sub
          .setName('restore')
          .setDescription('Recreate roles and channels from a backup')
          .addStringOption((option) => option.setName('id').setDescription('Backup ID').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a saved backup')
          .addStringOption((option) => option.setName('id').setDescription('Backup ID').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('export')
          .setDescription('Download a backup as a JSON file')
          .addStringOption((option) => option.setName('id').setDescription('Backup ID').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('import')
          .setDescription('Import a backup JSON file')
          .addAttachmentOption((option) => option.setName('file').setDescription('Backup .json file').setRequired(true)),
      ),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      const guild = interaction.guild;
      const config = features.store.guild(guild.id);
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'create') {
        await interaction.deferReply({ flags: 64 });
        try {
          const data = await createBackup(features, guild, interaction.options.getString('name'));
          await interaction.editReply({
            embeds: [
              embed(
                'Backup saved',
                [
                  `**${data.name}** · ID \`${data.id}\``,
                  `${data.roles.length} roles · ${data.categories.length} categories · ${data.channels.length} channels`,
                  '',
                  'Restore it with `/backup restore`. Restoring only adds what is missing and never deletes anything.',
                ].join('\n'),
                COLORS.on,
              ),
            ],
          });
        } catch (error) {
          await interaction.editReply({ embeds: [embed('Backup failed', error.message, COLORS.off)] });
        }
        return;
      }

      if (subcommand === 'list') {
        const backups = config.backups ?? [];
        await interaction.reply({
          embeds: [
            embed(
              'Server backups',
              backups.length
                ? backups
                    .map(
                      (entry) =>
                        `\`${entry.id}\` · **${entry.name}** · ${entry.roles} roles / ${entry.channels} channels · <t:${Math.floor(
                          entry.createdAt / 1000,
                        )}:R>`,
                    )
                    .join('\n')
                : 'No backups yet. Create one with `/backup create`.',
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'import') {
        const attachment = interaction.options.getAttachment('file', true);
        if (attachment.size > 2 * 1024 * 1024) {
          await interaction.reply({ embeds: [embed('File too large', 'Backups must be under 2 MB.', COLORS.off)], flags: 64 });
          return;
        }
        await interaction.deferReply({ flags: 64 });
        try {
          const response = await fetch(attachment.url);
          const text = await response.text();
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed.roles) || !Array.isArray(parsed.channels)) {
            throw new Error('That file is not an Aegis backup.');
          }
          const data = {
            ...parsed,
            id: randomId(8),
            createdAt: Date.now(),
            name: String(parsed.name ?? 'Imported backup').slice(0, 80),
          };
          await mkdir(backupDir(features, guild.id), { recursive: true });
          await writeFile(backupPath(features, guild.id, data.id), JSON.stringify(data, null, 2), 'utf8');
          config.backups ??= [];
          config.backups.unshift(summarizeBackup(data));
          features.store.save();
          await interaction.editReply({
            embeds: [embed('Backup imported', `Saved as \`${data.id}\`. Restore it with \`/backup restore id:${data.id}\`.`, COLORS.on)],
          });
        } catch (error) {
          await interaction.editReply({ embeds: [embed('Import failed', error.message, COLORS.off)] });
        }
        return;
      }

      const id = interaction.options.getString('id', true).trim();
      const meta = (config.backups ?? []).find((entry) => entry.id === id);
      if (!meta) {
        await interaction.reply({ embeds: [embed('Backup not found', `No backup with ID \`${id}\`.`, COLORS.off)], flags: 64 });
        return;
      }

      if (subcommand === 'export') {
        try {
          const data = await loadBackup(features, guild.id, id);
          const file = new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2)), {
            name: `aegis-backup-${id}.json`,
          });
          await interaction.reply({
            embeds: [embed('Backup export', `**${meta.name}** is attached.`, COLORS.on)],
            files: [file],
            flags: 64,
          });
        } catch (error) {
          await interaction.reply({ embeds: [embed('Export failed', error.message, COLORS.off)], flags: 64 });
        }
        return;
      }

      if (subcommand === 'delete') {
        await deleteBackup(features, guild.id, id);
        await interaction.reply({ embeds: [embed('Backup deleted', `Removed **${meta.name}**.`, COLORS.on)], flags: 64 });
        return;
      }

      if (subcommand === 'restore') {
        await interaction.reply({
          embeds: [
            embed(
              'Restore this backup?',
              [
                `**${meta.name}** · ${meta.roles} roles / ${meta.categories} categories / ${meta.channels} channels`,
                '',
                'Aegis will recreate missing roles and channels. Nothing existing is deleted or overwritten.',
              ].join('\n'),
              COLORS.warn,
            ),
          ],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`bk:restore:${id}`)
                .setLabel('Restore backup')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`bk:cancel:${id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
          flags: 64,
        });
      }
    },
  },
];
