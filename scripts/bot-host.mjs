#!/usr/bin/env node
/**
 * Aegis host runner.
 *
 * Keeps the Discord bot online on a machine that stays on (VPS, spare PC, free
 * container) and obeys start/stop commands from the web dashboard.
 *
 *   DISCORD_TOKEN=... AEGIS_HOST_TOKEN=... AEGIS_SERVER=http://your-host:14651 npm run host
 *
 * Create the host token in the panel (Settings -> Dashboard access, owner) or
 * on the website dashboard under "Host runner".
 */
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { BotManager } from '../src/bot.js';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const SERVER = String(process.env.AEGIS_SERVER || '')
  .trim()
  .replace(/\/+$/, '');
const HOST_TOKEN = String(process.env.AEGIS_HOST_TOKEN || '').trim();
const DISCORD_TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const NODE_NAME = String(process.env.AEGIS_NODE_NAME || os.hostname()).slice(0, 60);
const DATA_DIR = process.env.AEGIS_DATA_DIR || path.join(root, 'host-data');
// Last run state the dashboard asked for. Kept on disk so a reboot, a paused
// site or a network outage cannot leave the bot down waiting for the server.
const STATE_FILE = path.join(DATA_DIR, 'host-state.json');
// AEGIS_ALWAYS_RUN=1 keeps the bot up no matter what the dashboard says.
const ALWAYS_RUN = /^(1|true|yes|on)$/i.test(String(process.env.AEGIS_ALWAYS_RUN || '').trim());
// Hosting counts every request against a daily (10,000) and a monthly (100,000)
// allowance, so a 24/7 runner has to stay cheap: one command check a minute and
// one status report every five minutes is about 1,730 requests a day (~52,000 a
// month), which leaves the rest of the allowance for the dashboard and the app.
const POLL_MS = 60_000;
const REPORT_MS = 300_000;
// Role edits from the panel or the app are queued on the server; this is how
// quickly the runner picks them up. Only polled while the bot is running, and
// only on a host that runs its own server, so the allowance comment above does
// not apply to it.
const TASK_MS = 5_000;

if (!HOST_TOKEN) {
  console.error(
    '\nAEGIS_HOST_TOKEN is missing.\n' +
      'Create a host runner token in the Aegis dashboard (Host runner card), then start again:\n' +
      '  DISCORD_TOKEN=<bot token> AEGIS_HOST_TOKEN=<host token> npm run host\n',
  );
  process.exit(1);
}

if (!SERVER) {
  console.error(
    '\nAEGIS_SERVER is missing. Point the runner at your dashboard, for example:\n' +
      '  DISCORD_TOKEN=<bot token> AEGIS_HOST_TOKEN=<host token> AEGIS_SERVER=http://your-host:14651 npm run host\n',
  );
  process.exit(1);
}

const bot = new BotManager({ dataDir: DATA_DIR });
await bot.init();

const logs = [];
let runnerError = DISCORD_TOKEN ? null : 'No DISCORD_TOKEN set on the host runner.';
let starting = false;
let desired = 'stopped';
let stopping = false;
let networkWarned = false;
let alwaysRunNoted = false;

function record(level, message) {
  console.log(`[${level}] ${message}`);
  logs.push({ level, message, at: Date.now() });
  if (logs.length > 150) logs.splice(0, logs.length - 150);
}

bot.on('log', (entry) => {
  logs.push(entry);
  if (logs.length > 150) logs.splice(0, logs.length - 150);
});

async function loadDesired() {
  if (ALWAYS_RUN) return 'running';
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (parsed?.desired === 'running' || parsed?.desired === 'stopped') return parsed.desired;
  } catch {
    // No saved state yet, so the dashboard decides.
  }
  return 'stopped';
}

async function saveDesired(value) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({ desired: value, updatedAt: Date.now() }));
  } catch (error) {
    record('warn', `Could not save the local run state (${error.message}).`);
  }
}

// Crashes are kept in the owner-only list on the server, not just in memory, so
// the reason is still there after the runner restarts.
const pendingCrashes = [];

async function flushCrashes() {
  if (!pendingCrashes.length) return;
  const batch = pendingCrashes.splice(0, pendingCrashes.length);
  try {
    await api('/api/bot/host/crashes', {
      method: 'POST',
      body: { crashes: batch, node: NODE_NAME, version: pkg.version },
    });
  } catch (error) {
    pendingCrashes.unshift(...batch);
    if (pendingCrashes.length > 40) pendingCrashes.splice(40);
    throw error;
  }
}

bot.on('crash', (entry) => {
  record('error', `Crash (${entry.reason}): ${entry.message}`);
  pendingCrashes.push(entry);
  flushCrashes().catch(() => {});
});

async function api(pathname, { method = 'GET', body } = {}) {
  const headers = { 'x-aegis-host': HOST_TOKEN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${SERVER}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || `Server responded ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function startBot() {
  if (starting || stopping) return;
  if (bot.getStatus().running) return;
  if (!DISCORD_TOKEN) {
    runnerError = 'No DISCORD_TOKEN set on the host runner.';
    return;
  }
  starting = true;
  try {
    runnerError = null;
    await bot.start(DISCORD_TOKEN);
    await pushRoles().catch(() => {});
  } catch (error) {
    runnerError = error.message;
    record('error', error.message);
  } finally {
    starting = false;
  }
}

async function stopBot() {
  if (!bot.getStatus().running && !bot.getStatus().starting) return;
  stopping = true;
  try {
    await bot.stop();
  } catch (error) {
    record('warn', `Stop warning: ${error.message}`);
  } finally {
    stopping = false;
  }
}

async function pushRoles(guildIds) {
  if (!bot.getStatus().running) return;
  const ids = guildIds?.length
    ? guildIds
    : (bot.getStatus().guilds ?? []).map((guild) => guild.id);
  for (const guildId of ids) {
    try {
      const snapshot = bot.listRoles(guildId);
      await api('/api/bot/host/roles', {
        method: 'POST',
        body: {
          guildId,
          guildName: snapshot.guildName,
          roles: snapshot.roles,
        },
      });
    } catch (error) {
      record('warn', `Could not publish roles for ${guildId}: ${error.message}`);
    }
  }
}

async function runRolesTask(task) {
  const guildId = String(task.guildId ?? '');
  const payload = task.payload ?? {};
  try {
    if (task.action === 'create') await bot.createRole(guildId, payload);
    else if (task.action === 'update') await bot.updateRole(guildId, payload.roleId, payload);
    else if (task.action === 'delete') await bot.deleteRole(guildId, payload.roleId, payload);
    else if (task.action === 'move') await bot.moveRole(guildId, payload.roleId, payload.direction, payload);
    else if (task.action === 'refresh') await pushRoles([guildId]);
    else throw new Error(`Unknown role action "${task.action}".`);
    await api('/api/bot/host/tasks', { method: 'POST', body: { id: task.id, ok: true } });
    await pushRoles([guildId]);
  } catch (error) {
    record('warn', `Role change failed: ${error.message}`);
    await api('/api/bot/host/tasks', {
      method: 'POST',
      body: { id: task.id, ok: false, error: error.message },
    }).catch(() => {});
  }
}

async function pollTasks() {
  if (!bot.getStatus().running) return;
  try {
    const data = await api('/api/bot/host/tasks');
    for (const task of data.tasks ?? []) await runRolesTask(task);
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      record('error', `Role task poll rejected: ${error.message}`);
    }
  }
}

async function poll() {
  try {
    const data = await api('/api/bot/host');
    if (networkWarned) {
      networkWarned = false;
      record('info', 'Reconnected to the Aegis server.');
    }
    if (ALWAYS_RUN && data.desired !== 'running') {
      if (!alwaysRunNoted) {
        alwaysRunNoted = true;
        record('info', 'Always-run mode: the dashboard stop command is ignored.');
      }
    } else if (ALWAYS_RUN) {
      alwaysRunNoted = false;
    }
    const next = ALWAYS_RUN || data.desired === 'running' ? 'running' : 'stopped';
    const changed = next !== desired;
    if (changed) await saveDesired(next);
    desired = next;
    if (desired === 'running') await startBot();
    else await stopBot();
    // A start or stop is worth an immediate report; the periodic one would
    // leave the dashboard showing the old state for up to five minutes.
    if (changed) await report();
    return true;
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      record('error', `Host token rejected: ${error.message}`);
    } else if (!networkWarned) {
      networkWarned = true;
      record('warn', `Cannot reach the Aegis server (${error.message}). Retrying…`);
    }
    return false;
  }
}

async function report() {
  const status = bot.getStatus();
  try {
    await api('/api/bot/host/status', {
      method: 'POST',
      body: {
        status: { ...status, lastError: status.lastError || runnerError },
        logs,
        nodeName: NODE_NAME,
        version: pkg.version,
      },
    });
    networkWarned = false;
  } catch (error) {
    if (!networkWarned) {
      networkWarned = true;
      record('warn', `Status report failed (${error.message}). Retrying…`);
    }
  }
  await flushCrashes().catch(() => {});
  if (status.running) await pushRoles().catch(() => {});
}

let pollTimer = null;
let reportTimer = null;
let taskTimer = null;
let closed = false;

async function shutdown(signal) {
  if (closed) return;
  closed = true;
  clearInterval(pollTimer);
  clearInterval(reportTimer);
  clearInterval(taskTimer);
  console.log(`\n${signal} received — stopping the bot…`);
  await bot.stop().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  record('error', `Unhandled error: ${error?.message ?? error}`);
});

// A fatal error must not leave a dead runner behind: record why, then let the
// BotManager bring the bot back up on its own.
process.on('uncaughtException', (error) => {
  record('error', `Uncaught exception: ${error?.message ?? error}`);
  bot.fatal('uncaught-exception', error).catch(() => {});
});

console.log(`Aegis host runner ${pkg.version}`);
console.log(`  server : ${SERVER}`);
console.log(`  machine: ${NODE_NAME}`);
console.log(`  data   : ${DATA_DIR}`);
console.log(`  control: ${ALWAYS_RUN ? 'always-run (dashboard stop is ignored)' : 'dashboard + saved local state'}`);
if (!DISCORD_TOKEN) {
  console.warn('  warning: DISCORD_TOKEN is not set, so the bot cannot be started from here.');
}

desired = await loadDesired();
// Mirror the state we are about to act on, so the file always explains what the
// runner will do after the next reboot.
await saveDesired(desired);
const reachable = await poll();
await report();
// The bot runs from this machine, not from the website: if the dashboard cannot
// be reached (paused site, no network), keep it up from the saved local state
// instead of waiting for the server to answer before it ever comes online.
if (!ALWAYS_RUN && !reachable && desired === 'running') {
  record('info', 'Dashboard unreachable — starting from the saved local state.');
  await startBot();
}
pollTimer = setInterval(poll, POLL_MS);
reportTimer = setInterval(report, REPORT_MS);
taskTimer = setInterval(pollTasks, TASK_MS);
