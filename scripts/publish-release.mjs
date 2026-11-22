#!/usr/bin/env node
/**
 * Publish a new Aegis Control build to your update server.
 *
 *   npm run dist
 *   npm run release -- --notes "Fixes force mute"
 *
 * Bump "version" in package.json first. The app only updates when the published
 * version is newer than the installed one. Credentials come from
 * AEGIS_OWNER_USERNAME / AEGIS_OWNER_PASSWORD or from a prompt.
 */
import { createHash, scryptSync } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { machineId } from '../electron/auth.js';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const api = String(arg('api', process.env.AEGIS_API_URL || ''))
  .trim()
  .replace(/\/+$/, '');
if (!api) {
  console.error('Set the server address: --api http://host:port, or AEGIS_API_URL.');
  process.exit(1);
}
const version = arg('version', pkg.version);
const notes = arg('notes', '');
const file = path.resolve(root, arg('file', 'dist/Aegis-Control.exe'));
const hwid = machineId();
const PART_SIZE = 8 * 1024 * 1024;

async function apiFetch(pathname, { method = 'GET', body, token, raw } = {}) {
  const headers = { 'x-aegis-hwid': hwid };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw) {
    headers['content-type'] = 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${api}${pathname}`, { method, headers, body: payload });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) throw new Error(data.error || `The server rejected the request (${response.status}).`);
  return data;
}

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    let value = '';
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(1);
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

if (!version.match(/^\d+\.\d+\.\d+$/)) {
  console.error(`Invalid version "${version}". Use something like 1.2.3.`);
  process.exit(1);
}

const info = await stat(file).catch(() => null);
if (!info?.isFile()) {
  console.error(`Build not found: ${file}\nRun "npm run dist" first.`);
  process.exit(1);
}

let username = process.env.AEGIS_OWNER_USERNAME || arg('username', '');
let password = process.env.AEGIS_OWNER_PASSWORD || '';
if (!username || !password) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!username) username = (await prompt.question('Owner username: ')).trim();
  prompt.close();
  if (!password) password = await askHidden('Owner password: ');
}
if (!username || !password) {
  console.error('Owner credentials are required.');
  process.exit(1);
}

console.log(`Server:  ${api}`);
console.log(`Version: ${version}`);
console.log(`File:    ${file} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);

const latest = await apiFetch('/api/releases/latest').catch(() => ({ release: null }));
if (latest.release && latest.release.version === version && !process.argv.includes('--force')) {
  console.error(
    `v${version} is already the latest release. Bump "version" in package.json so installed apps see a newer build (or pass --force).`,
  );
  process.exit(1);
}

const { salt } = await apiFetch(`/api/auth/salt?username=${encodeURIComponent(username)}`);
const login = await apiFetch('/api/auth/login', {
  method: 'POST',
  body: {
    username,
    passwordHash: scryptSync(password, salt, 64).toString('hex'),
    hwid,
  },
});
const token = login.token;
console.log(`Signed in as ${login.account.username} (${login.account.role}).`);

const sha256 = createHash('sha256');
for await (const chunk of createReadStream(file)) sha256.update(chunk);
const digest = sha256.digest('hex');

const parts = Math.ceil(info.size / PART_SIZE);
const created = await apiFetch('/api/releases', {
  method: 'POST',
  token,
  body: { version, notes, sha256: digest, size: info.size, parts },
});
console.log(`Uploading ${parts} part(s)…`);

const handle = await open(file, 'r');
try {
  for (let index = 0; index < parts; index += 1) {
    const length = Math.min(PART_SIZE, info.size - index * PART_SIZE);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, index * PART_SIZE);
    await apiFetch(`/api/releases/${created.id}/parts/${index}`, {
      method: 'PUT',
      token,
      raw: buffer,
    });
    const percent = Math.round(((index + 1) / parts) * 100);
    process.stdout.write(`\rUploaded ${percent}% (${index + 1}/${parts})`);
  }
} finally {
  await handle.close();
}
process.stdout.write('\n');

const finalized = await apiFetch(`/api/releases/${created.id}/finalize`, { method: 'POST', token });
console.log(`Published v${version}.`);
console.log(`Download: ${finalized.release.downloadUrl}`);
console.log('Installed copies will offer the update the next time Aegis starts.');
