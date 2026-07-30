import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { migration0001 } from './0001-initial.js';
import type { Db, Migration } from './types.js';

export type { Db, Migration } from './types.js';

/**
 * Every migration, in order. Adding one means appending here.
 *
 * The list is validated at load: versions must start at 1, be contiguous, and
 * be unique. A gap or a duplicate is a merge accident, and catching it here is
 * far better than discovering it on a user's machine mid-upgrade.
 */
export const MIGRATIONS: readonly Migration[] = [migration0001];

for (const [index, migration] of MIGRATIONS.entries()) {
  if (migration.version !== index + 1) {
    throw new Error(
      `Migration list is not contiguous: expected version ${index + 1} at position ${index}, found ${migration.version} (${migration.name}). ` +
        'Two branches probably added a migration with the same number.',
    );
  }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `This database was written by a newer CareerForge (schema ${found}); this build supports ${supported}. ` +
        'Upgrade CareerForge rather than continuing — an older build could corrupt a store a newer one wrote.',
    );
    this.name = 'SchemaTooNewError';
  }
}

export class MigrationFailedError extends Error {
  constructor(
    readonly migration: Migration,
    override readonly cause: unknown,
  ) {
    super(
      `Migration ${migration.version} (${migration.name}) failed and was rolled back. ` +
        `The database is unchanged. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'MigrationFailedError';
  }
}

export function schemaVersion(db: Db): number {
  const result = db.pragma('user_version', { simple: true });
  return typeof result === 'number' ? result : 0;
}

export interface MigrationReport {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly { readonly version: number; readonly name: string }[];
  /** Path to the automatic pre-migration backup, if one was taken. */
  readonly backupPath: string | null;
}

/**
 * Snapshot the database before touching its schema.
 *
 * `VACUUM INTO` produces a consistent single-file copy without stopping
 * writers and without needing a WAL checkpoint dance — the simplest correct
 * option, and atomic from the caller's point of view.
 */
function backup(db: Db, databasePath: string, version: number): string {
  const backupDir = join(dirname(databasePath), 'backups');
  mkdirSync(backupDir, { recursive: true });
  // Named by the schema version being left behind, so the file says what it
  // is without needing a manifest.
  const target = join(backupDir, `careerforge.pre-v${version}.db`);
  // VACUUM INTO refuses to overwrite, so a retried migration would fail on an
  // existing file. Removing it first is safe: the live database is intact,
  // and a stale backup of a schema we already left is worth less than the
  // one we are about to take.
  rmSync(target, { force: true });
  db.prepare('VACUUM INTO ?').run(target);
  return target;
}

/**
 * Bring a database up to the latest schema.
 *
 * Forward-only, one transaction per migration, automatic backup first, and a
 * hard refusal to open anything newer than this build understands. A
 * migration that cannot complete halts and explains itself; it never applies
 * partially and never fails silently. This is the mechanism behind the
 * durability promise in `Vision.md` §14.
 */
export function migrate(
  db: Db,
  databasePath: string | null,
  /**
   * Overridable so the backup and upgrade paths can be exercised with a real
   * additional migration. Every future migration ships with a test that
   * upgrades a database written by the previous version, and that test needs
   * a list to hand the runner.
   */
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationReport {
  const from = schemaVersion(db);
  const latest = migrations.length === 0 ? 0 : migrations[migrations.length - 1]!.version;

  if (from > latest) {
    throw new SchemaTooNewError(from, latest);
  }

  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) {
    return { from, to: from, applied: [], backupPath: null };
  }

  // An empty database has nothing worth backing up, and an in-memory one has
  // nowhere to put it.
  const backupPath = from > 0 && databasePath !== null ? backup(db, databasePath, from) : null;

  const applied: { version: number; name: string }[] = [];
  for (const migration of pending) {
    const run = db.transaction(() => {
      migration.up(db);
      // Inside the transaction: a failure must not leave the version claiming
      // a schema that was rolled back.
      db.pragma(`user_version = ${migration.version}`);
    });
    try {
      run();
    } catch (cause) {
      throw new MigrationFailedError(migration, cause);
    }
    applied.push({ version: migration.version, name: migration.name });
  }

  return { from, to: latest, applied, backupPath };
}
