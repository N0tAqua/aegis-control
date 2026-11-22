/**
 * Aegis service. Accounts, licence keys and update releases live here, so a key
 * created on one computer works on another.
 *
 * Override with AEGIS_API_URL when testing against the preview deployment, or
 * when the server is self-hosted. A saved address in
 * %APPDATA%\aegis-control\api-url.txt wins over the default so a portable build
 * can be pointed at another server without a launcher script.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function savedApiUrl() {
  const files = [
    process.env.AEGIS_API_URL_FILE,
    path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'aegis-control', 'api-url.txt'),
  ].filter(Boolean);
  for (const file of files) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // No saved address yet.
    }
  }
  return '';
}

export const API_URL = (
  process.env.AEGIS_API_URL ||
  savedApiUrl() ||
  'https://aegis-license-server-6z1s1v.freebuff.site'
).replace(/\/+$/, '');
