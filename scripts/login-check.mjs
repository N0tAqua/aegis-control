#!/usr/bin/env node
/**
 * Sign in against the Aegis server exactly the way the desktop app does, then
 * report what the server recorded if it fails.
 *
 *   npm run login-check
 *   npm run login-check -- --username aqua --api https://…-preview.freebuff.site
 *
 * Credentials come from AEGIS_LOGIN_USERNAME / AEGIS_LOGIN_PASSWORD or from the
 * prompt. The password is never printed, logged or sent anywhere except the
 * scrypt hash the app itself sends. On a server-side failure the diagnostic
 * record is fetched and printed, including the stack.
 */
import { scryptSync } from 'node:crypto';
import process from 'node:process';
import readline from 'node:readline/promises';
import { machineId } from '../electron/auth.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
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

async function call(path, { method = 'GET', body } = {}) {
  const headers = { 'x-aegis-hwid': hwid };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: response.status, data };
}

function tokenKind(token) {
  if (!token) return 'none';
  if (token.startsWith('AEGIS-SESSION.')) return 'signed stateless token (session tables unavailable)';
  if (token.startsWith('AEGIS-WEB-')) return 'web token (sessions table unavailable)';
  return 'session row';
}

const api = String(
  arg('api', process.env.AEGIS_API_URL || 'https://aegis-license-server-6z1s1v.freebuff.site'),
).replace(/\/+$/, '');
const hwid = machineId();
let username = process.env.AEGIS_LOGIN_USERNAME || arg('username');
let password = process.env.AEGIS_LOGIN_PASSWORD || '';

if (!username || !password) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!username) username = (await prompt.question('Username: ')).trim();
  prompt.close();
  if (!password) password = await askHidden('Password: ');
}
if (!username || !password) {
  console.error('Username and password are required.');
  process.exit(1);
}

console.log(`Server:   ${api}`);
console.log(`Username: ${username}`);
console.log(`Device:   ${hwid.slice(0, 12)}…`);

const salt = await call(`/api/auth/salt?username=${encodeURIComponent(username)}`);
if (salt.status !== 200 || !salt.data.salt) {
  console.error(`Could not read the password salt (${salt.status}):`, salt.data);
  process.exit(1);
}

const login = await call('/api/auth/login', {
  method: 'POST',
  body: {
    username,
    passwordHash: scryptSync(password, salt.data.salt, 64).toString('hex'),
    hwid,
  },
});

console.log(`Login:    ${login.status}`);

if (login.status === 200) {
  console.log(`Signed in as ${login.data.account?.username} (${login.data.account?.role}).`);
  console.log(`Session:  ${tokenKind(login.data.token)}`);
} else {
  console.log(`Error:    ${login.data.error ?? '(no message)'}`);
  console.log(`Stage:    ${login.data.stage ?? '(not a server failure)'}`);
  const link = String(login.data.error ?? '').match(/https:\/\/\S+/)?.[0];
  if (link) {
    console.log('\n--- server diagnostic ---');
    const detail = await fetch(link);
    console.log(`read: ${detail.status}`);
    console.log(await detail.text());
  } else if (login.data.traceId) {
    console.log(`Trace:    ${login.data.traceId}`);
  }
}

const health = await call('/api/health');
console.log('\nHealth:', JSON.stringify(health.data, null, 2));
