import { commands as logging } from './logging.js';
import { commands as reactionRoles } from './reaction-roles.js';
import { commands as tickets } from './tickets.js';
import { commands as embeds } from './embeds.js';
import { commands as giveaways } from './giveaways.js';
import { commands as tempVoice } from './temp-voice.js';
import { commands as backup } from './backup.js';
import { commands as staff } from './staff.js';
import { commands as intel } from './intel.js';
import { commands as matchmaking } from './matchmaking.js';
import { commands as ai } from './ai.js';
import { commands as panic } from './panic.js';
import { commands as antinuke } from './nuke.js';
import { commands as doctor } from './doctor.js';
import { commands as economy } from './economy.js';
import { commands as events } from './events.js';
import { commands as stats } from './stats.js';
import { commands as copilot } from './copilot.js';

export const featureCommands = [
  ...logging,
  ...reactionRoles,
  ...tickets,
  ...embeds,
  ...giveaways,
  ...tempVoice,
  ...backup,
  ...staff,
  ...intel,
  ...matchmaking,
  ...ai,
  ...panic,
  ...antinuke,
  ...doctor,
  ...economy,
  ...events,
  ...stats,
  ...copilot,
];
