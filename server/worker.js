/*
 * Aegis Control license + release API.
 * Runs on Freebuff Sites (Cloudflare Workers) with D1 (DB) and R2 (FILES).
 * No external dependencies: Web Crypto for hashing, D1 for data, R2 for release parts.
 */

const SCOPES = ['manageBot', 'manageRules', 'useConsole', 'viewLogs', 'manageKeys', 'manageRooms', 'linkConsole'];
const SESSION_MS = 1000 * 60 * 60 * 24 * 30;
const LOGIN_FLOW_PATHS = new Set(['/api/auth/login', '/api/auth/salt', '/api/auth/register', '/api/auth/verify']);
const WORKER_BUILD = '2026-11-22.9';
const SCHEMA_VERSION = '2026-11-22.6';
const MAX_PART_BYTES = 20 * 1024 * 1024;
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function bad(message, status = 400) {
  throw new HttpError(message, status);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-aegis-hwid',
  };
}

function randomHex(bytes = 32) {
  const array = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomGroup(length = 4) {
  const array = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(array, (byte) => KEY_ALPHABET[byte % KEY_ALPHABET.length]).join('');
}

function makeKey(prefix = 'AEGIS') {
  return `${prefix}-${randomGroup()}-${randomGroup()}-${randomGroup()}`;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createPkcePair() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return { verifier, challenge: base64UrlEncode(digest) };
}

function maskKey(value) {
  const key = String(value ?? '');
  if (!key) return null;
  return key.length <= 14 ? key : `${key.slice(0, 9)}…${key.slice(-4)}`;
}

function redirectResponse(location) {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store' },
  });
}

async function discordClientId(env) {
  return (
    String(env.DISCORD_CLIENT_ID ?? '').trim() ||
    (await getSetting(env, 'discord_client_id')) ||
    (await getSetting(env, 'bot_application_id')) ||
    ''
  );
}

/**
 * Discord only accepts a redirect URL that is registered verbatim in the
 * Developer Portal, so the owner may pin one from the dashboard. The value is
 * never rewritten: a registered ".../callback/" must stay exactly that.
 */
async function discordRedirectUri(env, url) {
  const fromEnv = String(env.DISCORD_REDIRECT_URI ?? '').trim();
  if (fromEnv) return fromEnv;
  const stored = String((await getSetting(env, 'discord_redirect_uri')) ?? '').trim();
  if (stored) return stored;
  return `${url.origin}/api/auth/discord/callback`;
}

function discordDisplayName(user) {
  return String(user.global_name || user.username || 'Discord user').slice(0, 80);
}

async function issueWebToken(env, accountId, label = 'Dashboard') {
  const token = `AEGIS-WEB-${randomHex(24)}`;
  await env.DB.prepare(
    `INSERT INTO web_tokens (id, token_hash, account_id, label, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(randomHex(10), await sha256Hex(token), accountId, label.slice(0, 60), Date.now())
    .run();
  return token;
}

async function accountWithKey(env, account, trace = null) {
  let key = null;
  try {
    if (account.keyId) {
      const row = await env.DB.prepare(`SELECT key, label FROM keys WHERE id = ?`).bind(account.keyId).first();
      if (row) key = { label: row.label ?? '', masked: maskKey(row.key) };
    }
  } catch (error) {
    console.warn('key summary unavailable', error?.message || error);
    trace?.steps.push({ step: 'key-summary', ok: false, error: String(error?.message || error) });
  }
  return { ...account, key };
}

async function createDiscordAuth(env, url, { mode, accountId = null, clientIdOverride = null } = {}) {
  const configured = String(await discordClientId(env)).trim();
  const supplied = String(clientIdOverride || '').trim();
  // The desktop app sends the bot's application ID. If that is a different app
  // than the configured OAuth client, Discord answers "invalid oauth2
  // redirect_uri" because the redirect is only registered on the OAuth app, so
  // a configured client ID always wins.
  const clientId = /^\d{17,20}$/.test(configured) ? configured : supplied;
  if (!/^\d{17,20}$/.test(clientId)) {
    bad(
      'Discord sign-in is not configured yet. Add DISCORD_CLIENT_ID to the site, or start the bot once so Aegis can detect the application ID.',
      409,
    );
  }
  const redirectUri = await discordRedirectUri(env, url);
  const { verifier, challenge } = await createPkcePair();
  const state = randomHex(24);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO oauth_states (state, mode, verifier, account_id, client_id, redirect_uri, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(state, mode, verifier, accountId, clientId, redirectUri, now, now + 10 * 60_000)
    .run();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'identify',
    state,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return {
    state,
    clientId,
    redirectUri,
    clientIdIgnored: Boolean(supplied && supplied !== clientId),
    expiresAt: now + 10 * 60_000,
    url: `https://discord.com/oauth2/authorize?${params.toString()}`,
  };
}

async function handleDiscordCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const stateId = url.searchParams.get('state');
  const origin = url.origin;
  const row = stateId
    ? await env.DB.prepare(`SELECT * FROM oauth_states WHERE state = ?`).bind(stateId).first()
    : null;

  const fail = async (message, codeKey = 'error') => {
    if (row) {
      if (row.mode === 'desktop') {
        await env.DB.prepare(`UPDATE oauth_states SET error = ? WHERE state = ?`)
          .bind(String(message).slice(0, 300), stateId)
          .run()
          .catch(() => {});
        return redirectResponse(`${origin}/link?error=1`);
      }
      await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`)
        .bind(stateId)
        .run()
        .catch(() => {});
    }
    return redirectResponse(`${origin}/?discord=${codeKey}&message=${encodeURIComponent(message)}`);
  };

  if (!row) return redirectResponse(`${origin}/?discord=expired`);
  if (Number(row.expires_at) < Date.now()) {
    await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(stateId).run().catch(() => {});
    return redirectResponse(`${origin}/?discord=expired`);
  }
  if (url.searchParams.get('error') || !code) return fail('Discord sign-in was cancelled.', 'denied');

  try {
    const form = new URLSearchParams({
      client_id: row.client_id,
      grant_type: 'authorization_code',
      code,
      redirect_uri: row.redirect_uri,
      code_verifier: row.verifier,
    });
    const secret = String(env.DISCORD_CLIENT_SECRET ?? '').trim();
    if (secret) form.set('client_secret', secret);

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => '');
      console.error('discord token exchange failed', tokenResponse.status, detail.slice(0, 400));
      return fail('Discord rejected the sign-in. Check that the redirect URL is registered in the Developer Portal.', 'error');
    }
    const tokenData = await tokenResponse.json();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userResponse.ok) return fail('Discord did not return your profile.', 'error');
    const user = await userResponse.json();
    if (!user?.id) return fail('Discord did not return your profile.', 'error');

    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : null;

    let accountRow = null;
    if (row.account_id) {
      accountRow = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(row.account_id).first();
      if (!accountRow) return fail('That account no longer exists.', 'error');
      if (accountRow.discord_id && accountRow.discord_id !== user.id) {
        return fail('This account is already linked to a different Discord user.', 'taken');
      }
    }

    const linked = await env.DB.prepare(`SELECT * FROM accounts WHERE discord_id = ?`).bind(user.id).first();
    if (linked && accountRow && linked.id !== accountRow.id) {
      return fail('That Discord account is already linked to another Aegis account.', 'taken');
    }
    if (!accountRow) accountRow = linked;

    if (!accountRow) {
      return fail(
        'No Aegis account is linked to that Discord yet. Log in normally with your username and password, then choose "Link Discord" in the app or dashboard.',
        'not-linked',
      );
    }

    if (accountRow.key_id) {
      const keyRow = await env.DB.prepare(`SELECT discord_id FROM keys WHERE id = ?`).bind(accountRow.key_id).first();
      if (keyRow?.discord_id && keyRow.discord_id !== user.id) {
        return fail('This account\'s licence key is assigned to a different Discord account.', 'wrong-discord');
      }
    }

    await env.DB.prepare(
      `UPDATE accounts SET discord_id = ?, discord_username = ?, discord_avatar = ?, discord_linked_at = ? WHERE id = ?`,
    )
      .bind(user.id, discordDisplayName(user), avatar, Date.now(), accountRow.id)
      .run();
    accountRow = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountRow.id).first();

    const account = accountFromRow(accountRow);
    if (account.role === 'owner' && /^\d{17,20}$/.test(String(row.client_id))) {
      const existing = await getSetting(env, 'discord_client_id');
      if (!existing) await setSetting(env, 'discord_client_id', String(row.client_id));
    }

    if (row.mode === 'desktop') {
      const token = await createAnySession(env, account, '');
      await env.DB.prepare(`UPDATE oauth_states SET account_id = ?, token = ? WHERE state = ?`)
        .bind(account.id, token, stateId)
        .run();
      return redirectResponse(`${origin}/link?code=${encodeURIComponent(stateId)}`);
    }

    const token = await issueWebToken(env, account.id, row.mode === 'link' ? 'Discord link' : 'Discord sign-in');
    await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(stateId).run().catch(() => {});
    return redirectResponse(`${origin}/#token=${token}`);
  } catch (error) {
    console.error('discord callback error', error?.message || error);
    return fail(error instanceof HttpError ? error.message : 'Discord sign-in failed. Try again.', 'error');
  }
}

function safeScopes(value) {
  if (!Array.isArray(value)) return [];
  return SCOPES.filter((scope) => value.includes(scope));
}

function parseScopes(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((scope) => SCOPES.includes(scope)) : [];
  } catch {
    return [];
  }
}

function accountFromRow(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    scopes: row.role === 'owner' ? [...SCOPES] : parseScopes(row.scopes),
    keyId: row.key_id ?? null,
    publicId: row.public_id ?? null,
    createdAt: row.created_at ?? null,
    discordId: row.discord_id ?? null,
    discordUsername: row.discord_username ?? null,
    discordAvatar: row.discord_avatar ?? null,
    discordLinkedAt: row.discord_linked_at ?? null,
  };
}

function makePublicId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

async function uniquePublicId(env) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = makePublicId();
    const exists = await env.DB.prepare(`SELECT id FROM accounts WHERE public_id = ?`)
      .bind(candidate)
      .first();
    if (!exists) return candidate;
  }
  return `${makePublicId()}${makePublicId()}`.slice(0, 10);
}

async function ensurePublicIds(env) {
  const rows = await env.DB.prepare(
    `SELECT id FROM accounts WHERE public_id IS NULL OR public_id = ''`,
  ).all();
  for (const row of rows.results ?? []) {
    const publicId = await uniquePublicId(env);
    await env.DB.prepare(`UPDATE accounts SET public_id = ? WHERE id = ?`)
      .bind(publicId, row.id)
      .run();
  }
}

function normalisePublicId(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^#/, '')
    .replace(/^AEG-/i, '')
    .toUpperCase();
}

async function accountByPublicId(env, raw) {
  const publicId = normalisePublicId(raw);
  if (!/^[A-Z0-9]{6,10}$/.test(publicId)) return null;
  return env.DB.prepare(`SELECT * FROM accounts WHERE public_id = ?`).bind(publicId).first();
}

function publicAccount(row) {
  return {
    accountId: row.id,
    username: row.username,
    publicId: row.public_id ?? null,
  };
}

function keyFromRow(row) {
  return {
    id: row.id,
    key: row.key,
    label: row.label ?? '',
    role: row.role,
    scopes: row.role === 'owner' ? [...SCOPES] : parseScopes(row.scopes),
    disabled: Boolean(row.disabled),
    hwid: row.hwid ?? null,
    discordId: row.discord_id ?? null,
    usedBy: row.used_by_name ?? row.used_by ?? null,
    bound: Boolean(row.hwid),
    boundMachine: row.hwid ? String(row.hwid).slice(0, 12) : null,
    createdAt: row.created_at ?? null,
  };
}

function isOwner(account) {
  return account.role === 'owner';
}

function hasScope(account, scope) {
  return isOwner(account) || account.scopes.includes(scope);
}

function requireScope(account, scope) {
  if (!hasScope(account, scope)) bad('Your panel account does not have permission to do that.', 403);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    bad('Invalid JSON body.');
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_diagnostics (
    id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    username TEXT,
    error_name TEXT,
    error_message TEXT,
    error_stack TEXT,
    context TEXT,
    cap_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_diagnostics_created ON login_diagnostics (created_at)`,
  `CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    label TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    scopes TEXT NOT NULL DEFAULT '[]',
    disabled INTEGER NOT NULL DEFAULT 0,
    hwid TEXT,
    used_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_lower TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    scopes TEXT NOT NULL DEFAULT '[]',
    key_id TEXT,
    hwid TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    hwid TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,
    host_account_id TEXT NOT NULL,
    state TEXT,
    updated_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_members_account ON room_members (account_id)`,
  `CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL,
    addressee_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_pair ON friendships (requester_id, addressee_id)`,
  `CREATE TABLE IF NOT EXISTS room_invites (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    invited_account_id TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_invites_account ON room_invites (invited_account_id, status)`,
  `CREATE TABLE IF NOT EXISTS room_join_requests (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_requests_account ON room_join_requests (account_id, status)`,
  `CREATE TABLE IF NOT EXISTS room_actions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_actions_pending ON room_actions (room_id, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS shared_console (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    host_account_id TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    notes TEXT,
    sha256 TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    parts INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    published_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS release_parts (
    release_id TEXT NOT NULL,
    part INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (release_id, part)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_releases_published ON releases (published, published_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id)`,
  `CREATE TABLE IF NOT EXISTS web_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT UNIQUE NOT NULL,
    account_id TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_web_tokens_account ON web_tokens (account_id)`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    verifier TEXT NOT NULL,
    account_id TEXT,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    token TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
];

let schemaPromise = null;

async function applySchema(env) {
      for (const statement of SCHEMA) {
        await env.DB.prepare(statement).run();
      }
      const columns = [
        ['accounts', 'public_id', 'TEXT'],
        ['accounts', 'scopes', "TEXT NOT NULL DEFAULT '[]'"],
        ['accounts', 'hwid', 'TEXT'],
        ['accounts', 'last_login_at', 'INTEGER'],
        ['accounts', 'discord_id', 'TEXT'],
        ['accounts', 'discord_username', 'TEXT'],
        ['accounts', 'discord_avatar', 'TEXT'],
        ['accounts', 'discord_linked_at', 'INTEGER'],
        ['keys', 'label', 'TEXT'],
        ['keys', 'hwid', 'TEXT'],
        ['keys', 'used_by', 'TEXT'],
        ['keys', 'disabled', 'INTEGER NOT NULL DEFAULT 0'],
        ['keys', 'discord_id', 'TEXT'],
        ['sessions', 'hwid', 'TEXT'],
        ['sessions', 'created_at', 'INTEGER'],
        ['sessions', 'expires_at', 'INTEGER'],
        ['web_tokens', 'label', 'TEXT'],
        ['web_tokens', 'created_at', 'INTEGER'],
        ['web_tokens', 'last_used_at', 'INTEGER'],
        ['oauth_states', 'account_id', 'TEXT'],
        ['oauth_states', 'token', 'TEXT'],
        ['oauth_states', 'error', 'TEXT'],
      ];
      for (const [table, column, type] of columns) {
        try {
          await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
        } catch {
          // Column already exists.
        }
      }
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_accounts_discord ON accounts (discord_id)`).run().catch(() => {});
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_keys_discord ON keys (discord_id)`).run().catch(() => {});
      await env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
        .bind(SCHEMA_VERSION)
        .run();
}

/**
 * Schema work used to run on every cold isolate, so every burst of traffic
 * fired a batch of DDL statements at D1. That is the kind of contention that
 * surfaces as an occasional 500 far from the statement that lost the race, so
 * the DDL now runs only when the stored schema version is stale.
 */
function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      let version = null;
      try {
        version = (await env.DB.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first())?.value ?? null;
      } catch {
        version = null; // Fresh database: the settings table does not exist yet.
      }
      if (version !== SCHEMA_VERSION) await applySchema(env);
      await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)`)
        .bind(randomHex(32))
        .run()
        .catch(() => {});
      await env.DB.prepare(`DELETE FROM oauth_states WHERE expires_at < ?`).bind(Date.now() - 3_600_000).run().catch(() => {});
      await ensurePublicIds(env);
      await ensureOwnerKey(env);
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function ensureOwnerKey(env) {
  let row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'owner_key'`).first();
  if (!row?.value) {
    const candidate = makeKey('AEGIS-OWNER');
    await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('owner_key', ?)`).bind(candidate).run();
    row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'owner_key'`).first();
  }
  const key = row.value;
  const existing = await env.DB.prepare(`SELECT id FROM keys WHERE key = ?`).bind(key).first();
  if (!existing) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO keys (id, key, label, role, scopes, disabled, created_at) VALUES (?, ?, 'Owner key', 'owner', ?, 0, ?)`,
    )
      .bind(randomHex(12), key, JSON.stringify(SCOPES), Date.now())
      .run();
  }
  return key;
}

async function accountCount(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM accounts`).first();
  return Number(row?.count ?? 0);
}

function requestHwid(request) {
  return String(request.headers.get('x-aegis-hwid') ?? '').trim();
}

async function authenticate(env, request) {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  if (token.startsWith('AEGIS-SESSION.')) {
    const account = await accountFromStatelessToken(env, token);
    return account ? { account, tokenHash: null } : null;
  }
  const hwid = requestHwid(request);
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.expires_at, s.hwid AS session_hwid, a.*
     FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first();
  if (!row) {
    // Dashboard tokens work from any browser, so the website can control the bot.
    const web = await env.DB.prepare(
      `SELECT w.id AS web_id, a.* FROM web_tokens w JOIN accounts a ON a.id = w.account_id
       WHERE w.token_hash = ?`,
    )
      .bind(tokenHash)
      .first();
    if (!web) return null;
    await env.DB.prepare(`UPDATE web_tokens SET last_used_at = ? WHERE id = ?`)
      .bind(Date.now(), web.web_id)
      .run()
      .catch(() => {});
    return { account: accountFromRow(web), tokenHash: null, webTokenId: web.web_id };
  }
  if (Number(row.expires_at) < Date.now()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
    return null;
  }
  if (row.session_hwid && hwid && row.session_hwid !== hwid) return null;
  return { account: accountFromRow(row), tokenHash };
}

function requireAuth(state) {
  if (!state) bad('Sign in to Aegis Control first.', 401);
  return state.account;
}

async function createSession(env, account, hwid) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, account_id, hwid, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(tokenHash, account.id, hwid, Date.now(), Date.now() + SESSION_MS)
    .run();
  return token;
}

async function sessionSecretKey(env) {
  let secret = String(env.SESSION_SECRET || env.ADMIN_TOKEN || '').trim();
  if (!secret) secret = await getSetting(env, 'session_secret');
  if (!secret) {
    secret = randomHex(32);
    await setSetting(env, 'session_secret', secret);
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function createStatelessSession(env, account) {
  const expires = Date.now() + SESSION_MS;
  const payload = `${account.id}.${expires}`;
  const key = await sessionSecretKey(env);
  const signature = base64UrlEncode(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `AEGIS-SESSION.${payload}.${signature}`;
}

async function accountFromStatelessToken(env, token) {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [, accountId, expires, signature] = parts;
  if (!accountId || !expires || !signature) return null;
  if (Number(expires) < Date.now()) return null;
  const key = await sessionSecretKey(env);
  const expected = base64UrlEncode(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${accountId}.${expires}`)),
  );
  if (signature !== expected) return null;
  const row = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first();
  return row ? accountFromRow(row) : null;
}

async function createAnySession(env, account, hwid, trace = null) {
  try {
    const token = await createSession(env, account, hwid);
    trace?.steps.push({ step: 'sessions', ok: true });
    return token;
  } catch (error) {
    console.warn('session insert failed, trying web token', error?.message || error);
    trace?.steps.push({ step: 'sessions', ok: false, error: String(error?.message || error) });
  }
  try {
    const token = await issueWebToken(env, account.id, hwid ? 'Desktop session' : 'Discord session');
    trace?.steps.push({ step: 'web_tokens', ok: true });
    return token;
  } catch (error) {
    console.warn('web token insert failed, using signed token', error?.message || error);
    trace?.steps.push({ step: 'web_tokens', ok: false, error: String(error?.message || error) });
  }
  try {
    const token = await createStatelessSession(env, account);
    trace?.steps.push({ step: 'stateless', ok: true });
    return token;
  } catch (error) {
    trace?.steps.push({ step: 'stateless', ok: false, error: String(error?.message || error) });
    throw error;
  }
}

async function revokeAccountSessions(env, accountId) {
  await env.DB.prepare(`DELETE FROM sessions WHERE account_id = ?`).bind(accountId).run();
}

async function handleSetup(request, env) {
  const count = await accountCount(env);
  if (count > 0) {
    return json({ service: 'aegis', firstRun: false, accounts: count, discordSupported: true });
  }

  const ownerKey = await ensureOwnerKey(env);
  const hwid = requestHwid(request);
  let binding = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'setup_hwid'`).first();
  if (!binding?.value && hwid) {
    await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('setup_hwid', ?)`).bind(hwid).run();
    binding = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'setup_hwid'`).first();
  }
  const claimed = Boolean(binding?.value);
  const mine = Boolean(hwid) && binding?.value === hwid;

  return json({
    service: 'aegis',
    firstRun: true,
    ownerKey: mine ? ownerKey : undefined,
    claimed,
    accounts: 0,
    discordSupported: true,
  });
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function roomSummary(row, account, joined) {
  const isHost = row.host_account_id === account.id;
  return {
    id: row.id,
    name: row.name,
    host: row.host_name ?? null,
    hostId: row.host_account_id,
    hostPublicId: row.host_public_id ?? null,
    isHost,
    joined: Boolean(joined),
    memberCount: Number(row.member_count ?? 0),
    code: isHost ? row.code : undefined,
    updatedAt: row.updated_at ?? null,
    createdAt: row.created_at,
  };
}

const ROOM_SELECT = `SELECT r.*, a.username AS host_name, a.public_id AS host_public_id,
  (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count
  FROM rooms r LEFT JOIN accounts a ON a.id = r.host_account_id`;

const ROOM_ACTION_TYPES = new Set([
  'start',
  'stop',
  'deploy',
  'guild',
  'member',
  'memberAdd',
  'memberRemove',
  'allowAdd',
  'allowRemove',
  'console',
  'addAllMembers',
]);

async function roomMembers(env, roomId, hostId) {
  const rows = await env.DB.prepare(
    `SELECT rm.account_id, rm.joined_at, a.username, a.public_id
     FROM room_members rm JOIN accounts a ON a.id = rm.account_id
     WHERE rm.room_id = ? ORDER BY rm.joined_at ASC`,
  )
    .bind(roomId)
    .all();
  return (rows.results ?? []).map((row) => ({
    accountId: row.account_id,
    username: row.username,
    publicId: row.public_id ?? null,
    isHost: row.account_id === hostId,
    joinedAt: row.joined_at,
  }));
}

async function getSetting(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first();
  return row?.value ?? null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, String(value))
    .run();
}

// The host runner reports every five minutes so the site stays inside its
// request allowance, so host presence has to be judged over a longer window.
const NODE_ONLINE_MS = 420_000;

/** The bot itself runs on a host runner; here we only keep its last report. */
async function readBotState(env) {
  const [desired, seenRaw, storedRaw, configuredRaw] = await Promise.all([
    getSetting(env, 'bot_desired'),
    getSetting(env, 'bot_host_seen'),
    getSetting(env, 'bot_state'),
    getSetting(env, 'bot_host_hash'),
  ]);

  let stored = null;
  try {
    stored = storedRaw ? JSON.parse(storedRaw) : null;
  } catch {
    stored = null;
  }

  // Crash stacks are owner-only: they live in their own setting and must not
  // ride along in the status snapshot every signed-in account can read.
  const status = stored?.status && typeof stored.status === 'object' ? { ...stored.status } : null;
  if (status) delete status.crashes;

  const lastSeen = Number(seenRaw ?? 0) || null;
  return {
    desired: desired === 'running' ? 'running' : 'stopped',
    host: {
      configured: Boolean(configuredRaw),
      online: Boolean(lastSeen) && Date.now() - Number(lastSeen) < NODE_ONLINE_MS,
      lastSeen,
      name: stored?.nodeName || null,
      version: stored?.version || null,
    },
    status,
    logs: Array.isArray(stored?.logs) ? stored.logs : [],
    updatedAt: stored?.reportedAt ?? null,
  };
}

/* ------------------------------------------------------- crash reports ---
 * The host runner is configured to restart the bot by itself after a crash.
 * Every crash it or the desktop app records is stored here as well, in an
 * owner-only list, so the reason survives a restart of the machine. */

const MAX_CRASHES = 40;
const CRASH_STACK_LIMIT = 4000;

function normaliseCrash(entry, meta = {}) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const text = (value, limit) => String(value ?? '').slice(0, limit);
  return {
    id: text(source.id || randomHex(8), 32),
    at: Number(source.at) || Date.now(),
    reason: text(source.reason || 'crashed', 60),
    name: text(source.name || 'Error', 80),
    message: text(source.message || 'Unknown error', 600),
    code: source.code === undefined || source.code === null ? null : text(source.code, 40),
    stack: text(source.stack || '', CRASH_STACK_LIMIT),
    detail: source.detail ? text(source.detail, 400) : null,
    uptimeMs: Number(source.uptimeMs) || 0,
    restarts: Number(source.restarts) || 0,
    repeats: Number(source.repeats) || 0,
    node: text(source.node || meta.node || '', 60),
    version: text(source.version || meta.version || '', 24),
  };
}

async function readCrashes(env) {
  try {
    const raw = await getSetting(env, 'bot_crashes');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map((entry) => normaliseCrash(entry)) : [];
  } catch {
    return [];
  }
}

async function appendCrashes(env, entries, meta = {}) {
  const incoming = (Array.isArray(entries) ? entries : [entries])
    .filter(Boolean)
    .slice(0, 20)
    .map((entry) => normaliseCrash(entry, meta));
  if (!incoming.length) return readCrashes(env);
  const existing = await readCrashes(env);
  const seen = new Set(existing.map((entry) => entry.id));
  const merged = [...incoming.filter((entry) => !seen.has(entry.id)), ...existing]
    .sort((left, right) => right.at - left.at)
    .slice(0, MAX_CRASHES);
  await setSetting(env, 'bot_crashes', JSON.stringify(merged));
  return merged;
}

function requestHostToken(request) {
  return String(request.headers.get('x-aegis-host') ?? '').trim();
}

async function requireHost(env, request) {
  const provided = requestHostToken(request);
  if (!provided) bad('Missing host runner token.', 401);
  const stored = await getSetting(env, 'bot_host_hash');
  if (!stored) bad('No host runner token has been created yet.', 403);
  if ((await sha256Hex(provided)) !== stored) bad('Invalid host runner token.', 401);
}

async function requirePublisher(request, env) {
  const state = await authenticate(env, request);
  const account = requireAuth(state);
  if (!isOwner(account)) bad('Only the owner can publish updates.', 403);
  return { admin: false, account };
}

function downloadPage(release) {
  const version = release ? `v${release.version}` : '';
  const size = release ? `${(release.size / 1024 / 1024).toFixed(1)} MB` : '';
  const body = release
    ? `<div class="version">${version} &middot; ${size} &middot; Windows x64</div>
       <a class="btn" href="/api/download/latest" download>Download Aegis Control</a>
       <p class="hint">Portable .exe &mdash; no installer. Windows may warn about an unsigned app:<br />choose <b>More info &rarr; Run anyway</b>.</p>`
    : `<p class="hint">No build has been published yet. The owner can publish one from the panel.</p>`;

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Download Aegis Control</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:radial-gradient(1200px 600px at 50% -10%, #12213f, #070b16 60%); color:#e6ecff; font-family:"Segoe UI", system-ui, sans-serif; }
  .card { width:min(460px, calc(100% - 40px)); padding:34px; border:1px solid #1d2a4a; border-radius:20px; background:linear-gradient(160deg,#0d1528,#0a0f1e); box-shadow:0 30px 80px rgba(0,0,0,.5); text-align:center; }
  .mark { width:52px; height:52px; margin:0 auto 16px; border-radius:15px; background:linear-gradient(160deg,#1c3f7d,#0e1c36); display:grid; place-items:center; color:#8fb8ff; font-size:24px; font-weight:700; }
  h1 { margin:0 0 6px; font-size:23px; letter-spacing:-.02em; }
  .sub { margin:0 0 22px; color:#93a4c9; font-size:13.5px; }
  .version { margin:0 0 18px; color:#8fb8ff; font-size:13px; }
  .btn { display:block; padding:13px 18px; border-radius:11px; background:linear-gradient(180deg,#3b82f6,#2563eb); color:#fff; text-decoration:none; font-weight:600; font-size:14.5px; }
  .btn:hover { filter:brightness(1.08); }
  .hint { margin:16px 0 0; color:#93a4c9; font-size:12.5px; line-height:1.6; }
  .meta { margin:22px 0 0; padding-top:16px; border-top:1px solid #16223c; color:#5f7096; font-size:11.5px; }
  .meta a { color:#6f8dc7; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">A</div>
    <h1>Aegis Control</h1>
    <p class="sub">Windows dashboard for the Aegis Discord bot</p>
    ${body}
    <p class="meta">Served by your Aegis server &middot; <a href="/">status</a></p>
  </main>
</body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

async function handleRegister(request, env) {
  const body = await readBody(request);
  const username = String(body.username ?? '').trim();
  const passwordHash = String(body.passwordHash ?? '').trim().toLowerCase();
  const salt = String(body.salt ?? '').trim();
  const licenseKey = String(body.key ?? '').trim().toUpperCase();
  const hwid = String(body.hwid ?? '').trim();

  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) bad('Username must be 3-24 letters, numbers or underscores.');
  if (!/^[a-f0-9]{128}$/.test(passwordHash)) bad('Missing password hash.');
  if (!/^[A-Za-z0-9+/=]{16,64}$/.test(salt)) bad('Missing password salt.');
  if (!hwid) bad('Missing device ID.');
  if (!licenseKey) bad('Enter a licence key.');

  const count = await accountCount(env);
  if (count === 0) {
    const ownerKey = await ensureOwnerKey(env);
    if (licenseKey !== ownerKey) bad('The first account must use the owner key from the panel.');
  }

  const keyRow = await env.DB.prepare(`SELECT * FROM keys WHERE key = ?`).bind(licenseKey).first();
  if (!keyRow) bad('That licence key was not found.', 404);
  if (Number(keyRow.disabled)) bad('That licence key has been disabled.', 403);
  if (keyRow.used_by) bad('That licence key has already been used. Ask the owner for a new one.', 409);

  const existing = await env.DB.prepare(`SELECT id FROM accounts WHERE username_lower = ?`).bind(username.toLowerCase()).first();
  if (existing) bad('That username is already taken.', 409);

  const accountId = randomHex(12);
  const publicId = await uniquePublicId(env);
  const scopes = keyRow.role === 'owner' ? [...SCOPES] : parseScopes(keyRow.scopes);
  const now = Date.now();

  // Claim the single-use key atomically before creating the account.
  const claim = await env.DB.prepare(
    `UPDATE keys SET used_by = ?, hwid = ? WHERE id = ? AND used_by IS NULL`,
  )
    .bind(accountId, hwid, keyRow.id)
    .run();
  if (!claim.meta?.changes) {
    bad('That licence key has already been used. Ask the owner for a new one.', 409);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO accounts (id, username, username_lower, password_hash, salt, role, scopes, key_id, hwid, public_id, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(accountId, username, username.toLowerCase(), passwordHash, salt, keyRow.role, JSON.stringify(scopes), keyRow.id, hwid, publicId, now, now)
      .run();
  } catch (error) {
    await env.DB.prepare(`UPDATE keys SET used_by = NULL WHERE id = ? AND used_by = ?`)
      .bind(keyRow.id, accountId)
      .run();
    throw error;
  }

  const account = accountFromRow({
    id: accountId,
    username,
    role: keyRow.role,
    scopes: JSON.stringify(scopes),
    key_id: keyRow.id,
    public_id: publicId,
    created_at: now,
  });
  const token = await createAnySession(env, account, hwid);
  return json({ token, account: await accountWithKey(env, account), discordSupported: true });
}

/* ------------------------------------------------- login diagnostics ---
 * A login that breaks after the password check used to surface as an opaque
 * error. Every unhandled login failure is now stored in full - the exact
 * stage, error name, message, stack and D1 fallback steps - and can be read
 * back only with the one-time capability given to the client that caused it,
 * or by the owner account. */

const DIAGNOSTIC_READ_MS = 1000 * 60 * 60 * 24;
const DIAGNOSTIC_KEEP_MS = 1000 * 60 * 60 * 24 * 14;

function timingSafeEqual(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (!a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function errorFacts(error) {
  if (!error) return { name: 'UnknownError', message: 'Nothing was thrown.', stack: '', cause: null };
  const cause = error.cause
    ? error.cause instanceof Error
      ? `${error.cause.name}: ${error.cause.message}`
      : String(error.cause)
    : null;
  return {
    name: String(error.name || 'Error'),
    message: String(error.message ?? error),
    stack: String(error.stack || ''),
    cause,
  };
}

function diagnosticsUrl(url, id, capability) {
  return `${url.origin}/api/diagnostics/login/${id}?key=${capability}`;
}

async function recordLoginDiagnostic(env, { stage, username, error, context }) {
  const id = randomHex(8);
  const capability = randomHex(24);
  const facts = errorFacts(error);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO login_diagnostics (id, stage, username, error_name, error_message, error_stack, context, cap_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        stage,
        username ? String(username).slice(0, 64) : null,
        facts.name,
        facts.message,
        facts.stack,
        JSON.stringify({ ...(context ?? {}), cause: facts.cause }),
        await sha256Hex(capability),
        now,
        now + DIAGNOSTIC_READ_MS,
      )
      .run();
    await env.DB.prepare(`DELETE FROM login_diagnostics WHERE created_at < ?`)
      .bind(now - DIAGNOSTIC_KEEP_MS)
      .run()
      .catch(() => {});
    return { id, capability };
  } catch (error) {
    console.error('login diagnostic could not be stored', error?.stack || error);
    return { id: null, capability: null };
  }
}

/** A single lost D1 round trip must not become a failed sign-in. */
async function withRetry(operation, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }
  throw lastError;
}

async function handleLogin(request, env, url) {
  const trace = { stage: 'start', username: null, steps: [] };
  try {
    return await loginAccount(request, env, trace);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error('login failed', error?.stack || error);
    const facts = errorFacts(error);
    const recorded = await recordLoginDiagnostic(env, {
      stage: trace.stage,
      username: trace.username,
      error,
      context: { build: WORKER_BUILD, steps: trace.steps },
    });
    await setSetting(
      env,
      'last_login_failure',
      JSON.stringify({
        at: Date.now(),
        stage: trace.stage,
        name: facts.name,
        traceId: recorded.id,
      }),
    ).catch(() => {});
    const link = recorded.id ? diagnosticsUrl(url, recorded.id, recorded.capability) : null;
    return json(
      {
        error: link
          ? `Login failed on the server at stage "${trace.stage}" (${facts.name}: ${facts.message}). Diagnostic link: ${link}`
          : `Login failed on the server at stage "${trace.stage}" (${facts.name}: ${facts.message}).`,
        stage: trace.stage,
        traceId: recorded.id,
        traceKey: recorded.capability,
      },
      503,
    );
  }
}

async function loginAccount(request, env, trace) {
  trace.stage = 'read-body';
  const body = await readBody(request);
  const username = String(body.username ?? '').trim();
  const passwordHash = String(body.passwordHash ?? '').trim().toLowerCase();
  const hwid = String(body.hwid ?? '').trim();
  trace.username = username || null;
  if (!username || !/^[a-f0-9]{128}$/.test(passwordHash)) bad('Enter your username and password.');
  if (!hwid) bad('Missing device ID.');

  trace.stage = 'account-lookup';
  const row = await withRetry(() =>
    env.DB.prepare(`SELECT * FROM accounts WHERE username_lower = ?`).bind(username.toLowerCase()).first(),
  );
  if (!row) bad('Wrong username or password.', 401);

  trace.stage = 'password-check';
  if (passwordHash !== row.password_hash) bad('Wrong username or password.', 401);
  if (row.hwid && row.hwid !== hwid) bad('This account is locked to another device. Ask the owner to reset its device.', 403);

  trace.stage = 'device-bind';
  if (!row.hwid) {
    try {
      await env.DB.prepare(`UPDATE accounts SET hwid = ? WHERE id = ?`).bind(hwid, row.id).run();
      if (row.key_id) {
        await env.DB.prepare(`UPDATE keys SET hwid = ? WHERE id = ?`).bind(hwid, row.key_id).run();
      }
      row.hwid = hwid;
      trace.steps.push({ step: 'device-bind', ok: true });
    } catch (error) {
      console.warn('device bind failed', error?.message || error);
      trace.steps.push({ step: 'device-bind', ok: false, error: String(error?.message || error) });
    }
  }

  trace.stage = 'last-login';
  await env.DB.prepare(`UPDATE accounts SET last_login_at = ? WHERE id = ?`)
    .bind(Date.now(), row.id)
    .run()
    .catch((error) => {
      trace.steps.push({ step: 'last-login', ok: false, error: String(error?.message || error) });
    });
  const account = accountFromRow(row);

  trace.stage = 'session';
  const token = await createAnySession(env, account, hwid, trace);

  trace.stage = 'key-summary';
  const withKey = await accountWithKey(env, account, trace);

  trace.stage = 'response';
  return json({ token, account: withKey, discordSupported: true });
}

async function storageShape(env) {
  const checks = {
    settings: 'SELECT key, value FROM settings LIMIT 1',
    accounts:
      'SELECT id, username_lower, password_hash, salt, role, scopes, key_id, hwid, public_id, created_at, last_login_at, discord_id FROM accounts LIMIT 1',
    keys: 'SELECT id, key, label, role, scopes, disabled, hwid, used_by, created_at, discord_id FROM keys LIMIT 1',
    sessions: 'SELECT token_hash, account_id, hwid, created_at, expires_at FROM sessions LIMIT 1',
    web_tokens: 'SELECT id, token_hash, account_id, label, created_at, last_used_at FROM web_tokens LIMIT 1',
    oauth_states:
      'SELECT state, mode, verifier, account_id, client_id, redirect_uri, token, error, created_at, expires_at FROM oauth_states LIMIT 1',
    login_diagnostics:
      'SELECT id, stage, error_name, error_message, error_stack, context, created_at, expires_at FROM login_diagnostics LIMIT 1',
  };
  const result = {};
  for (const [name, sql] of Object.entries(checks)) {
    try {
      await env.DB.prepare(sql).first();
      result[name] = true;
    } catch {
      result[name] = false;
    }
  }
  return result;
}

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  if (method === 'GET' && path === '/api/health') {
    const readJsonSetting = async (key) => {
      try {
        return JSON.parse((await getSetting(env, key)) || 'null');
      } catch {
        return null;
      }
    };
    return json({
      ok: true,
      service: 'aegis',
      time: Date.now(),
      build: WORKER_BUILD,
      storage: await storageShape(env),
      lastLoginFailure: await readJsonSetting('last_login_failure'),
      lastServerError: await readJsonSetting('last_server_error'),
    });
  }

  if (method === 'GET' && path === '/api/diagnostics/login') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account)) bad('Only the owner account can read login diagnostics.', 403);
    const rows = await env.DB.prepare(
      `SELECT id, stage, username, error_name, error_message, created_at FROM login_diagnostics
       ORDER BY created_at DESC LIMIT 20`,
    ).all();
    return json({ build: WORKER_BUILD, records: rows.results ?? [] });
  }

  const diagnosticMatch = path.match(/^\/api\/diagnostics\/login\/([a-f0-9]{16})$/);
  if (method === 'GET' && diagnosticMatch) {
    const row = await env.DB.prepare(`SELECT * FROM login_diagnostics WHERE id = ?`)
      .bind(diagnosticMatch[1])
      .first();
    if (!row) bad('No diagnostic record with that code.', 404);
    const capability = String(url.searchParams.get('key') ?? '').trim();
    let allowed = Boolean(capability) && timingSafeEqual(await sha256Hex(capability), row.cap_hash);
    if (!allowed) {
      const state = await authenticate(env, request).catch(() => null);
      allowed = Boolean(state && isOwner(state.account));
    }
    if (!allowed) bad('That diagnostic link is not valid.', 403);
    if (Number(row.expires_at) && Number(row.expires_at) < Date.now()) {
      bad('That diagnostic record has expired. Retry the login to record a fresh one.', 410);
    }
    let context = null;
    try {
      context = JSON.parse(row.context || 'null');
    } catch {
      context = row.context ?? null;
    }
    return json({
      id: row.id,
      stage: row.stage,
      username: row.username,
      name: row.error_name,
      message: row.error_message,
      stack: row.error_stack,
      context,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      build: WORKER_BUILD,
    });
  }

  if (method === 'GET' && path === '/api/setup') {
    return handleSetup(request, env);
  }

  /* --------------------------------------------------- dashboard + hosting --- */

  if (method === 'GET' && path === '/api/bot') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    return json({
      ...(await readBotState(env)),
      canControl: hasScope(account, 'manageBot'),
      canHost: isOwner(account),
      // Crash reports are owner-only, both here and on /api/bot/crashes.
      ...(isOwner(account) ? { crashes: await readCrashes(env) } : {}),
      discordLinked: Boolean(account.discordId),
      discord: account.discordId
        ? { id: account.discordId, username: account.discordUsername, avatar: account.discordAvatar }
        : null,
    });
  }

  const botCommandMatch = path.match(/^\/api\/bot\/(start|stop)$/);
  if (botCommandMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    requireScope(account, 'manageBot');
    if (!(await getSetting(env, 'bot_host_hash'))) {
      bad('No bot host has been set up yet. Create the host runner token in the panel first.', 409);
    }
    const desired = botCommandMatch[1] === 'start' ? 'running' : 'stopped';
    await setSetting(env, 'bot_desired', desired);
    await setSetting(env, 'bot_requested_by', account.username);
    await setSetting(env, 'bot_requested_at', Date.now());
    return json({ ok: true, ...(await readBotState(env)) });
  }

  if (method === 'GET' && path === '/api/bot/host') {
    // Deliberately no write here: polling for commands must not cost a database
    // row per request. The status report keeps bot_host_seen fresh instead.
    await requireHost(env, request);
    return json({ desired: (await getSetting(env, 'bot_desired')) === 'running' ? 'running' : 'stopped' });
  }

  if (method === 'POST' && path === '/api/bot/host/status') {
    await requireHost(env, request);
    const body = await readBody(request);
    const snapshot = {
      status: body.status && typeof body.status === 'object' ? body.status : null,
      logs: Array.isArray(body.logs) ? body.logs.slice(-150) : [],
      nodeName: String(body.nodeName ?? '').slice(0, 60),
      version: String(body.version ?? '').slice(0, 24),
      reportedAt: Date.now(),
    };
    const raw = JSON.stringify(snapshot);
    if (raw.length > 400000) bad('Status snapshot is too large.');
    await setSetting(env, 'bot_state', raw);
    await setSetting(env, 'bot_host_seen', Date.now());
    const applicationId = String(body.status?.id ?? '').trim();
    if (/^\d{17,20}$/.test(applicationId)) {
      // Write only when it changed: reports arrive every five minutes and an
      // unconditional write would eat the daily row-write allowance on its own.
      if ((await getSetting(env, 'bot_application_id')) !== applicationId) {
        await setSetting(env, 'bot_application_id', applicationId);
      }
    }
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/bot/crashes') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account)) bad('Only the owner can read crash reports.', 403);
    return json({ crashes: await readCrashes(env) });
  }

  if (method === 'DELETE' && path === '/api/bot/crashes') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account)) bad('Only the owner can clear crash reports.', 403);
    await setSetting(env, 'bot_crashes', '[]');
    return json({ ok: true, crashes: [] });
  }

  if (method === 'POST' && path === '/api/bot/crashes') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account)) bad('Only the owner can record crash reports.', 403);
    const body = await readBody(request).catch(() => ({}));
    const crashes = await appendCrashes(env, body?.crashes ?? body?.crash ?? [], {
      node: body?.node,
      version: body?.version,
    });
    return json({ ok: true, crashes });
  }

  if (method === 'POST' && path === '/api/bot/host/crashes') {
    await requireHost(env, request);
    const body = await readBody(request).catch(() => ({}));
    const crashes = await appendCrashes(env, body?.crashes ?? body?.crash ?? [], {
      node: body?.node,
      version: body?.version,
    });
    return json({ ok: true, count: crashes.length });
  }

  if (method === 'POST' && path === '/api/bot/host-token') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account)) bad('Only the owner can create the host runner token.', 403);
    const token = `AEGIS-HOST-${randomGroup()}-${randomGroup()}-${randomGroup()}-${randomGroup()}`;
    await setSetting(env, 'bot_host_hash', await sha256Hex(token));
    await setSetting(env, 'bot_host_seen', 0);
    await setSetting(env, 'bot_state', 'null');
    return json({ token, server: url.origin });
  }

  if (path === '/api/web/tokens' && method === 'GET') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const rows = await env.DB.prepare(
      `SELECT id, label, created_at, last_used_at FROM web_tokens
       WHERE account_id = ? ORDER BY created_at DESC`,
    )
      .bind(account.id)
      .all();
    return json({
      tokens: (rows.results ?? []).map((row) => ({
        id: row.id,
        label: row.label ?? '',
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at ?? null,
      })),
    });
  }

  if (path === '/api/web/tokens' && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM web_tokens WHERE account_id = ?`)
      .bind(account.id)
      .first();
    if (Number(count?.count ?? 0) >= 10) {
      bad('Too many dashboard tokens. Revoke one before creating another.', 429);
    }
    const body = await readBody(request).catch(() => ({}));
    const label = String(body?.label ?? 'Dashboard').trim().slice(0, 60) || 'Dashboard';
    const token = await issueWebToken(env, account.id, label);
    return json({
      token,
      label,
      account: {
        username: account.username,
        discordId: account.discordId,
        discordUsername: account.discordUsername,
      },
    });
  }

  const webTokenMatch = path.match(/^\/api\/web\/tokens\/([A-Za-z0-9]+)$/);
  if (webTokenMatch && method === 'DELETE') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    await env.DB.prepare(`DELETE FROM web_tokens WHERE id = ? AND account_id = ?`)
      .bind(webTokenMatch[1], account.id)
      .run();
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/rooms') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const mine = await env.DB.prepare(
      `${ROOM_SELECT} JOIN room_members rm ON rm.room_id = r.id
       WHERE rm.account_id = ? ORDER BY r.created_at DESC`,
    )
      .bind(account.id)
      .all();
    const rooms = (mine.results ?? []).map((row) => roomSummary(row, account, true));

    let available = [];
    if (isOwner(account) || hasScope(account, 'manageRooms')) {
      const rows = await env.DB.prepare(
        `${ROOM_SELECT}
         WHERE r.id NOT IN (SELECT room_id FROM room_members WHERE account_id = ?)
         ORDER BY r.created_at DESC`,
      )
        .bind(account.id)
        .all();
      available = (rows.results ?? []).map((row) => roomSummary(row, account, false));
    }
    return json({ rooms, available });
  }

  if (method === 'POST' && path === '/api/rooms') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account) && !hasScope(account, 'manageRooms')) {
      bad('Your key does not have the Rooms permission.', 403);
    }
    const body = await readBody(request);
    const name = String(body.name ?? '').trim().slice(0, 40);
    if (name.length < 2) bad('Give the room a name (at least 2 characters).');

    let code = '';
    for (let attempt = 0; attempt < 6 && !code; attempt += 1) {
      const candidate = makeRoomCode();
      const exists = await env.DB.prepare(`SELECT id FROM rooms WHERE code = ?`).bind(candidate).first();
      if (!exists) code = candidate;
    }
    if (!code) bad('Could not allocate a room code. Try again.', 500);

    const id = randomHex(10);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO rooms (id, name, code, host_account_id, state, updated_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    )
      .bind(id, name, code, account.id, now)
      .run();
    await env.DB.prepare(`INSERT INTO room_members (room_id, account_id, joined_at) VALUES (?, ?, ?)`)
      .bind(id, account.id, now)
      .run();

    return json({
      room: {
        id,
        name,
        host: account.username,
        hostId: account.id,
        hostPublicId: account.publicId ?? null,
        isHost: true,
        joined: true,
        memberCount: 1,
        code,
        members: [
          {
            accountId: account.id,
            username: account.username,
            publicId: account.publicId ?? null,
            isHost: true,
            joinedAt: now,
          },
        ],
        updatedAt: null,
        createdAt: now,
      },
    });
  }

  if (method === 'POST' && path === '/api/rooms/join') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const body = await readBody(request);
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!code) bad('Enter a room code.');

    const row = await env.DB.prepare(`${ROOM_SELECT} WHERE r.code = ?`).bind(code).first();
    if (!row) bad('No room has that code.', 404);
    await env.DB.prepare(`INSERT OR IGNORE INTO room_members (room_id, account_id, joined_at) VALUES (?, ?, ?)`)
      .bind(row.id, account.id, Date.now())
      .run();
    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?`)
      .bind(row.id)
      .first();
    row.member_count = Number(count?.count ?? 1);
    return json({ room: roomSummary(row, account, true) });
  }

  const roomMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
  if (roomMatch && method === 'GET') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const row = await env.DB.prepare(`${ROOM_SELECT} WHERE r.id = ?`).bind(roomMatch[1]).first();
    if (!row) bad('That room no longer exists.', 404);
    const member = await env.DB.prepare(`SELECT 1 AS ok FROM room_members WHERE room_id = ? AND account_id = ?`)
      .bind(row.id, account.id)
      .first();
    if (!member && !isOwner(account) && !hasScope(account, 'manageRooms')) {
      bad('Join this room to see its console.', 403);
    }

    const payload = roomSummary(row, account, Boolean(member));
    if (row.state) {
      try {
        const parsed = JSON.parse(row.state);
        payload.status = parsed.status ?? null;
        payload.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
        payload.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      } catch {
        payload.status = null;
        payload.logs = [];
        payload.messages = [];
      }
    }
    payload.members = await roomMembers(env, row.id, row.host_account_id);
    return json({ room: payload });
  }

  const roomJoinMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/join$/);
  if (roomJoinMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account) && !hasScope(account, 'manageRooms')) {
      bad('Your key does not have the Rooms permission.', 403);
    }
    const row = await env.DB.prepare(`${ROOM_SELECT} WHERE r.id = ?`).bind(roomJoinMatch[1]).first();
    if (!row) bad('That room no longer exists.', 404);
    await env.DB.prepare(`INSERT OR IGNORE INTO room_members (room_id, account_id, joined_at) VALUES (?, ?, ?)`)
      .bind(row.id, account.id, Date.now())
      .run();
    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?`)
      .bind(row.id)
      .first();
    row.member_count = Number(count?.count ?? 1);
    return json({ room: roomSummary(row, account, true) });
  }

  const roomLeaveMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/leave$/);
  if (roomLeaveMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const row = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomLeaveMatch[1]).first();
    if (!row) bad('That room no longer exists.', 404);
    if (row.host_account_id === account.id) bad('You host this room. Delete it instead.');
    await env.DB.prepare(`DELETE FROM room_members WHERE room_id = ? AND account_id = ?`)
      .bind(row.id, account.id)
      .run();
    return json({ ok: true });
  }

  if (roomMatch && method === 'DELETE') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const row = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomMatch[1]).first();
    if (!row) bad('That room no longer exists.', 404);
    if (row.host_account_id !== account.id && !isOwner(account)) {
      bad('Only the host can delete this room.', 403);
    }
    await env.DB.prepare(`DELETE FROM room_members WHERE room_id = ?`).bind(row.id).run();
    await env.DB.prepare(`DELETE FROM room_invites WHERE room_id = ?`).bind(row.id).run();
    await env.DB.prepare(`DELETE FROM room_join_requests WHERE room_id = ?`).bind(row.id).run();
    await env.DB.prepare(`DELETE FROM room_actions WHERE room_id = ?`).bind(row.id).run();
    await env.DB.prepare(`DELETE FROM rooms WHERE id = ?`).bind(row.id).run();
    return json({ ok: true });
  }

  const roomStateMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/state$/);
  if (roomStateMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const row = await env.DB.prepare(`SELECT id, host_account_id FROM rooms WHERE id = ?`)
      .bind(roomStateMatch[1])
      .first();
    if (!row) bad('That room no longer exists.', 404);
    if (row.host_account_id !== account.id) bad('Only the room host can publish its console.', 403);

    const body = await readBody(request);
    const snapshot = {
      status: body.status ?? null,
      logs: Array.isArray(body.logs) ? body.logs.slice(-200) : [],
      messages: Array.isArray(body.messages) ? body.messages.slice(-250) : [],
    };
    const raw = JSON.stringify(snapshot);
    if (raw.length > 400000) bad('Console snapshot is too large.');
    const now = Date.now();
    await env.DB.prepare(`UPDATE rooms SET state = ?, updated_at = ? WHERE id = ?`)
      .bind(raw, now, row.id)
      .run();
    return json({ ok: true, updatedAt: now });
  }

  const roomMemberRemoveMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/members\/([A-Za-z0-9]+)$/);
  if (roomMemberRemoveMatch && method === 'DELETE') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomMemberRemoveMatch[1]).first();
    if (!room) bad('That room no longer exists.', 404);
    if (room.host_account_id !== account.id && !isOwner(account)) {
      bad('Only the room host can remove members.', 403);
    }
    if (roomMemberRemoveMatch[2] === room.host_account_id) bad('The host cannot be removed.', 400);
    await env.DB.prepare(`DELETE FROM room_members WHERE room_id = ? AND account_id = ?`)
      .bind(room.id, roomMemberRemoveMatch[2])
      .run();
    return json({ ok: true });
  }

  const roomInviteMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/invites$/);
  if (roomInviteMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomInviteMatch[1]).first();
    if (!room) bad('That room no longer exists.', 404);
    if (room.host_account_id !== account.id && !isOwner(account)) {
      bad('Only the room host can invite people.', 403);
    }
    const body = await readBody(request);
    const target = await accountByPublicId(env, body.publicId);
    if (!target) bad('No account has that ID.', 404);
    if (target.id === account.id) bad('You are already in this room.');
    const member = await env.DB.prepare(`SELECT 1 AS ok FROM room_members WHERE room_id = ? AND account_id = ?`)
      .bind(room.id, target.id)
      .first();
    if (member) bad('That account is already in this room.', 409);
    const existing = await env.DB.prepare(
      `SELECT id FROM room_invites WHERE room_id = ? AND invited_account_id = ? AND status = 'pending'`,
    )
      .bind(room.id, target.id)
      .first();
    let inviteId = existing?.id;
    if (!inviteId) {
      inviteId = randomHex(10);
      await env.DB.prepare(
        `INSERT INTO room_invites (id, room_id, invited_account_id, invited_by, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
        .bind(inviteId, room.id, target.id, account.id, Date.now())
        .run();
    }
    return json({
      invite: {
        id: inviteId,
        roomId: room.id,
        roomName: room.name,
        to: publicAccount(target),
      },
    });
  }

  if (roomInviteMatch && method === 'GET') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomInviteMatch[1]).first();
    if (!room) bad('That room no longer exists.', 404);
    if (room.host_account_id !== account.id && !isOwner(account)) {
      bad('Only the room host can see invites.', 403);
    }
    const rows = await env.DB.prepare(
      `SELECT i.*, a.username, a.public_id FROM room_invites i
       JOIN accounts a ON a.id = i.invited_account_id
       WHERE i.room_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
    )
      .bind(room.id)
      .all();
    return json({
      invites: (rows.results ?? []).map((row) => ({
        id: row.id,
        accountId: row.invited_account_id,
        username: row.username,
        publicId: row.public_id,
        createdAt: row.created_at,
      })),
    });
  }

  const inviteRespondMatch = path.match(/^\/api\/invites\/([A-Za-z0-9]+)\/respond$/);
  if (inviteRespondMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const invite = await env.DB.prepare(`SELECT * FROM room_invites WHERE id = ?`).bind(inviteRespondMatch[1]).first();
    if (!invite) bad('That invite no longer exists.', 404);
    if (invite.invited_account_id !== account.id) bad('That invite is for another account.', 403);
    if (invite.status !== 'pending') bad('That invite was already handled.', 409);
    const body = await readBody(request);
    const accept = Boolean(body.accept);
    let roomPayload = null;
    if (accept) {
      const roomRow = await env.DB.prepare(`${ROOM_SELECT} WHERE r.id = ?`).bind(invite.room_id).first();
      if (!roomRow) bad('That room no longer exists.', 404);
      await env.DB.prepare(`INSERT OR IGNORE INTO room_members (room_id, account_id, joined_at) VALUES (?, ?, ?)`)
        .bind(invite.room_id, account.id, Date.now())
        .run();
      roomPayload = roomSummary(roomRow, account, true);
    }
    await env.DB.prepare(`UPDATE room_invites SET status = ? WHERE id = ?`)
      .bind(accept ? 'accepted' : 'declined', invite.id)
      .run();
    return json({ ok: true, room: roomPayload });
  }

  const roomRequestMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/request$/);
  if (roomRequestMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomRequestMatch[1]).first();
    if (!room) bad('That room no longer exists.', 404);
    if (room.host_account_id === account.id) bad('You already host this room.', 400);
    const member = await env.DB.prepare(`SELECT 1 AS ok FROM room_members WHERE room_id = ? AND account_id = ?`)
      .bind(room.id, account.id)
      .first();
    if (member) bad('You are already in this room.', 409);
    const existing = await env.DB.prepare(
      `SELECT id FROM room_join_requests WHERE room_id = ? AND account_id = ? AND status = 'pending'`,
    )
      .bind(room.id, account.id)
      .first();
    let requestId = existing?.id;
    if (!requestId) {
      requestId = randomHex(10);
      await env.DB.prepare(
        `INSERT INTO room_join_requests (id, room_id, account_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
      )
        .bind(requestId, room.id, account.id, Date.now())
        .run();
    }
    return json({ request: { id: requestId, roomId: room.id, status: 'pending' } });
  }

  const requestRespondMatch = path.match(/^\/api\/requests\/([A-Za-z0-9]+)\/respond$/);
  if (requestRespondMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const requestRow = await env.DB.prepare(`SELECT * FROM room_join_requests WHERE id = ?`)
      .bind(requestRespondMatch[1])
      .first();
    if (!requestRow) bad('That request no longer exists.', 404);
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(requestRow.room_id).first();
    if (!room) bad('That room no longer exists.', 404);
    if (room.host_account_id !== account.id && !isOwner(account)) {
      bad('Only the room host can answer join requests.', 403);
    }
    if (requestRow.status !== 'pending') bad('That request was already handled.', 409);
    const body = await readBody(request);
    const accept = Boolean(body.accept);
    if (accept) {
      await env.DB.prepare(`INSERT OR IGNORE INTO room_members (room_id, account_id, joined_at) VALUES (?, ?, ?)`)
        .bind(room.id, requestRow.account_id, Date.now())
        .run();
    }
    await env.DB.prepare(`UPDATE room_join_requests SET status = ? WHERE id = ?`)
      .bind(accept ? 'accepted' : 'declined', requestRow.id)
      .run();
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/social') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const friendRows = await env.DB.prepare(
      `SELECT f.*, CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END AS friend_id
       FROM friendships f
       WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)`,
    )
      .bind(account.id, account.id, account.id)
      .all();
    const friendIds = (friendRows.results ?? []).map((row) => row.friend_id);
    let friends = [];
    if (friendIds.length) {
      const rows = await env.DB.prepare(
        `SELECT id, username, public_id FROM accounts WHERE id IN (${friendIds.map(() => '?').join(',')})`,
      )
        .bind(...friendIds)
        .all();
      friends = (rows.results ?? []).map(publicAccount);
    }

    const incomingRows = await env.DB.prepare(
      `SELECT f.id, f.created_at, a.id AS account_id, a.username, a.public_id
       FROM friendships f JOIN accounts a ON a.id = f.requester_id
       WHERE f.addressee_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`,
    )
      .bind(account.id)
      .all();
    const outgoingRows = await env.DB.prepare(
      `SELECT f.id, f.created_at, a.id AS account_id, a.username, a.public_id
       FROM friendships f JOIN accounts a ON a.id = f.addressee_id
       WHERE f.requester_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`,
    )
      .bind(account.id)
      .all();

    const inviteRows = await env.DB.prepare(
      `SELECT i.id, i.room_id, i.created_at, r.name AS room_name,
              a.username AS from_name, a.public_id AS from_public_id
       FROM room_invites i JOIN rooms r ON r.id = i.room_id
       LEFT JOIN accounts a ON a.id = i.invited_by
       WHERE i.invited_account_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
    )
      .bind(account.id)
      .all();

    const joinRows = await env.DB.prepare(
      `SELECT j.id, j.room_id, j.created_at, r.name AS room_name, a.username, a.public_id
       FROM room_join_requests j JOIN rooms r ON r.id = j.room_id
       JOIN accounts a ON a.id = j.account_id
       WHERE r.host_account_id = ? AND j.status = 'pending' ORDER BY j.created_at DESC`,
    )
      .bind(account.id)
      .all();

    const hostedRows = await env.DB.prepare(
      `SELECT r.id, r.name, (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count
       FROM rooms r WHERE r.host_account_id = ? ORDER BY r.created_at DESC`,
    )
      .bind(account.id)
      .all();

    let friendRooms = [];
    if (friendIds.length) {
      const placeholders = friendIds.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT r.id, r.name, r.created_at, a.username AS host_name, a.public_id AS host_public_id,
                (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
                EXISTS(SELECT 1 FROM room_join_requests j WHERE j.room_id = r.id AND j.account_id = ? AND j.status = 'pending') AS requested
         FROM rooms r JOIN accounts a ON a.id = r.host_account_id
         WHERE r.host_account_id IN (${placeholders})
           AND r.id NOT IN (SELECT room_id FROM room_members WHERE account_id = ?)
         ORDER BY r.created_at DESC`,
      )
        .bind(account.id, ...friendIds, account.id)
        .all();
      friendRooms = (rows.results ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        host: row.host_name,
        hostPublicId: row.host_public_id,
        memberCount: Number(row.member_count ?? 0),
        requested: Boolean(row.requested),
        createdAt: row.created_at,
      }));
    }

    return json({
      me: { username: account.username, publicId: account.publicId },
      friends,
      incoming: (incomingRows.results ?? []).map((row) => ({
        id: row.id,
        accountId: row.account_id,
        username: row.username,
        publicId: row.public_id,
        createdAt: row.created_at,
      })),
      outgoing: (outgoingRows.results ?? []).map((row) => ({
        id: row.id,
        accountId: row.account_id,
        username: row.username,
        publicId: row.public_id,
        createdAt: row.created_at,
      })),
      invites: (inviteRows.results ?? []).map((row) => ({
        id: row.id,
        roomId: row.room_id,
        roomName: row.room_name,
        from: row.from_name,
        fromPublicId: row.from_public_id,
        createdAt: row.created_at,
      })),
      joinRequests: (joinRows.results ?? []).map((row) => ({
        id: row.id,
        roomId: row.room_id,
        roomName: row.room_name,
        username: row.username,
        publicId: row.public_id,
        createdAt: row.created_at,
      })),
      hostedRooms: (hostedRows.results ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        memberCount: Number(row.member_count ?? 0),
      })),
      friendRooms,
    });
  }

  if (method === 'POST' && path === '/api/friends/request') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const body = await readBody(request);
    const target = await accountByPublicId(env, body.publicId);
    if (!target) bad('No account has that ID.', 404);
    if (target.id === account.id) bad('That is your own ID.');
    const existing = await env.DB.prepare(
      `SELECT * FROM friendships
       WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
    )
      .bind(account.id, target.id, target.id, account.id)
      .first();
    if (existing?.status === 'accepted') bad('You are already friends.', 409);
    if (existing?.status === 'pending') {
      if (existing.addressee_id === account.id) {
        await env.DB.prepare(`UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?`)
          .bind(Date.now(), existing.id)
          .run();
        return json({ ok: true, accepted: true });
      }
      bad('You already sent that friend request.', 409);
    }
    await env.DB.prepare(
      `INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(randomHex(10), account.id, target.id, Date.now(), Date.now())
      .run();
    return json({ ok: true });
  }

  if (method === 'POST' && path === '/api/friends/respond') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const body = await readBody(request);
    const row = await env.DB.prepare(`SELECT * FROM friendships WHERE id = ?`).bind(String(body.id ?? '')).first();
    if (!row) bad('That friend request no longer exists.', 404);
    if (row.addressee_id !== account.id) bad('That request is for another account.', 403);
    if (row.status !== 'pending') bad('That request was already handled.', 409);
    if (body.accept) {
      await env.DB.prepare(`UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?`)
        .bind(Date.now(), row.id)
        .run();
    } else {
      await env.DB.prepare(`DELETE FROM friendships WHERE id = ?`).bind(row.id).run();
    }
    return json({ ok: true });
  }

  const friendDeleteMatch = path.match(/^\/api\/friends\/([A-Za-z0-9]+)$/);
  if (friendDeleteMatch && method === 'DELETE') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    await env.DB.prepare(
      `DELETE FROM friendships
       WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
    )
      .bind(account.id, friendDeleteMatch[1], friendDeleteMatch[1], account.id)
      .run();
    return json({ ok: true });
  }

  const roomActionsMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/actions$/);
  if (roomActionsMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomActionsMatch[1]).first();
    if (!room) bad('That room no longer exists.', 404);
    const member = await env.DB.prepare(`SELECT 1 AS ok FROM room_members WHERE room_id = ? AND account_id = ?`)
      .bind(room.id, account.id)
      .first();
    if (!member) bad('Join this room before controlling it.', 403);
    const body = await readBody(request);
    const type = String(body.type ?? '');
    if (!ROOM_ACTION_TYPES.has(type)) bad('Unknown room action.');
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const payloadRaw = JSON.stringify(payload);
    if (payloadRaw.length > 20000) bad('That action is too large.');

    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM room_actions WHERE account_id = ? AND created_at > ?`,
    )
      .bind(account.id, Date.now() - 60_000)
      .first();
    if (Number(recent?.count ?? 0) > 120) bad('Slow down: too many room actions. Try again in a minute.', 429);

    const id = randomHex(10);
    await env.DB.prepare(
      `INSERT INTO room_actions (id, room_id, account_id, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(id, room.id, account.id, type, payloadRaw, Date.now())
      .run();
    return json({ action: { id, status: 'pending' } });
  }

  if (roomActionsMatch && method === 'GET') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomActionsMatch[1]).first();
    if (!room) bad('That room no longer exists.', 404);
    if (room.host_account_id !== account.id) bad('Only the room host can read actions.', 403);
    const rows = await env.DB.prepare(
      `SELECT a.*, ac.username, ac.public_id FROM room_actions a
       JOIN accounts ac ON ac.id = a.account_id
       WHERE a.room_id = ? AND a.status = 'pending' ORDER BY a.created_at ASC LIMIT 25`,
    )
      .bind(room.id)
      .all();
    return json({
      actions: (rows.results ?? []).map((row) => {
        let payload = {};
        try {
          payload = JSON.parse(row.payload ?? '{}');
        } catch {}
        return {
          id: row.id,
          type: row.type,
          payload,
          username: row.username,
          publicId: row.public_id,
          createdAt: row.created_at,
        };
      }),
    });
  }

  const roomActionResultMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/actions\/([A-Za-z0-9]+)\/result$/);
  if (roomActionResultMatch && method === 'POST') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomActionResultMatch[1]).first();
    if (!room) bad('That room no longer exists.', 404);
    if (room.host_account_id !== account.id) bad('Only the room host can answer actions.', 403);
    const body = await readBody(request);
    const result = {
      ok: Boolean(body.ok),
      message: String(body.message ?? '').slice(0, 4000),
      data: body.data ?? null,
    };
    const raw = JSON.stringify(result);
    await env.DB.prepare(
      `UPDATE room_actions SET status = ?, result = ?, completed_at = ? WHERE id = ? AND room_id = ?`,
    )
      .bind(result.ok ? 'done' : 'error', raw, Date.now(), roomActionResultMatch[2], room.id)
      .run();
    return json({ ok: true });
  }

  const roomActionMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/actions\/([A-Za-z0-9]+)$/);
  if (roomActionMatch && method === 'GET') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomActionMatch[1]).first();
    if (!room) bad('That room no longer exists.', 404);
    const member = await env.DB.prepare(`SELECT 1 AS ok FROM room_members WHERE room_id = ? AND account_id = ?`)
      .bind(room.id, account.id)
      .first();
    if (!member) bad('Join this room first.', 403);
    const row = await env.DB.prepare(`SELECT * FROM room_actions WHERE id = ? AND room_id = ?`)
      .bind(roomActionMatch[2], room.id)
      .first();
    if (!row) bad('That action no longer exists.', 404);
    let result = null;
    try {
      result = row.result ? JSON.parse(row.result) : null;
    } catch {}
    return json({ action: { id: row.id, status: row.status, result } });
  }

  if (method === 'GET' && path === '/api/console') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account) && !hasScope(account, 'linkConsole')) {
      bad('This key does not have the Linked console permission.', 403);
    }
    const row = await env.DB.prepare(
      `SELECT c.*, a.username AS host_name FROM shared_console c
       LEFT JOIN accounts a ON a.id = c.host_account_id WHERE c.id = 'shared'`,
    ).first();
    if (!row) return json({ console: null });
    let snapshot = { status: null, logs: [] };
    try {
      snapshot = JSON.parse(row.state);
    } catch {
      snapshot = { status: null, logs: [] };
    }
    return json({
      console: {
        status: snapshot.status ?? null,
        logs: Array.isArray(snapshot.logs) ? snapshot.logs : [],
        updatedAt: row.updated_at,
        host: row.host_name ?? null,
      },
    });
  }

  if (method === 'POST' && path === '/api/console') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account)) bad('Only the host console can publish shared state.', 403);
    const body = await readBody(request);
    const snapshot = {
      status: body.status ?? null,
      logs: Array.isArray(body.logs) ? body.logs.slice(-200) : [],
    };
    const raw = JSON.stringify(snapshot);
    if (raw.length > 400000) bad('Console snapshot is too large.');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO shared_console (id, state, host_account_id, updated_at) VALUES ('shared', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, host_account_id = excluded.host_account_id, updated_at = excluded.updated_at`,
    )
      .bind(raw, account.id, now)
      .run();
    return json({ ok: true, updatedAt: now });
  }

  if (method === 'GET' && path === '/api/download/latest') {
    const row = await env.DB.prepare(
      `SELECT * FROM releases WHERE published = 1 ORDER BY published_at DESC LIMIT 1`,
    ).first();
    if (!row) bad('No build has been published yet.', 404);
    return new Response(null, {
      status: 302,
      headers: { location: `${url.origin}/api/releases/${row.id}/download` },
    });
  }

  if (method === 'GET' && path === '/api/auth/salt') {
    const username = (url.searchParams.get('username') ?? '').trim().toLowerCase();
    if (!username) bad('Enter a username.');
    const row = await env.DB.prepare(`SELECT salt FROM accounts WHERE username_lower = ?`).bind(username).first();
    const salt = row?.salt ?? bufferToBase64(crypto.getRandomValues(new Uint8Array(16)));
    return json({ salt });
  }

  if (method === 'POST' && path === '/api/auth/register') {
    return handleRegister(request, env);
  }

  if (method === 'POST' && path === '/api/auth/login') {
    return handleLogin(request, env, url);
  }

  if (method === 'POST' && path === '/api/auth/verify') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    return json({ account: await accountWithKey(env, account), discordSupported: true });
  }

  if (method === 'GET' && path === '/api/auth/discord/callback') {
    return handleDiscordCallback(request, env, url);
  }

  if (method === 'GET' && path === '/api/auth/discord/start') {
    try {
      const auth = await createDiscordAuth(env, url, { mode: 'web' });
      return redirectResponse(auth.url);
    } catch (error) {
      if (error instanceof HttpError) {
        return redirectResponse(`${url.origin}/?discord=unconfigured&message=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
  }

  if (method === 'POST' && path === '/api/auth/discord/link/start') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const auth = await createDiscordAuth(env, url, { mode: 'link', accountId: account.id });
    return json({ url: auth.url, expiresAt: auth.expiresAt });
  }

  if (method === 'POST' && path === '/api/auth/discord/desktop/start') {
    const state = await authenticate(env, request);
    const body = await readBody(request).catch(() => ({}));
    const requestedId = String(body?.clientId ?? '').trim();
    if (requestedId && !/^\d{17,20}$/.test(requestedId)) {
      bad('That does not look like a Discord application ID.');
    }
    // Remember the app ID for invites, but never replace a configured OAuth
    // client: the redirect URL is registered on that application only.
    const configuredClient = String(await discordClientId(env)).trim();
    if (
      requestedId &&
      state?.account &&
      (!/^\d{17,20}$/.test(configuredClient) || configuredClient === requestedId)
    ) {
      await setSetting(env, 'bot_application_id', requestedId);
    }
    const auth = await createDiscordAuth(env, url, {
      mode: 'desktop',
      accountId: state?.account?.id ?? null,
      clientIdOverride: requestedId || null,
    });
    return json({ url: auth.url, code: auth.state, expiresAt: auth.expiresAt });
  }

  if (method === 'POST' && path === '/api/auth/discord/desktop/poll') {
    const body = await readBody(request);
    const code = String(body?.code ?? '').trim();
    if (!code) bad('Missing sign-in code.');
    const row = await env.DB.prepare(
      `SELECT * FROM oauth_states WHERE state = ? AND mode = 'desktop'`,
    )
      .bind(code)
      .first();
    if (!row) bad('That Discord sign-in expired. Start again from the app.', 410);
    if (Number(row.expires_at) < Date.now()) {
      await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(code).run().catch(() => {});
      bad('That Discord sign-in expired. Start again from the app.', 410);
    }
    if (row.error) {
      const message = row.error;
      await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(code).run().catch(() => {});
      bad(message, 400);
    }
    if (!row.token || !row.account_id) return json({ pending: true });
    const accountRow = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(row.account_id).first();
    if (!accountRow) bad('That account no longer exists.', 404);
    await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(code).run().catch(() => {});
    return json({ token: row.token, account: accountFromRow(accountRow) });
  }

  if (method === 'GET' && path === '/api/auth/discord/status') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    const clientId = String(await discordClientId(env)).trim();
    const redirectUri = await discordRedirectUri(env, url);
    return json({
      configured: /^\d{17,20}$/.test(clientId),
      clientId: /^\d{17,20}$/.test(clientId) ? clientId : null,
      redirectUri,
      redirectSource: String(env.DISCORD_REDIRECT_URI ?? '').trim()
        ? 'environment'
        : (await getSetting(env, 'discord_redirect_uri'))
          ? 'dashboard'
          : 'default',
      canEditRedirect: isOwner(account),
      linked: Boolean(account.discordId),
      discordId: account.discordId,
      username: account.discordUsername,
      avatar: account.discordAvatar,
    });
  }

  /* The redirect URL has to match the Developer Portal exactly. Letting the
   * owner pin it here removes the mismatch that Discord reports as
   * "invalid oauth2 redirect_uri". */
  if (method === 'POST' && path === '/api/auth/discord/redirect') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    if (!isOwner(account)) bad('Only the owner can change the Discord redirect URL.', 403);
    if (String(env.DISCORD_REDIRECT_URI ?? '').trim()) {
      bad('DISCORD_REDIRECT_URI is set on the site, so it overrides this value. Clear it to use the dashboard setting.', 409);
    }
    const body = await readBody(request).catch(() => ({}));
    const raw = String(body?.redirectUri ?? '').trim();
    if (raw) {
      let parsed = null;
      try {
        parsed = new URL(raw);
      } catch {
        bad('That is not a valid URL. Paste the exact redirect URL from the Discord Developer Portal.');
      }
      if (parsed.protocol !== 'https:') bad('The Discord redirect URL must start with https://');
      if (parsed.search || parsed.hash) bad('Remove the query string and the # part from the redirect URL.');
      if (!/\/api\/auth\/discord\/callback\/?$/.test(parsed.pathname)) {
        bad('The redirect URL must end with /api/auth/discord/callback.');
      }
    }
    await setSetting(env, 'discord_redirect_uri', raw);
    return json({ ok: true, redirectUri: await discordRedirectUri(env, url) });
  }

  if (method === 'POST' && path === '/api/auth/discord/unlink') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    await env.DB.prepare(
      `UPDATE accounts SET discord_id = NULL, discord_username = NULL, discord_avatar = NULL, discord_linked_at = NULL WHERE id = ?`,
    )
      .bind(account.id)
      .run();
    return json({ ok: true });
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const state = await authenticate(env, request);
    if (state?.tokenHash) {
      await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(state.tokenHash).run();
    }
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/keys') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    requireScope(account, 'manageKeys');
    const rows = await env.DB.prepare(`SELECT k.*, a.username AS used_by_name FROM keys k LEFT JOIN accounts a ON a.id = k.used_by ORDER BY k.created_at ASC`).all();
    return json({ keys: (rows.results ?? []).map(keyFromRow) });
  }

  if (method === 'POST' && path === '/api/keys') {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    requireScope(account, 'manageKeys');
    const body = await readBody(request);
    const scopes = safeScopes(body.scopes);
    if (!isOwner(account)) {
      const missing = scopes.filter((scope) => !account.scopes.includes(scope));
      if (missing.length) bad(`You can't grant permissions you don't have.`, 403);
    }
    const id = randomHex(12);
    const key = makeKey();
    const label = String(body.label ?? '').trim().slice(0, 60);
    const discordId = String(body.discordId ?? '').trim();
    if (discordId && !/^\d{17,20}$/.test(discordId)) {
      bad('That does not look like a Discord user ID (17-20 digits).');
    }
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO keys (id, key, label, role, scopes, disabled, created_at, discord_id) VALUES (?, ?, ?, 'user', ?, 0, ?, ?)`,
    )
      .bind(id, key, label, JSON.stringify(scopes), now, discordId || null)
      .run();
    const rows = await env.DB.prepare(`SELECT k.*, a.username AS used_by_name FROM keys k LEFT JOIN accounts a ON a.id = k.used_by ORDER BY k.created_at ASC`).all();
    return json({ keys: (rows.results ?? []).map(keyFromRow) });
  }

  const keyMatch = path.match(/^\/api\/keys\/([A-Za-z0-9]+)$/);
  if (keyMatch && (method === 'PATCH' || method === 'DELETE')) {
    const state = await authenticate(env, request);
    const account = requireAuth(state);
    requireScope(account, 'manageKeys');
    const target = await env.DB.prepare(`SELECT * FROM keys WHERE id = ?`).bind(keyMatch[1]).first();
    if (!target) bad('That key no longer exists.', 404);
    if (target.role === 'owner' && !isOwner(account)) bad('Only the owner can change the owner key.', 403);

    if (method === 'DELETE') {
      if (target.role === 'owner') bad("The owner key can't be deleted.", 403);
      if (target.id === account.keyId) bad("You can't delete your own key.", 403);
      await env.DB.prepare(`DELETE FROM keys WHERE id = ?`).bind(target.id).run();
      if (target.used_by) {
        await revokeAccountSessions(env, target.used_by);
        await env.DB.prepare(`UPDATE accounts SET key_id = NULL WHERE key_id = ?`).bind(target.id).run();
      }
      const rows = await env.DB.prepare(`SELECT k.*, a.username AS used_by_name FROM keys k LEFT JOIN accounts a ON a.id = k.used_by ORDER BY k.created_at ASC`).all();
      return json({ keys: (rows.results ?? []).map(keyFromRow) });
    }

    const body = await readBody(request);
    const isSelf = target.id === account.keyId;
    if (isSelf && !isOwner(account)) {
      const fields = Object.keys(body ?? {});
      const onlyReset = fields.length === 1 && fields[0] === 'resetHwid' && body.resetHwid === true;
      if (!onlyReset) bad("You can't change your own key.", 403);
    }

    const updates = [];
    const values = [];

    if (typeof body.label === 'string') {
      updates.push('label = ?');
      values.push(body.label.trim().slice(0, 60));
    }
    if (typeof body.discordId === 'string') {
      const discordId = body.discordId.trim();
      if (discordId && !/^\d{17,20}$/.test(discordId)) {
        bad('That does not look like a Discord user ID (17-20 digits).');
      }
      updates.push('discord_id = ?');
      values.push(discordId || null);
    }
    if (typeof body.disabled === 'boolean') {
      updates.push('disabled = ?');
      values.push(body.disabled ? 1 : 0);
      if (body.disabled && target.used_by) await revokeAccountSessions(env, target.used_by);
    }
    if (body.resetHwid) {
      updates.push('hwid = NULL');
      if (target.used_by) {
        await revokeAccountSessions(env, target.used_by);
        await env.DB.prepare(`UPDATE accounts SET hwid = NULL WHERE id = ?`).bind(target.used_by).run();
      }
    }
    if (Array.isArray(body.scopes)) {
      const scopes = safeScopes(body.scopes);
      if (!isOwner(account)) {
        const missing = scopes.filter((scope) => !account.scopes.includes(scope));
        if (missing.length) bad(`You can't grant permissions you don't have.`, 403);
      }
      updates.push('scopes = ?');
      values.push(JSON.stringify(scopes));
      if (target.used_by) {
        await env.DB.prepare(`UPDATE accounts SET scopes = ? WHERE id = ?`).bind(JSON.stringify(scopes), target.used_by).run();
      }
    }

    if (updates.length) {
      values.push(target.id);
      await env.DB.prepare(`UPDATE keys SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...values)
        .run();
    }

    const rows = await env.DB.prepare(`SELECT k.*, a.username AS used_by_name FROM keys k LEFT JOIN accounts a ON a.id = k.used_by ORDER BY k.created_at ASC`).all();
    return json({ keys: (rows.results ?? []).map(keyFromRow) });
  }

  if (method === 'GET' && path === '/api/releases/latest') {
    const row = await env.DB.prepare(
      `SELECT * FROM releases WHERE published = 1 ORDER BY published_at DESC LIMIT 1`,
    ).first();
    if (!row) return json({ release: null });
    const release = {
      id: row.id,
      version: row.version,
      notes: row.notes ?? '',
      sha256: row.sha256,
      size: row.size,
      publishedAt: row.published_at,
      downloadUrl: `${url.origin}/api/releases/${row.id}/download`,
    };
    return json({ release });
  }

  if (method === 'POST' && path === '/api/releases') {
    await requirePublisher(request, env);
    const body = await readBody(request);
    const version = String(body.version ?? '').trim();
    const sha256 = String(body.sha256 ?? '').trim().toLowerCase();
    const size = Number(body.size ?? 0);
    const parts = Number(body.parts ?? 0);
    if (!/^\d+\.\d+\.\d+$/.test(version)) bad('Version must look like 1.2.3.');
    if (!/^[a-f0-9]{64}$/.test(sha256)) bad('A SHA-256 hash is required.');
    if (!Number.isInteger(size) || size <= 0) bad('Invalid file size.');
    if (!Number.isInteger(parts) || parts <= 0 || parts > 500) bad('Invalid part count.');
    const id = randomHex(10);
    await env.DB.prepare(
      `INSERT INTO releases (id, version, notes, sha256, size, parts, published, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
      .bind(id, version, String(body.notes ?? '').slice(0, 4000), sha256, size, parts, Date.now())
      .run();
    return json({ id, version, parts, partSize: MAX_PART_BYTES });
  }

  const partMatch = path.match(/^\/api\/releases\/([A-Za-z0-9]+)\/parts\/(\d+)$/);
  if (partMatch && method === 'PUT') {
    await requirePublisher(request, env);
    const release = await env.DB.prepare(`SELECT * FROM releases WHERE id = ?`).bind(partMatch[1]).first();
    if (!release) bad('Release not found.', 404);
    const index = Number(partMatch[2]);
    if (!Number.isInteger(index) || index < 0 || index >= release.parts) bad('Invalid part index.');

    const buffer = await request.arrayBuffer();
    if (!buffer.byteLength) bad('Empty part.');
    if (buffer.byteLength > MAX_PART_BYTES) bad('Part is too large.');
    const r2Key = `releases/${release.id}/${index}`;
    await env.FILES.put(r2Key, buffer, { httpMetadata: { contentType: 'application/octet-stream' } });
    await env.DB.prepare(
      `INSERT OR REPLACE INTO release_parts (release_id, part, r2_key, size) VALUES (?, ?, ?, ?)`,
    )
      .bind(release.id, index, r2Key, buffer.byteLength)
      .run();
    return json({ ok: true, part: index, size: buffer.byteLength });
  }

  const finalizeMatch = path.match(/^\/api\/releases\/([A-Za-z0-9]+)\/finalize$/);
  if (finalizeMatch && method === 'POST') {
    await requirePublisher(request, env);
    const release = await env.DB.prepare(`SELECT * FROM releases WHERE id = ?`).bind(finalizeMatch[1]).first();
    if (!release) bad('Release not found.', 404);
    const stored = await env.DB.prepare(`SELECT COUNT(*) AS count FROM release_parts WHERE release_id = ?`).bind(release.id).first();
    if (Number(stored?.count ?? 0) !== release.parts) bad('Some parts are still missing.', 409);
    await env.DB.prepare(`UPDATE releases SET published = 1, published_at = ? WHERE id = ?`).bind(Date.now(), release.id).run();

    // Keep the current and previous build only, so update storage does not grow forever.
    const stale = await env.DB.prepare(
      `SELECT id FROM releases WHERE published = 1 ORDER BY published_at DESC LIMIT -1 OFFSET 2`,
    ).all();
    for (const old of stale.results ?? []) {
      const oldParts = await env.DB.prepare(`SELECT r2_key FROM release_parts WHERE release_id = ?`)
        .bind(old.id)
        .all();
      for (const part of oldParts.results ?? []) {
        await env.FILES.delete(part.r2_key);
      }
      await env.DB.prepare(`DELETE FROM release_parts WHERE release_id = ?`).bind(old.id).run();
      await env.DB.prepare(`DELETE FROM releases WHERE id = ?`).bind(old.id).run();
    }

    return json({
      release: {
        id: release.id,
        version: release.version,
        notes: release.notes,
        sha256: release.sha256,
        size: release.size,
        downloadUrl: `${url.origin}/api/releases/${release.id}/download`,
      },
    });
  }

  const downloadMatch = path.match(/^\/api\/releases\/([A-Za-z0-9]+)\/download$/);
  if (downloadMatch && method === 'GET') {
    const release = await env.DB.prepare(`SELECT * FROM releases WHERE id = ? AND published = 1`).bind(downloadMatch[1]).first();
    if (!release) bad('Release not found.', 404);
    const rows = await env.DB.prepare(`SELECT r2_key, size FROM release_parts WHERE release_id = ? ORDER BY part ASC`)
      .bind(release.id)
      .all();
    const parts = rows.results ?? [];
    if (!parts.length) bad('Release file missing.', 404);

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (const part of parts) {
            const object = await env.FILES.get(part.r2_key);
            if (!object) throw new Error(`missing part ${part.r2_key}`);
            const reader = object.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(release.size),
        'content-disposition': `attachment; filename="Aegis-Control-${release.version}.exe"`,
        'cache-control': 'no-store',
        ...corsHeaders(),
      },
    });
  }

  bad('Not found.', 404);
}

function linkPage() {
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aegis Control - linked</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c10;color:#f2f4f8;font:15px/1.6 system-ui,Segoe UI,sans-serif}
.card{max-width:400px;padding:32px;border:1px solid #242833;border-radius:14px;background:#12141a;text-align:center}
h1{font-size:20px;margin:0 0 8px}
p{color:#9aa3b2;margin:0}
</style></head>
<body><div class="card"><h1>Discord linked</h1><p>You can close this tab and return to Aegis Control.</p></div></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        await ensureSchema(env);
        const response = await handleApi(request, env, url);
        for (const [name, value] of Object.entries(corsHeaders())) response.headers.set(name, value);
        return response;
      }
      if (url.pathname === '/download' || url.pathname === '/download/') {
        await ensureSchema(env);
        const row = await env.DB.prepare(
          `SELECT * FROM releases WHERE published = 1 ORDER BY published_at DESC LIMIT 1`,
        ).first();
        return downloadPage(row);
      }
      if (url.pathname === '/link' || url.pathname === '/link/') {
        return linkPage();
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ service: 'aegis' });
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status, corsHeaders());
      }
      console.error('aegis-api error', error?.stack || error?.message || error);
      const routePath = url.pathname.replace(/\/+$/, '');
      const isLoginFlow = LOGIN_FLOW_PATHS.has(routePath);
      // Nothing may fail silently: the whole stack and the route are recorded,
      // whichever API route broke and whether or not the client can read it.
      const recorded = await recordLoginDiagnostic(env, {
        stage: isLoginFlow ? `request:${routePath}` : `route:${routePath}`,
        username: null,
        error,
        context: { build: WORKER_BUILD, path: url.pathname, note: 'failed before the route returned a response' },
      }).catch((writeError) => {
        console.error('login diagnostic could not be stored', writeError?.message || writeError);
        return { id: null, capability: null };
      });
      await setSetting(
        env,
        'last_server_error',
        JSON.stringify({
          at: Date.now(),
          path: routePath,
          stage: isLoginFlow ? `request:${routePath}` : `route:${routePath}`,
          name: error?.name ?? null,
          traceId: recorded.id,
        }),
      ).catch(() => {});
      const link = recorded.id ? diagnosticsUrl(url, recorded.id, recorded.capability) : null;
      if (isLoginFlow) {
        await setSetting(
          env,
          'last_login_failure',
          JSON.stringify({ at: Date.now(), stage: `request:${routePath}`, name: error?.name ?? null, traceId: recorded.id }),
        ).catch(() => {});
        return json(
          {
            error: link
              ? `Login failed on the server at stage "request:${routePath}". Diagnostic link: ${link}`
              : 'Server error. Try again.',
            stage: `request:${routePath}`,
            traceId: recorded.id,
            traceKey: recorded.capability,
          },
          link ? 503 : 500,
          corsHeaders(),
        );
      }
      return json(
        {
          error: link
            ? `The server failed at ${routePath}. Diagnostic link: ${link}`
            : 'Server error. Try again.',
          stage: `route:${routePath}`,
          traceId: recorded.id,
          traceKey: recorded.capability,
        },
        500,
        corsHeaders(),
      );
    }
  },
};
