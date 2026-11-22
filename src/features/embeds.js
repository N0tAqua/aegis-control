import {
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, canManageGuild, embed, hexToInt, truncate } from './util.js';

function describeOptions(interaction) {
  return {
    title: interaction.options.getString('title'),
    description: interaction.options.getString('description'),
    color: interaction.options.getString('color'),
    footer: interaction.options.getString('footer'),
    image: interaction.options.getString('image'),
    thumbnail: interaction.options.getString('thumbnail'),
    author: interaction.options.getString('author'),
    url: interaction.options.getString('url'),
  };
}

function buildEmbed(options, base) {
  const built = base ? EmbedBuilder.from(base) : new EmbedBuilder();
  if (options.color !== null && options.color !== undefined) {
    if (options.color.toLowerCase() === 'clear' || options.color === '-') built.setColor(COLORS.brand);
    else {
      const color = hexToInt(options.color);
      if (color === null) throw new Error('Colour must be hex like `#6f9bff`.');
      built.setColor(color);
    }
  } else if (!base) {
    built.setColor(COLORS.brand);
  }
  if (options.title !== null && options.title !== undefined) {
    if (options.title === '-') built.setTitle(null);
    else built.setTitle(truncate(options.title, 256));
  }
  if (options.description !== null && options.description !== undefined) {
    if (options.description === '-') built.setDescription(null);
    else built.setDescription(options.description.slice(0, 4000));
  }
  if (options.footer !== null && options.footer !== undefined) {
    if (options.footer === '-') built.setFooter(null);
    else built.setFooter({ text: truncate(options.footer, 2048) });
  }
  if (options.image !== null && options.image !== undefined) {
    if (options.image === '-') built.setImage(null);
    else if (!/^https?:\/\//i.test(options.image)) throw new Error('Image must be an https URL.');
    else built.setImage(options.image);
  }
  if (options.thumbnail !== null && options.thumbnail !== undefined) {
    if (options.thumbnail === '-') built.setThumbnail(null);
    else if (!/^https?:\/\//i.test(options.thumbnail)) throw new Error('Thumbnail must be an https URL.');
    else built.setThumbnail(options.thumbnail);
  }
  if (options.author !== null && options.author !== undefined) {
    if (options.author === '-') built.setAuthor(null);
    else built.setAuthor({ name: truncate(options.author, 256) });
  }
  if (options.url !== null && options.url !== undefined) {
    if (options.url === '-') built.setURL(null);
    else if (!/^https?:\/\//i.test(options.url)) throw new Error('Link must be an https URL.');
    else built.setURL(options.url);
  }
  if (!built.data.title && !built.data.description && !built.data.image && !built.data.fields?.length) {
    throw new Error('Add at least a title or a description.');
  }
  return built;
}

function addFields(builder) {
  return builder
    .addStringOption((option) => option.setName('title').setDescription('Embed title (use - to clear)').setRequired(false).setMaxLength(256))
    .addStringOption((option) =>
      option.setName('description').setDescription('Embed body, markdown works (use - to clear)').setRequired(false).setMaxLength(4000),
    )
    .addStringOption((option) => option.setName('color').setDescription('Hex colour like #6f9bff').setRequired(false).setMaxLength(7))
    .addStringOption((option) => option.setName('footer').setDescription('Footer text (use - to clear)').setRequired(false).setMaxLength(200))
    .addStringOption((option) => option.setName('image').setDescription('Large image URL').setRequired(false).setMaxLength(500))
    .addStringOption((option) => option.setName('thumbnail').setDescription('Thumbnail URL').setRequired(false).setMaxLength(500))
    .addStringOption((option) => option.setName('author').setDescription('Author line').setRequired(false).setMaxLength(200))
    .addStringOption((option) => option.setName('url').setDescription('Title link URL').setRequired(false).setMaxLength(500));
}

function checkPermission(interaction) {
  return (
    canManageGuild(interaction.member) ||
    interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)
  );
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('embed')
      .setDescription('Create and edit rich embeds directly in Discord')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) => {
        addFields(
          sub
            .setName('send')
            .setDescription('Send a new embed')
            .addChannelOption((option) =>
              option.setName('channel').setDescription('Where to send it').setRequired(true).addChannelTypes(0),
            ),
        );
        return sub;
      })
      .addSubcommand((sub) => {
        addFields(
          sub
            .setName('edit')
            .setDescription('Edit an embed Aegis sent')
            .addChannelOption((option) =>
              option.setName('channel').setDescription('Channel holding the message').setRequired(true).addChannelTypes(0),
            )
            .addStringOption((option) =>
              option.setName('message').setDescription('Message ID or message link').setRequired(true),
            ),
        );
        return sub;
      })
      .addSubcommand((sub) => {
        addFields(sub.setName('preview').setDescription('Preview an embed only you can see'));
        return sub;
      })
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete an embed Aegis sent')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Channel holding the message').setRequired(true).addChannelTypes(0),
          )
          .addStringOption((option) => option.setName('message').setDescription('Message ID or link').setRequired(true)),
      ),

    async execute(interaction) {
      if (!checkPermission(interaction)) {
        await interaction.reply({
          embeds: [embed('Missing permission', 'You need **Manage Messages** to use embeds.', COLORS.off)],
          flags: 64,
        });
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      const options = describeOptions(interaction);

      try {
        if (subcommand === 'preview') {
          const built = buildEmbed(options, null);
          await interaction.reply({
            embeds: [built],
            content: 'Preview only — nobody else can see this.',
            flags: 64,
          });
          return;
        }

        const channel = interaction.options.getChannel('channel', true);
        const target = await interaction.guild.channels.fetch(channel.id).catch(() => null);
        if (!target?.isTextBased?.()) throw new Error('That channel cannot hold messages.');

        const raw = interaction.options.getString('message');
        const messageId = raw ? (/(\d{17,20})/.exec(raw)?.[1] ?? raw.trim()) : null;

        if (subcommand === 'delete') {
          if (!messageId) throw new Error('Give a message ID or link.');
          const message = await target.messages.fetch(messageId).catch(() => null);
          if (!message) throw new Error('Message not found in that channel.');
          if (message.author?.id !== interaction.client.user.id) {
            throw new Error('Aegis can only delete its own messages.');
          }
          await message.delete();
          await interaction.reply({ embeds: [embed('Embed deleted', 'The message was removed.', COLORS.on)], flags: 64 });
          return;
        }

        if (subcommand === 'send') {
          const built = buildEmbed(options, null);
          const message = await target.send({ embeds: [built] });
          await interaction.reply({
            embeds: [embed('Embed sent', `Posted in <#${target.id}>: ${message.url}`, COLORS.on)],
            flags: 64,
          });
          return;
        }

        if (!messageId) throw new Error('Give a message ID or link.');
        const message = await target.messages.fetch(messageId).catch(() => null);
        if (!message) throw new Error('Message not found in that channel.');
        if (message.author?.id !== interaction.client.user.id) {
          throw new Error('Aegis can only edit its own messages.');
        }
        if (!message.embeds.length) throw new Error('That message has no embed to edit.');
        const base = message.embeds[0];
        const built = buildEmbed({ ...options }, base);
        await message.edit({ embeds: [built] });
        await interaction.reply({
          embeds: [embed('Embed updated', `Edited ${message.url}`, COLORS.on)],
          flags: 64,
        });
      } catch (error) {
        await interaction.reply({ embeds: [embed('Embed error', error.message, COLORS.off)], flags: 64 });
      }
    },
  },
];
