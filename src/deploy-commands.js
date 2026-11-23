import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const token = process.env.DISCORD_TOKEN?.trim();
const clientId = process.env.CLIENT_ID?.trim() || process.env.DISCORD_CLIENT_ID?.trim();
const guildId = process.env.GUILD_ID?.trim();

if (!token) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const body = commands.map((command) => command.data.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

try {
  if (!clientId) {
    // Fall back to the application that owns the token.
    const application = await rest.get(Routes.currentApplication());
    console.log(
      `CLIENT_ID not set, using the token owner (${application.name} / ${application.id}).`,
    );
    await register(application.id);
  } else {
    await register(clientId);
  }
} catch (error) {
  console.error('Failed to register slash commands:', error);
  process.exit(1);
}

async function register(applicationId) {
  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);

  // The same name registered globally and in the server shows up twice, so
  // clear the scope we are not using.
  if (guildId) {
    const existingGlobal = await rest.get(Routes.applicationCommands(applicationId)).catch(() => []);
    for (const command of existingGlobal) {
      if (!body.some((entry) => entry.name === command.name)) continue;
      await rest.delete(Routes.applicationCommand(applicationId, command.id)).catch(() => {});
      console.log(`Removed the global copy of /${command.name}.`);
    }
  } else {
    const guilds = (await rest.get(Routes.userGuilds()).catch(() => [])) ?? [];
    for (const guild of guilds) {
      const existing = await rest
        .get(Routes.applicationGuildCommands(applicationId, guild.id))
        .catch(() => []);
      for (const command of existing) {
        if (!body.some((entry) => entry.name === command.name)) continue;
        await rest
          .delete(Routes.applicationGuildCommand(applicationId, guild.id, command.id))
          .catch(() => {});
        console.log(`Removed the server copy of /${command.name} from ${guild.name}.`);
      }
    }
  }

  const data = await rest.put(route, { body });
  console.log(
    `Registered ${data.length} slash command(s) ${guildId ? `on guild ${guildId}` : 'globally'}: ${data
      .map((command) => `/${command.name}`)
      .join(', ')}`,
  );
}
