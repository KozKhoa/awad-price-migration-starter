import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Every instance of every version opens the SAME file. Set DB_PATH to an
// absolute path when you run an older version from a git worktree.
export const DB_PATH = resolve(process.env.DB_PATH ?? 'data/app.db');

export function open(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  return db;
}
