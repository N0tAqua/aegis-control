import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, embed, parseList, truncate } from './util.js';

const DAY_ALIASES = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const SKILLS = ['beginner', 'intermediate', 'advanced', 'any'];
const PLAYSTYLES = ['casual', 'competitive', 'chill', 'serious', 'any'];

function parseClock(text) {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour > 24 || (match[2] && Number(match[2]) > 59)) return null;
  return Math.min(24, hour);
}

/** "Mon-Fri 18-23, Sat 10-20" → slots with day numbers and hour windows. */
export function parseAvailability(input) {
  const text = String(input ?? '').toLowerCase();
  const slots = [];
  const segments = text.split(/[,;]/);
  for (const segment of segments) {
    const range = /([a-z]+)\s*[-–]\s*([a-z]+)\s*(\d{1,2})(?::\d{2})?\s*[-–]\s*(\d{1,2})(?::\d{2})?/.exec(segment);
    if (range && DAY_ALIASES[range[1]] !== undefined && DAY_ALIASES[range[2]] !== undefined) {
      const start = DAY_ALIASES[range[1]];
      const end = DAY_ALIASES[range[2]];
      const from = parseClock(range[3]);
      const to = parseClock(range[4]);
      if (from === null || to === null) continue;
      const days = [];
      for (let day = start; ; day = (day + 1) % 7) {
        days.push(day);
        if (day === end || days.length > 7) break;
      }
      slots.push({ days, from, to });
      continue;
    }
    const single = /([a-z]+)\s*(\d{1,2})(?::\d{2})?\s*[-–]\s*(\d{1,2})(?::\d{2})?/.exec(segment);
    if (single && DAY_ALIASES[single[1]] !== undefined) {
      const from = parseClock(single[2]);
      const to = parseClock(single[3]);
      if (from === null || to === null) continue;
      slots.push({ days: [DAY_ALIASES[single[1]]], from, to });
      continue;
    }
    if (/weekend/.test(segment)) {
      const hours = /(\d{1,2})(?::\d{2})?\s*[-–]\s*(\d{1,2})(?::\d{2})?/.exec(segment);
      if (hours) {
        const from = parseClock(hours[1]);
        const to = parseClock(hours[2]);
        if (from !== null && to !== null) slots.push({ days: [0, 6], from, to });
      }
      continue;
    }
    if (/weekday/.test(segment)) {
      const hours = /(\d{1,2})(?::\d{2})?\s*[-–]\s*(\d{1,2})(?::\d{2})?/.exec(segment);
      if (hours) {
        const from = parseClock(hours[1]);
        const to = parseClock(hours[2]);
        if (from !== null && to !== null) slots.push({ days: [1, 2, 3, 4, 5], from, to });
      }
    }
  }
  return slots;
}

function availabilityOverlap(a = [], b = []) {
  let hours = 0;
  for (const left of a) {
    for (const right of b) {
      if (!left.days.some((day) => right.days.includes(day))) continue;
      const start = Math.max(left.from, right.from);
      const end = Math.min(left.to, right.to);
      hours += Math.max(0, end - start);
    }
  }
  return hours;
}

function profileSummary(profile) {
  return [
    profile.games.length ? `🎮 ${profile.games.join(', ')}` : null,
    `📈 ${profile.skill}`,
    profile.region ? `🌍 ${profile.region}` : null,
    profile.playstyle !== 'any' ? `🎯 ${profile.playstyle}` : null,
    profile.availability ? `🕒 ${profile.availability}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function scoreProfiles(me, other) {
  const reasons = [];
  let score = 0;

  const shared = me.games.filter((game) => other.games.includes(game));
  if (shared.length) {
    score += Math.min(12, shared.length * 4);
    reasons.push(`Plays ${shared.join(', ')}`);
  }

  if (me.skill === other.skill) {
    score += 3;
    reasons.push('Same skill level');
  } else if (me.skill === 'any' || other.skill === 'any') {
    score += 1.5;
    reasons.push('Skill range is flexible');
  } else {
    const order = ['beginner', 'intermediate', 'advanced'];
    if (Math.abs(order.indexOf(me.skill) - order.indexOf(other.skill)) === 1) {
      score += 1;
      reasons.push('Similar skill level');
    }
  }

  if (me.region && other.region) {
    if (me.region.toLowerCase() === other.region.toLowerCase()) {
      score += 3;
      reasons.push('Same region');
    } else if (['any', 'global'].includes(other.region.toLowerCase())) {
      score += 1;
      reasons.push('Flexible region');
    }
  }

  if (me.playstyle !== 'any' && me.playstyle === other.playstyle) {
    score += 2;
    reasons.push(`Both prefer ${me.playstyle} play`);
  }

  const overlap = availabilityOverlap(me.slots, other.slots);
  if (overlap > 0) {
    score += Math.min(8, overlap * 1.2);
    reasons.push(`Free at the same time (${overlap}h overlap)`);
  }

  return { score: Math.round(score * 10) / 10, reasons, shared };
}

/* ----------------------------------------------------------------- command --- */

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('lfg')
      .setDescription('Find people to play with')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) =>
        sub
          .setName('profile')
          .setDescription('Set up or update your matchmaking profile')
          .addStringOption((option) =>
            option.setName('games').setDescription('Games you play, comma separated').setRequired(true).setMaxLength(300),
          )
          .addStringOption((option) =>
            option
              .setName('skill')
              .setDescription('Your skill level')
              .setRequired(false)
              .addChoices(...SKILLS.map((skill) => ({ name: skill, value: skill }))),
          )
          .addStringOption((option) => option.setName('region').setDescription('Region, e.g. EU or NA-East').setRequired(false).setMaxLength(30))
          .addStringOption((option) =>
            option
              .setName('availability')
              .setDescription('When you play, e.g. Mon-Fri 18-23, Sat 10-20')
              .setRequired(false)
              .setMaxLength(120),
          )
          .addStringOption((option) =>
            option
              .setName('playstyle')
              .setDescription('How you like to play')
              .setRequired(false)
              .addChoices(...PLAYSTYLES.map((style) => ({ name: style, value: style }))),
          )
          .addStringOption((option) => option.setName('about').setDescription('Anything else').setRequired(false).setMaxLength(200)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('find')
          .setDescription('Find your best matches')
          .addStringOption((option) => option.setName('game').setDescription('Only match this game').setRequired(false).setMaxLength(60))
          .addStringOption((option) => option.setName('region').setDescription('Only match this region').setRequired(false).setMaxLength(30)),
      )
      .addSubcommand((sub) => sub.setName('clear').setDescription('Delete your matchmaking profile'))
      .addSubcommand((sub) => sub.setName('stats').setDescription('Matchmaking overview')),

    async execute(interaction, { features }) {
      const guildId = interaction.guildId;
      const config = features.store.guild(guildId);
      const profiles = config.profiles ?? (config.profiles = {});
      const subcommand = interaction.options.getSubcommand();
      const mine = profiles[interaction.user.id];

      if (subcommand === 'profile') {
        const games = parseList(interaction.options.getString('games', true));
        if (games.length === 0) {
          await interaction.reply({ embeds: [embed('Games required', 'List at least one game.', COLORS.off)], flags: 64 });
          return;
        }
        const availability = interaction.options.getString('availability') ?? '';
        const profile = {
          userId: interaction.user.id,
          username: interaction.user.username,
          games: games.map((game) => game.toLowerCase()),
          skill: interaction.options.getString('skill') ?? 'any',
          region: (interaction.options.getString('region') ?? '').trim(),
          availability,
          slots: parseAvailability(availability),
          playstyle: interaction.options.getString('playstyle') ?? 'any',
          about: interaction.options.getString('about') ?? '',
          updatedAt: Date.now(),
        };
        profiles[interaction.user.id] = profile;
        features.store.save();
        await interaction.reply({
          embeds: [
            embed(
              'Matchmaking profile saved',
              `${profileSummary(profile)}\n\nUse \`/lfg find\` to see who fits your schedule and games.`,
              COLORS.on,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (subcommand === 'clear') {
        if (!mine) {
          await interaction.reply({ embeds: [embed('No profile', 'You do not have a matchmaking profile yet.', COLORS.muted)], flags: 64 });
          return;
        }
        delete profiles[interaction.user.id];
        features.store.save();
        await interaction.reply({ embeds: [embed('Profile deleted', 'Your matchmaking profile was removed.', COLORS.muted)], flags: 64 });
        return;
      }

      if (subcommand === 'stats') {
        const all = Object.values(profiles);
        const gameCounts = new Map();
        for (const profile of all) {
          for (const game of profile.games) gameCounts.set(game, (gameCounts.get(game) ?? 0) + 1);
        }
        const topGames = [...gameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
        await interaction.reply({
          embeds: [
            embed(
              'Matchmaking overview',
              [
                `**Profiles:** ${all.length}`,
                topGames.length ? `\n**Popular games**\n${topGames.map(([game, count]) => `• ${game} — ${count}`).join('\n')}` : '',
                mine ? `\nYour profile: ${profileSummary(mine)}` : '\nYou have no profile yet — use `/lfg profile`.',
              ].join('\n'),
              COLORS.brand,
            ),
          ],
          flags: 64,
        });
        return;
      }

      if (!mine) {
        await interaction.reply({
          embeds: [embed('No profile yet', 'Create one with `/lfg profile games:...` first.', COLORS.warn)],
          flags: 64,
        });
        return;
      }

      const gameFilter = interaction.options.getString('game')?.trim().toLowerCase();
      const regionFilter = interaction.options.getString('region')?.trim().toLowerCase();
      const candidates = Object.values(profiles)
        .filter((profile) => profile.userId !== interaction.user.id)
        .filter((profile) => (gameFilter ? profile.games.includes(gameFilter) : profile.games.some((game) => mine.games.includes(game))))
        .filter((profile) => (regionFilter ? profile.region.toLowerCase() === regionFilter : true))
        .map((profile) => ({ profile, ...scoreProfiles(mine, profile) }))
        .filter((entry) => entry.shared.length > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (candidates.length === 0) {
        await interaction.reply({
          embeds: [
            embed(
              'No matches yet',
              gameFilter ? `Nobody else has a profile for **${gameFilter}** yet.` : 'Nobody shares your games yet. Invite people to set `/lfg profile`.',
              COLORS.muted,
            ),
          ],
          flags: 64,
        });
        return;
      }

      await interaction.reply({
        embeds: [
          embed(
            `Best matches for you`,
            candidates
              .map(
                (entry, index) =>
                  `**${index + 1}.** <@${entry.profile.userId}> — score **${entry.score}**\n${entry.reasons
                    .slice(0, 4)
                    .map((reason) => `> ${reason}`)
                    .join('\n')}${entry.profile.about ? `\n> _"${truncate(entry.profile.about, 120)}"_` : ''}`,
              )
              .join('\n\n'),
            COLORS.brand,
          ),
        ],
        flags: 64,
      });
    },
  },
];
