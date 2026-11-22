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
 * On this host the bot runs under the built-in host runner, so the dashboard and
 * app can start or stop the bot without touching the API, the dashboard or the
 * Discord connection of the other parts.
 *
 * Optional:
 *   AEGIS_HOST_TOKEN   pin the runner token (for an external runner instead)
 *   AEGIS_HOST_RUNNER  set 0 to disable the built-in runner
 *   AEGIS_ALWAYS_RUN   set 1 to ignore dashboard stop commands
 *   AEGIS_DATA_DIR     where the database and files live (host-data)
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createAegisServer } from '../server/node/server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const PORT_FROM_ENV = process.env.PORT || process.env.SERVER_PORT || process.env.AEGIS_PORT || '';
const PORT = Number(PORT_FROM_ENV || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.AEGIS_DATA_DIR || path.join(root, 'host-data');
const DISCORD_TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const HOST_TOKEN = String(process.env.AEGIS_HOST_TOKEN || '').trim();
const ALWAYS_RUN = /^(1|true|yes|on)$/i.test(String(process.env.AEGIS_ALWAYS_RUN ?? '0').trim());
const LOCAL_SERVER = `http://127.0.0.1:${PORT}`;

const { server, env, close } = await createAegisServer({
  dataDir: DATA_DIR,
  adminToken: process.env.ADMIN_TOKEN || '',
  sessionSecret: process.env.SESSION_SECRET || '',
});

// The download page and the app's updater take the newest build straight from
// GitHub releases when a repository is known, so pushing code is enough.
const GITHUB_REPO =
  String(process.env.AEGIS_GITHUB_REPO || '').trim() ||
  (/^github:([\w.-]+\/[\w.-]+)$/.exec(String(pkg.repository || ''))?.[1] ?? '');
if (GITHUB_REPO) {
  env.AEGIS_GITHUB_REPO = GITHUB_REPO;
  console.log(`  github: ${GITHUB_REPO} (downloads follow its latest release)`);
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
} catch (error) {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use on this machine.`);
    console.error('Set PORT to the port the host gives you (Console -> Server info).');
    process.exit(1);
  }
  if (error?.code === 'EACCES') {
    console.error(`This process is not allowed to listen on port ${PORT}. Use the port the host gives you.`);
    process.exit(1);
  }
  throw error;
}

console.log(`Aegis server listening on ${HOST}:${PORT}`);
console.log(`  data : ${DATA_DIR}`);
console.log(`  local: ${LOCAL_SERVER}`);
if (!PORT_FROM_ENV) {
  console.warn('  PORT is not set, so this listens on 3000. A hosting panel only reaches');
  console.warn('  the port shown in Console -> Server info, so set PORT to that number.');
}

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

/* -------------------------------------------------------- host runner ---
 * Start/stop in the dashboard and the app is a message from the website to a
 * runner on this machine. Without one, the buttons are accepted and nothing
 * happens, so a fresh install gets a token and a runner on its own. Only the bot
 * process is stopped by those buttons; the server, the dashboard and the API
 * keep running because they are separate processes.
 *
 * A token is only minted when the dashboard has never made one: an existing hash
 * belongs to a runner somewhere else and replacing it would lock it out. */
const RUNNER_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.AEGIS_HOST_RUNNER ?? '1').trim());

async function readSetting(key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

async function writeSetting(key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, String(value))
    .run();
}

function makeHostToken() {
  const group = () => randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  return `AEGIS-HOST-${group()}-${group()}-${group()}-${group()}`;
}

let runnerToken = HOST_TOKEN;
if (!runnerToken && RUNNER_ENABLED) {
  try {
    if (await readSetting('bot_host_hash')) {
      console.log('  host : a host token already exists, so no local runner was started');
      console.log('         set AEGIS_HOST_TOKEN to use the dashboard buttons from here');
    } else {
      runnerToken = makeHostToken();
      await writeSetting(
        'bot_host_hash',
        createHash('sha256').update(runnerToken).digest('hex'),
      );
      // A brand new install comes online by itself, then follows the dashboard.
      if (!(await readSetting('bot_desired'))) await writeSetting('bot_desired', 'running');
      console.log('  host : runner token created, so dashboard start/stop works');
    }
  } catch (error) {
    console.warn(`  host : could not set up the dashboard runner (${error.message})`);
  }
}

let runner = null;
let bot = null;

if (runnerToken) {
  // The dashboard controls the bot through the runner. It talks to this same
  // process over loopback, so nothing here depends on an external site.
  if (ALWAYS_RUN) {
    console.warn('  note : Stop from the dashboard is respected (AEGIS_ALWAYS_RUN is ignored here)');
  }
  runner = spawn(process.execPath, [path.join(root, 'scripts', 'bot-host.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      AEGIS_SERVER: LOCAL_SERVER,
      AEGIS_HOST_TOKEN: runnerToken,
      // Always-run would make the Stop button a no-op; BotManager still brings
      // the bot back by itself after a crash, which is what always-run was for.
      AEGIS_ALWAYS_RUN: '0',
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
