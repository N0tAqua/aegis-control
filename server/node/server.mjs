/**
 * The Aegis API on plain Node.
 *
 * `server/worker.js` is written as a Cloudflare Worker: `fetch(request, env)`.
 * This module feeds it the three bindings it expects (DB, FILES, ASSETS) from
 * local files, so one `node` process can serve the API and the dashboard on a
 * host such as Wispbyte.
 */
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import worker from '../worker.js';
import { createAssetStore } from './assets.mjs';
import { createFileStore } from './files-r2.mjs';
import { openD1 } from './sqlite-d1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function originOf(request) {
  const proto =
    String(request.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim() || 'http';
  const host =
    String(request.headers['x-forwarded-host'] ?? '')
      .split(',')[0]
      .trim() ||
    request.headers.host ||
    'localhost';
  return `${proto}://${host}`;
}

function toHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

async function handle(request, response, env) {
  const method = (request.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  try {
    const web = new Request(`${originOf(request)}${request.url || '/'}`, {
      method,
      headers: toHeaders(request.headers),
      body: hasBody ? Readable.toWeb(request) : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
    });

    const result = await worker.fetch(web, env);

    response.statusCode = result.status;
    result.headers.forEach((value, name) => {
      try {
        response.setHeader(name, value);
      } catch {
        // Some platform headers are not settable; skip them.
      }
    });

    if (!result.body || method === 'HEAD') {
      response.end();
      return;
    }
    Readable.fromWeb(result.body).pipe(response);
  } catch (error) {
    console.error('aegis self-host request failed', error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    response.end('Aegis server error.');
  }
}

/**
 * Create the HTTP server and its bindings. Nothing is listening until the
 * caller calls `server.listen`.
 */
export async function createAegisServer({
  dataDir,
  publicDir = path.join(here, '..', 'public'),
  adminToken = '',
  sessionSecret = '',
} = {}) {
  if (!dataDir) throw new Error('A data directory is required.');

  const env = {
    DB: await openD1(path.join(dataDir, 'aegis.sqlite')),
    FILES: createFileStore(path.join(dataDir, 'files')),
    ASSETS: createAssetStore(publicDir),
  };
  if (adminToken) env.ADMIN_TOKEN = adminToken;
  if (sessionSecret) env.SESSION_SECRET = sessionSecret;

  const server = createServer((request, response) => {
    handle(request, response, env).catch((error) => {
      console.error('aegis self-host handler crashed', error);
      if (!response.headersSent) response.statusCode = 500;
      response.end('Aegis server error.');
    });
  });

  return {
    server,
    env,
    close() {
      server.close();
      env.DB.close();
    },
  };
}
