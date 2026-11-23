/*
 * Single source of truth for the public feature page (/features).
 * Update this file in the same commit whenever a user-facing feature is
 * added, changed or removed, so the page never drifts from the bot.
 */

export const FEATURES_UPDATED = '23 November 2026';

export const OWNER = {
  name: 'Aqua',
  discordId: '1157029665031077918',
  discordUrl: 'https://discord.com/users/1157029665031077918',
};

export const FEATURE_GROUPS = [
  {
    title: 'Protection',
    blurb: 'Keep the server safe, and undo a raid in one command.',
    features: [
      {
        name: 'Panic Mode',
        command: '/panic',
        description:
          'Locks every channel, snapshots permissions and quarantines recent joins. One command puts it all back exactly as it was.',
      },
      {
        name: 'Anti-Nuke Guard',
        command: '/antinuke',
        description:
          "Watches the audit log for mass bans, kicks, channel or role deletions and role grants, then strips the offender's dangerous roles and alerts you.",
      },
      {
        name: 'Server Doctor',
        command: '/doctor',
        description:
          'Audits permissions, roles, channels, verification and 2FA, scores the setup and applies the safe fixes for you.',
      },
      {
        name: 'Member Protections',
        command: '/protections',
        description:
          'Anti server-mute and anti server-deafen rules, plus forced mute or deafen for one member or the whole server.',
      },
      {
        name: 'Role Management',
        command: '/roles',
        description:
          'Create, recolour, reorder, assign and delete roles with hierarchy checks, from Discord or from the Roles tab.',
      },
    ],
  },
  {
    title: 'Community',
    blurb: 'Things members actually use, without staff doing the busywork.',
    features: [
      {
        name: 'Tickets',
        command: '/ticket',
        description:
          'Panels with categories, priorities, claiming, transcripts and staff statistics, closed and archived in one click.',
      },
      {
        name: 'Giveaways',
        command: '/giveaway',
        description:
          'Timed draws with role, account-age and server-age requirements, automatic winners and rerolls.',
      },
      {
        name: 'Reaction Roles',
        command: '/reactionroles',
        description: 'Button or dropdown panels that hand out and take back roles with no staff time.',
      },
      {
        name: 'Events',
        command: '/event',
        description:
          'RSVP buttons with a capacity and waitlist, reminders before the start and a check-in window afterwards.',
      },
      {
        name: 'Economy & Shop',
        command: '/coins · /shop',
        description:
          'Members earn coins from messages and voice time, then spend them on role rewards in your shop.',
      },
      {
        name: 'LFG Matchmaking',
        command: '/lfg',
        description:
          'Members post the games, region, skill and hours they play; Aegis matches them with people who fit.',
      },
    ],
  },
  {
    title: 'Server tools',
    blurb: 'The everyday setup work, handled in a few clicks.',
    features: [
      {
        name: 'Logging',
        command: '/logs',
        description:
          'A channel for each event type — messages, joins, roles, channels and moderation — toggled per server.',
      },
      {
        name: 'Backups',
        command: '/backup',
        description:
          'Snapshot channels, roles and permission overwrites, then restore, export or import the file when you need it.',
      },
      {
        name: 'Temp Voice',
        command: '/tempvoice',
        description:
          'Join-to-create voice channels with rename, user limit, lock, claim and automatic cleanup when empty.',
      },
      {
        name: 'Stat Channels',
        command: '/stats',
        description: 'Live member, boost and channel counters that keep themselves updated.',
      },
      {
        name: 'Embed Builder',
        command: '/embed',
        description: 'Build, preview and send rich embeds, or edit a message that is already posted.',
      },
    ],
  },
  {
    title: 'Insights & AI',
    blurb: 'Read the room, and let Aegis do the writing and the planning.',
    features: [
      {
        name: 'Server Intelligence',
        command: '/intel',
        description:
          'Activity trends, a community health score, channels needing attention, alt-account signals and raid alerts.',
      },
      {
        name: 'Staff Activity',
        command: '/staff',
        description:
          'Messages, voice time, actions and moderation counts per staff member, with leaderboards and scheduled reports.',
      },
      {
        name: 'AI Announcements',
        command: '/announce',
        description:
          'Drafts announcements and scheduled server reports in the tone you pick, with an optional ping role and image.',
      },
      {
        name: 'AI Copilot',
        command: '/copilot',
        description:
          'Describe a change in plain language; the copilot plans it and applies only whitelisted steps after you confirm.',
      },
    ],
  },
  {
    title: 'Dashboard & apps',
    blurb: 'The same controls with or without Discord open.',
    features: [
      {
        name: 'Web Dashboard',
        description:
          'Run the whole bot from a browser: roles, channels, moderation, tools and logs. Nothing to install.',
      },
      {
        name: 'Desktop App',
        description:
          'A portable Windows app with the same controls, live bot logs, licence management and automatic GitHub updates.',
      },
      {
        name: 'Roles Tab',
        description:
          'A Discord-style role editor outside Discord — create, recolour, reorder, assign and delete with live permission checks.',
      },
      {
        name: 'Server Tools Panel',
        description:
          'Panic, anti-nuke, doctor, shop, events, stat counters and the copilot on one page, on the web and in the app.',
      },
    ],
  },
];

export const FEATURE_COUNT = FEATURE_GROUPS.reduce((total, group) => total + group.features.length, 0);
