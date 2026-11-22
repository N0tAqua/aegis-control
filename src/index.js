import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotManager } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bot = new BotManager({ dataDir: path.join(__dirname, '..', 'data') });
await bot.init();

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error(
    'DISCORD_TOKEN is missing. Copy .env.example to .env, paste your bot token and run `npm run bot` again. (The desktop app stores the token itself.)',
  );
  process.exit(1);
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, stopping Aegis…`);
  await bot.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await bot.start(token);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
