import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { migrate, schemaVersion, type Db, type MigrationReport } from './migrations/index.js';

/** In-memory marker. Used by tests and by `--dry-run` paths. */
export const IN_MEMORY = ':memory:';

export interface OpenOptions {
  /** Path to the database file, or `IN_MEMORY`. */
  readonly path: string;
  /** Run pending migrations on open. Default true. */
  readonly migrate?: boolean;
  /** Fail instead of creating a new database. Default false. */
  readonly mustExist?: boolean;
}

export interface OpenResult {
  readonly db: Db;
  readonly migration: MigrationReport;
}

/**
 * Open the canonical store.
 *
 * Pragmas are set on every open rather than assumed to persist: `journal_mode`
 * is durable but `foreign_keys` and `busy_timeout` are per-connection, and a
 * connection that forgets them silently loses referential integrity.
 */
export function openDatabase(options: OpenOptions): OpenResult {
  const inMemory = options.path === IN_MEMORY;

  if (!inMemory) mkdirSync(dirname(options.path), { recursive: true });

  const db = new Database(options.path, {
    fileMustExist: options.mustExist === true,
  }) as unknown as Db;

  // WAL: readers never block the writer, and a crash mid-write cannot leave a
  // torn page. Meaningless for an in-memory database.
  if (!inMemory) db.pragma('journal_mode = WAL');

  // NORMAL is the WAL-appropriate setting: durable across process crashes,
  // and only at risk from an OS-level crash. FULL costs an fsync per commit,
  // which is a poor trade for a local batch workload.
  db.pragma('synchronous = NORMAL');

  // Off by default in SQLite, which is a trap: without it the REFERENCES
  // clauses in the schema are documentation rather than constraints.
  db.pragma('foreign_keys = ON');

  // A second process (the UI serving alongside a collection run) should wait
  // rather than fail instantly on a locked database.
  db.pragma('busy_timeout = 5000');

  const migration =
    options.migrate === false
      ? { from: schemaVersion(db), to: schemaVersion(db), applied: [], backupPath: null }
      : migrate(db, inMemory ? null : options.path);

  return { db, migration };
}

export interface IntegrityResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Check the database is not silently corrupt.
 *
 * Run on startup by `doctor`. A store holding a decade of career history
 * should notice damage rather than serve it.
 */
export function checkIntegrity(db: Db): IntegrityResult {
  const rows = db.pragma('integrity_check') as { integrity_check: string }[];
  const problems = rows.map((r) => r.integrity_check).filter((value) => value !== 'ok');

  const foreignKeyProblems = (db.pragma('foreign_key_check') as unknown[]).map(
    (row) => `foreign key violation: ${JSON.stringify(row)}`,
  );

  const all = [...problems, ...foreignKeyProblems];
  return { ok: all.length === 0, problems: all };
}

export function closeDatabase(db: Db): void {
  db.close();
}
