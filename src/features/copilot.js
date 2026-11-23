import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, canManageGuild, channelSafeName, embed, hexToInt, parseList, randomId, truncate } from './util.js';
import { askModel, aiConfigured } from './ai.js';
import { activatePanic, deactivatePanic } from './panic.js';
import { setupStats } from './stats.js';

export const OPS = [
  'create_category',
  'create_text',
  'create_voice',
  'create_role',
  'slowmode',
  'post_message',
  'panic',
  'stats',
];

function context(guild) {
  const categories = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildCategory)
    .map((channel) => channel.name)
    .slice(0, 20);
  const channels = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildText)
    .map((channel) => `#${channel.name}`)
    .slice(0, 40);
  const roles = guild.roles.cache
    .filter((role) => role.id !== guild.id && !role.managed)
    .map((role) => `@${role.name}`)
    .slice(0, 30);
  return { categories, channels, roles };
}

function quoteList(names) {
  return names.map((name) => `"${name}"`).join(', ');
}

function localPlan(guild, request) {
  const text = String(request ?? '').trim();
  const lower = text.toLowerCase();
  const steps = [];
  const summaryParts = [];

  if (/^(lock|panic|raid)\b/.test(lower) || /\bpanic mode\b/.test(lower)) {
    return { summary: 'Turn on panic mode.', steps: [{ op: 'panic', on: true }], source: 'local' };
  }
  if (/\bunlock\b/.test(lower) || /\bend panic\b/.test(lower)) {
    return { summary: 'Turn off panic mode and restore the server.', steps: [{ op: 'panic', on: false }], source: 'local' };
  }
  if (/\bstat channels?\b|\bserver counters?\b/.test(lower)) {
    return { summary: 'Create the live member and boost counters.', steps: [{ op: 'stats' }], source: 'local' };
  }

  const categoryMatch = /\bcategory\b(?:\s+(?:called|named))?\s+["']?([^"',.]+?)["']?(?:\s+with\s+(?:channels?\s+)?(.+))?$/i.exec(text);
  if (categoryMatch) {
    const name = categoryMatch[1].trim();
    steps.push({ op: 'create_category', name });
    summaryParts.push(`Create the **${name}** category`);
    const channelNames = categoryMatch[2]
      ? parseList(categoryMatch[2].replace(/\s+and\s+/gi, ','), { max: 10, maxLength: 90 })
      : [];
    for (const channel of channelNames) steps.push({ op: 'create_text', name: channel, category: name });
    if (channelNames.length) summaryParts.push(`add ${channelNames.length} channel(s) to it`);
  }

  const channelMatch = /\bchannels?\b(?:\s+(?:called|named))?\s+(.+)$/i.exec(text);
  if (!categoryMatch && channelMatch) {
    const names = parseList(channelMatch[1], { max: 10, maxLength: 90 });
    for (const name of names) steps.push({ op: 'create_text', name });
    if (names.length) summaryParts.push(`Create ${names.length} text channel(s): ${quoteList(names)}`);
  }

  const roleMatch = /\brole\b(?:\s+(?:called|named))?\s+["']?([^"',.]+)["']?/i.exec(text);
  if (roleMatch) {
    const name = roleMatch[1].trim();
    steps.push({ op: 'create_role', name });
    summaryParts.push(`Create the **${name}** role`);
  }

  if (steps.length === 0) {
    return {
      summary: aiConfigured()
        ? 'The copilot could not turn that into changes.'
        : 'Add an AI key to the host runner (OPENAI_API_KEY) for free-form requests. Without one I can only handle simple ones: categories, channels, roles, panic mode and stat channels.',
      steps: [],
      source: 'local',
    };
  }
  return { summary: `${summaryParts.join(', ')}.`, steps, source: 'local' };
}

function sanitizePlan(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) return null;
  const steps = [];
  for (const step of raw.steps.slice(0, 12)) {
    if (!step || typeof step !== 'object') continue;
    const op = String(step.op ?? '').trim();
    if (!OPS.includes(op)) continue;
    const clean = { op };
    if (step.name !== undefined) clean.name = String(step.name).trim().slice(0, 90);
    if (step.category !== undefined) clean.category = String(step.category).trim().slice(0, 90);
    if (step.topic !== undefined) clean.topic = String(step.topic).slice(0, 200);
    if (step.color !== undefined) clean.color = String(step.color).slice(0, 9);
    if (step.hoist !== undefined) clean.hoist = Boolean(step.hoist);
    if (step.channel !== undefined) clean.channel = String(step.channel).trim().slice(0, 100);
    if (step.seconds !== undefined) clean.seconds = Math.min(21_600, Math.max(0, Math.round(Number(step.seconds) || 0)));
    if (step.text !== undefined) clean.text = String(step.text).slice(0, 1500);
    if (step.on !== undefined) clean.on = Boolean(step.on);
    steps.push(clean);
  }
  const summary = String(raw.summary ?? '').trim().slice(0, 300) || 'Apply these changes.';
  return { summary, steps, source: 'ai' };
}

export async function planRequest(features, guild, request) {
  const text = String(request ?? '').trim().slice(0, 800);
  if (!text) throw new Error('Describe what you want to change.');

  if (aiConfigured()) {
    const existing = context(guild);
    const result = await askModel(
      [
        'You turn a Discord server owner request into a JSON change plan.',
        'Reply with JSON only, no markdown: {"summary":"one sentence","steps":[...]}.',
        `Allowed ops: ${OPS.join(', ')}.`,
        'create_category {name}; create_text {name, category?, topic?}; create_voice {name, category?}; create_role {name, color?, hoist?}; slowmode {channel?, seconds}; post_message {channel?, text}; panic {on}; stats {}.',
        'Only use ops from that list. Never invent permissions, webhooks or deletions. Maximum 12 steps. Use existing category names exactly when the request implies them.',
        'Channel names must be plain words, 1-90 characters, no # or emoji spam.',
      ].join('\n'),
      `Server: ${guild.name} (${guild.memberCount} members)\nCategories: ${existing.categories.join(', ') || 'none'}\nText channels: ${
        existing.channels.join(', ') || 'none'
      }\nRoles: ${existing.roles.join(', ') || 'none'}\nRequest: ${text}`,
      { maxTokens: 700, temperature: 0.2 },
    );

    if (result.ok) {
      const start = result.content.indexOf('{');
      const end = result.content.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const plan = sanitizePlan(JSON.parse(result.content.slice(start, end + 1)));
          if (plan) return plan;
        } catch {
          // Fall through to the local parser.
        }
      }
    }
  }

  return localPlan(guild, text);
}

function resolveCategory(guild, name) {
  if (!name) return null;
  const wanted = String(name).toLowerCase().replace(/^#/, '');
  return (
    guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === wanted,
    ) ?? null
  );
}

function resolveChannel(guild, name) {
  const wanted = String(name ?? '').toLowerCase().replace(/^#/, '');
  if (!wanted) return guild.systemChannel ?? guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText) ?? null;
  return (
    guild.channels.cache.get(wanted) ??
    guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.name.toLowerCase() === wanted) ??
    null
  );
}

export async function applyPlan(features, guild, plan) {
  const results = [];
  for (const step of plan.steps ?? []) {
    try {
      if (step.op === 'create_category') {
        const channel = await guild.channels.create({ name: String(step.name || 'New category').slice(0, 90), type: ChannelType.GuildCategory });
        results.push({ op: step.op, ok: true, detail: `Created category ${channel.name}` });
      } else if (step.op === 'create_text' || step.op === 'create_voice') {
        const parent = resolveCategory(guild, step.category);
        const channel = await guild.channels.create({
          name: (step.op === 'create_text' ? channelSafeName(step.name, 'text') : String(step.name || 'voice').slice(0, 90)) || 'text',
          type: step.op === 'create_text' ? ChannelType.GuildText : ChannelType.GuildVoice,
          parent: parent?.id,
          topic: step.op === 'create_text' ? step.topic : undefined,
        });
        results.push({ op: step.op, ok: true, detail: `Created ${step.op === 'create_text' ? '#' : 'voice '}${channel.name}` });
      } else if (step.op === 'create_role') {
        const color = hexToInt(step.color) ?? 0;
        const role = await guild.roles.create({ name: String(step.name || 'New role').slice(0, 100), color, hoist: Boolean(step.hoist), reason: 'Aegis copilot' });
        results.push({ op: step.op, ok: true, detail: `Created role ${role.name}` });
      } else if (step.op === 'slowmode') {
        const channel = resolveChannel(guild, step.channel);
        if (!channel || typeof channel.setRateLimitPerUser !== 'function') throw new Error('That channel cannot take slowmode.');
        await channel.setRateLimitPerUser(Math.min(21_600, Math.max(0, Number(step.seconds) || 0)), 'Aegis copilot');
        results.push({ op: step.op, ok: true, detail: `Slowmode on #${channel.name} set to ${step.seconds}s` });
      } else if (step.op === 'post_message') {
        const channel = resolveChannel(guild, step.channel);
        if (!channel?.isTextBased?.()) throw new Error('No usable channel for that message.');
        await channel.send({ content: truncate(step.text || '', 1800), allowedMentions: { parse: [] } });
        results.push({ op: step.op, ok: true, detail: `Posted in #${channel.name}` });
      } else if (step.op === 'panic') {
        if (step.on) await activatePanic(features, guild, { by: 'copilot' });
        else await deactivatePanic(features, guild, { by: 'copilot' });
        results.push({ op: step.op, ok: true, detail: step.on ? 'Panic mode on' : 'Panic mode off' });
      } else if (step.op === 'stats') {
        const made = await setupStats(features, guild);
        results.push({ op: step.op, ok: true, detail: `Created ${Object.keys(made.names).length} counters` });
      } else {
        results.push({ op: step.op, ok: false, detail: 'Unknown step' });
      }
    } catch (error) {
      results.push({ op: step.op, ok: false, detail: error.message });
    }
  }
  return results;
}

function planLines(plan) {
  return (plan.steps ?? [])
    .map((step, index) => {
      const detail =
        step.op === 'create_category'
          ? `Create category **${step.name}**`
          : step.op === 'create_text'
            ? `Create text channel **#${channelSafeName(step.name, 'text')}**${step.category ? ` in **${step.category}**` : ''}`
            : step.op === 'create_voice'
              ? `Create voice channel **${step.name}**${step.category ? ` in **${step.category}**` : ''}`
              : step.op === 'create_role'
                ? `Create role **${step.name}**`
                : step.op === 'slowmode'
                  ? `Set slowmode on **${step.channel || 'current channel'}** to ${step.seconds}s`
                  : step.op === 'post_message'
                    ? `Post a message in **${step.channel || 'the first channel'}**`
                    : step.op === 'panic'
                      ? step.on
                        ? 'Turn on panic mode'
                        : 'Turn off panic mode'
                      : 'Create the stat channels';
      return `${index + 1}. ${detail}`;
    })
    .join('\n');
}

export async function handleCopilotComponent(features, interaction) {
  const [prefix, action, id] = interaction.customId.split(':');
  if (prefix !== 'cp') return false;
  features.pendingPlans ??= new Map();
  const pending = features.pendingPlans.get(id);
  if (!pending || pending.userId !== interaction.user.id) {
    await interaction.reply({ embeds: [embed('Plan expired', 'Ask `/copilot` again.', COLORS.off)], flags: 64 });
    return true;
  }

  if (action === 'cancel') {
    features.pendingPlans.delete(id);
    await interaction.update({ embeds: [embed('Plan discarded', 'Nothing changed.', COLORS.muted)], components: [] });
    return true;
  }

  if (action === 'run') {
    await interaction.deferUpdate();
    const results = await applyPlan(features, interaction.guild, pending.plan);
    features.pendingPlans.delete(id);
    const ok = results.filter((row) => row.ok).length;
    await interaction.editReply({
      embeds: [
        embed(
          ok === results.length ? 'Changes applied' : 'Finished with problems',
          results.map((row) => `${row.ok ? '✅' : '❌'} ${row.detail}`).join('\n') || 'Nothing to do.',
          ok === results.length ? COLORS.on : COLORS.warn,
        ),
      ],
      components: [],
    });
  }
  return true;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('copilot')
      .setDescription('Describe a server change and let Aegis plan it')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) =>
        option
          .setName('request')
          .setDescription('e.g. "create a tournament category with info, rules and chat"')
          .setRequired(true)
          .setMaxLength(800),
      ),

    async execute(interaction, { features }) {
      if (!canManageGuild(interaction.member)) {
        await interaction.reply({ embeds: [embed('Missing permission', 'You need **Manage Server**.', COLORS.off)], flags: 64 });
        return;
      }
      await interaction.deferReply({ flags: 64 });
      try {
        const plan = await planRequest(features, interaction.guild, interaction.options.getString('request', true));
        if (!plan.steps.length) {
          await interaction.editReply({ embeds: [embed('No plan', plan.summary, COLORS.warn)] });
          return;
        }
        const id = randomId(8);
        features.pendingPlans ??= new Map();
        features.pendingPlans.set(id, { id, userId: interaction.user.id, plan });
        if (features.pendingPlans.size > 40) {
          features.pendingPlans.delete(features.pendingPlans.keys().next().value);
        }
        await interaction.editReply({
          embeds: [
            embed(
              '🧠 Proposed plan',
              `${plan.summary}\n\n${planLines(plan)}\n\n_${plan.source === 'ai' ? 'Planned by AI from your request.' : 'Planned locally — add an AI key for free-form requests.'}_`,
              COLORS.brand,
            ),
          ],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`cp:run:${id}`).setLabel('Apply changes').setStyle(ButtonStyle.Success).setEmoji('✅'),
              new ButtonBuilder().setCustomId(`cp:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      } catch (error) {
        await interaction.editReply({ embeds: [embed('Copilot failed', error.message, COLORS.off)] });
      }
    },
  },
];
