#!/usr/bin/env node
/**
 * Aegis on one server.
 *
 * Serves the API and dashboard, then keeps the Discord bot online, so a single
 * host (Wispbyte, a VPS, a spare PC) replaces both the hosted site and the
 * separate host runner.
 *
 *   DISCORD_TOKEN=... PORT=12345 npm run selfhost
 *
 * Optional:
 *   AEGIS_HOST_TOKEN   dashboard start/stop works when this is set
 *   AEGIS_ALWAYS_RUN   defaults to 1 here: the bot stays up after a crash
 *   AEGIS_DATA_DIR     where the database and files live (host-data)
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createAegisServer } from '../server/node/server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || process.env.AEGIS_PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.AEGIS_DATA_DIR || path.join(root, 'host-data');
const DISCORD_TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const HOST_TOKEN = String(process.env.AEGIS_HOST_TOKEN || '').trim();
const ALWAYS_RUN = /^(1|true|yes|on)$/i.test(String(process.env.AEGIS_ALWAYS_RUN ?? '1').trim());
const LOCAL_SERVER = `http://127.0.0.1:${PORT}`;

const { server, env, close } = await createAegisServer({
  dataDir: DATA_DIR,
  adminToken: process.env.ADMIN_TOKEN || '',
  sessionSecret: process.env.SESSION_SECRET || '',
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, HOST, resolve);
});

console.log(`Aegis server listening on ${HOST}:${PORT}`);
console.log(`  data : ${DATA_DIR}`);
console.log(`  local: ${LOCAL_SERVER}`);

// A brand new server has no accounts, and the owner key is otherwise only shown
// to the desktop app. Print it once here so the whole set-up works from a
// browser on the host's own address.
await fetch(`${LOCAL_SERVER}/api/health`).catch(() => {});
try {
  const accounts = await env.DB.prepare('SELECT COUNT(*) AS count FROM accounts').first();
  if (Number(accounts?.count ?? 0) === 0) {
    const owner = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'owner_key'`).first();
    if (owner?.value) {
      console.log(`  owner key: ${owner.value}`);
      console.log('  register the first account with that key, then create licence keys');
    }
  }
} catch (error) {
  console.warn(`  owner key: could not be read yet (${error.message})`);
}

let runner = null;
let bot = null;

if (HOST_TOKEN) {
  // The dashboard controls the bot through the runner. It talks to this same
  // process over loopback, so nothing here depends on an external site.
  runner = spawn(process.execPath, [path.join(root, 'scripts', 'bot-host.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      AEGIS_SERVER: LOCAL_SERVER,
      AEGIS_ALWAYS_RUN: ALWAYS_RUN ? '1' : '0',
      AEGIS_DATA_DIR: path.join(DATA_DIR, 'bot'),
    },
    stdio: 'inherit',
  });
  runner.on('exit', (code) => console.warn(`Host runner exited with code ${code}.`));
  console.log('  bot  : host runner (dashboard start/stop enabled)');
} else if (DISCORD_TOKEN) {
  // No runner token yet: keep the bot up directly so it works out of the box.
  // The import is lazy so a missing bot file (an incomplete upload, for example)
  // cannot take the dashboard and API down with it.
  let BotManager = null;
  try {
    ({ BotManager } = await import('../src/bot.js'));
  } catch (error) {
    console.error(`  bot  : could not load the bot code (${error.message})`);
    console.error('         the API and dashboard are still running — re-upload src/');
  }
  if (BotManager) {
    bot = new BotManager({ dataDir: path.join(DATA_DIR, 'bot') });
    await bot.init();
    bot.on('log', (entry) => console.log(`[${entry.level}] ${entry.message}`));
    await bot.start(DISCORD_TOKEN).catch((error) => console.error(error.message));
    console.log('  bot  : running in this process (no AEGIS_HOST_TOKEN set)');
  }
} else {
  console.warn('  bot  : not started (set DISCORD_TOKEN, or AEGIS_HOST_TOKEN for dashboard control)');
}

let closing = false;

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} received - shutting down...`);
  if (runner) runner.kill('SIGTERM');
  if (bot) await bot.stop().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  console.error('Unhandled error:', error?.message ?? error);
});
