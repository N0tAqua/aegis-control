/**
 * Cloudflare R2 shim backed by a directory.
 *
 * The worker stores update release parts through `env.FILES.put/get/delete`, so
 * a local folder is enough on a self-hosted Node server.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

function safePath(root, key) {
  const parts = String(key)
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.' && part !== '..');
  const target = path.resolve(root, ...parts);
  if (target !== path.resolve(root) && !target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error('Invalid file key.');
  }
  return target;
}

async function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (value?.arrayBuffer) return Buffer.from(await value.arrayBuffer());
  throw new Error('Unsupported file payload.');
}

/** Create a bucket-shaped store rooted at `root`. */
export function createFileStore(root) {
  mkdir(root, { recursive: true }).catch(() => {});

  return {
    async put(key, value) {
      const target = safePath(root, key);
      await mkdir(path.dirname(target), { recursive: true });
      const bytes = await toBytes(value);
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, target);
      return { key, size: bytes.byteLength };
    },

    async get(key) {
      const target = safePath(root, key);
      let info;
      try {
        info = await stat(target);
      } catch {
        return null;
      }
      if (!info.isFile()) return null;
      return {
        key,
        size: info.size,
        body: Readable.toWeb(createReadStream(target)),
        async arrayBuffer() {
          const bytes = await readFile(target);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async text() {
          return readFile(target, 'utf8');
        },
      };
    },

    async head(key) {
      try {
        const info = await stat(safePath(root, key));
        return { key, size: info.size };
      } catch {
        return null;
      }
    },

    async delete(key) {
      await rm(safePath(root, key), { force: true });
    },
  };
}
