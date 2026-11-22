/**
 * Static asset shim: serves `server/public` (the dashboard) where the hosted
 * worker uses the Cloudflare ASSETS binding.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function createAssetStore(root) {
  const base = path.resolve(root);

  return {
    async fetch(request) {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const target = path.resolve(base, relative || 'index.html');

      if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
        return new Response('Not found', { status: 404 });
      }

      let file = target;
      try {
        const info = await stat(file);
        if (info.isDirectory()) file = path.join(file, 'index.html');
      } catch {
        return new Response('Not found', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }

      try {
        const info = await stat(file);
        return new Response(Readable.toWeb(createReadStream(file)), {
          headers: {
            'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            'content-length': String(info.size),
            'cache-control': 'no-cache',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}
