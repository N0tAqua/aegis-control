/**
 * Aegis service address. Accounts, licence keys and update releases live on the
 * server you run, so a key created on one computer works on another.
 *
 * There is deliberately no built-in address: an app with a hard-coded fallback
 * keeps calling a server that no longer exists (or is paused), which looks like
 * "login is broken". Set AEGIS_API_URL, or save the address in
 * %APPDATA%\aegis-control\api-url.txt, and the app uses that. Without one it
 * says so instead of calling anywhere.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the address lives when it is not in the environment. */
export const SERVER_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'aegis-control',
  'api-url.txt',
);

function savedApiUrl() {
  const files = [process.env.AEGIS_API_URL_FILE, SERVER_FILE].filter(Boolean);
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

export const API_URL = String(process.env.AEGIS_API_URL || savedApiUrl())
  .trim()
  .replace(/\/+$/, '');

/** Shown in the app when no address is configured. */
export const API_URL_HELP =
  `No Aegis server address is set. Put your server address, for example ` +
  `http://your-host:14651, in ${SERVER_FILE} (or set AEGIS_API_URL) and start ` +
  `Aegis Control again.`;
