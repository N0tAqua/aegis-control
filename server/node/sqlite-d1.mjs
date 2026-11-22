/**
 * Cloudflare D1 shim backed by a SQLite file.
 *
 * The hosted worker talks to D1 through `env.DB.prepare(sql).bind(...).first()`,
 * `.all()` and `.run()`. This module implements exactly that surface on top of
 * the SQLite driver built into Node (22.5+, stable in 24), so the same
 * `server/worker.js` can run on a plain Node host such as Wispbyte where there
 * is no D1 binding.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

function normalise(params) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.getTime();
    return value;
  });
}

async function loadDriver() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return (file) => {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      return {
        get: (sql, params) => db.prepare(sql).get(...normalise(params)) ?? null,
        all: (sql, params) => db.prepare(sql).all(...normalise(params)),
        run: (sql, params) => db.prepare(sql).run(...normalise(params)),
        close: () => db.close(),
      };
    };
  } catch {
    // Older Node builds ship without node:sqlite.
  }

  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default ?? mod;
    return (file) => {
      const db = new Database(file);
      db.pragma('journal_mode = WAL');
      return {
        get: (sql, params) => db.prepare(sql).get(...normalise(params)) ?? null,
        all: (sql, params) => db.prepare(sql).all(...normalise(params)),
        run: (sql, params) => db.prepare(sql).run(...normalise(params)),
        close: () => db.close(),
      };
    };
  } catch {
    // No fallback installed.
  }

  throw new Error(
    'This Node version has no SQLite support. Use Node 24 (or newer) on the host, or run "npm install better-sqlite3".',
  );
}

function statement(db, sql) {
  let bound = [];
  const api = {
    bind(...args) {
      bound = args;
      return api;
    },
    async first() {
      return db.get(sql, bound);
    },
    async all() {
      const results = db.all(sql, bound);
      return { success: true, results, meta: { changes: 0, rows_read: results.length } };
    },
    async run() {
      const info = db.run(sql, bound) ?? {};
      return {
        success: true,
        results: [],
        meta: {
          changes: Number(info.changes ?? 0),
          last_row_id: Number(info.lastInsertRowid ?? 0),
        },
      };
    },
  };
  return api;
}

/** Open (or create) the SQLite file and return a D1-shaped binding. */
export async function openD1(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const create = await loadDriver();
  const db = create(file);

  return {
    prepare(sql) {
      return statement(db, sql);
    },
    // Not used by the worker, but handy when debugging the archive by hand.
    exec(sql) {
      db.run(sql, []);
      return { success: true };
    },
    close() {
      db.close();
    },
  };
}
