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

  const data = await rest.put(route, { body });
  console.log(
    `Registered ${data.length} slash command(s) ${guildId ? `on guild ${guildId}` : 'globally'}: ${data
      .map((command) => `/${command.name}`)
      .join(', ')}`,
  );
}
