import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkIntegrity, closeDatabase, IN_MEMORY, openDatabase } from './database.js';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationFailedError,
  migrate,
  schemaVersion,
  SchemaTooNewError,
  type Db,
  type Migration,
} from './migrations/index.js';

/**
 * Migrations, and the harness every future migration inherits.
 *
 * `Vision.md` §14 promises that a decade of career history survives upgrades,
 * and that a migration which cannot complete automatically halts rather than
 * damaging anything. That promise rests entirely on this file. An untested
 * migration is the fastest route to breaking the only guarantee that matters.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-migrations-'));
});

afterEach(() => {
  // Windows holds a lock until every handle closes, and a failing test can
  // leave one open. Cleanup failure must not mask the real assertion.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp directory; the OS will reclaim it.
  }
});

const dbPath = () => join(dir, 'careerforge.db');

describe('the migration list itself', () => {
  it('is contiguous and starts at 1', () => {
    // Validated at module load too; asserted here so the failure is a test
    // rather than an import error nobody can read.
    MIGRATIONS.forEach((migration, index) => {
      expect(migration.version, `position ${index}`).toBe(index + 1);
    });
  });

  it('has unique names', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('agrees with the reported latest version', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });
});

describe('applying migrations', () => {
  it('brings a new database to the latest schema', () => {
    const { db, migration } = openDatabase({ path: dbPath() });
    expect(migration.from).toBe(0);
    expect(migration.to).toBe(LATEST_SCHEMA_VERSION);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    closeDatabase(db);
  });

  it('is a no-op on an already-current database', () => {
    const first = openDatabase({ path: dbPath() });
    closeDatabase(first.db);

    const second = openDatabase({ path: dbPath() });
    expect(second.migration.applied).toEqual([]);
    expect(second.migration.backupPath).toBeNull();
    closeDatabase(second.db);
  });

  it('produces a structurally sound database', () => {
    const { db } = openDatabase({ path: dbPath() });
    expect(checkIntegrity(db)).toEqual({ ok: true, problems: [] });
    closeDatabase(db);
  });

  it('seeds exactly one owner identity', () => {
    const { db } = openDatabase({ path: dbPath() });
    const rows = db.prepare(`SELECT id, is_owner FROM identities`).all() as {
      id: string;
      is_owner: number;
    }[];
    expect(rows).toEqual([{ id: 'self', is_owner: 1 }]);
    closeDatabase(db);
  });

  it('enables foreign keys, which SQLite leaves off by default', () => {
    const { db } = openDatabase({ path: dbPath() });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    closeDatabase(db);
  });

  it('is deterministic: two fresh databases have identical schemas', () => {
    const schemaOf = (path: string): string => {
      const { db } = openDatabase({ path });
      const rows = db
        .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
        .all() as { type: string; name: string; sql: string | null }[];
      closeDatabase(db);
      return JSON.stringify(rows);
    };
    expect(schemaOf(join(dir, 'a.db'))).toBe(schemaOf(join(dir, 'b.db')));
  });
});

describe('failure is safe', () => {
  const exploding: Migration = {
    version: LATEST_SCHEMA_VERSION + 1,
    name: 'deliberately-broken',
    up(db) {
      db.exec(`CREATE TABLE half_applied (id TEXT PRIMARY KEY)`);
      throw new Error('simulated failure partway through');
    },
  };

  function applyTo(db: Db, migration: Migration): void {
    const run = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    try {
      run();
    } catch (cause) {
      throw new MigrationFailedError(migration, cause);
    }
  }

  it('rolls back everything a failed migration did', () => {
    const { db } = openDatabase({ path: dbPath() });
    expect(() => applyTo(db, exploding)).toThrow(MigrationFailedError);

    const leftovers = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'half_applied'`)
      .all();
    expect(leftovers, 'a failed migration left a table behind').toEqual([]);
    closeDatabase(db);
  });

  it('does not advance the schema version when a migration fails', () => {
    const { db } = openDatabase({ path: dbPath() });
    const before = schemaVersion(db);
    expect(() => applyTo(db, exploding)).toThrow();
    expect(schemaVersion(db)).toBe(before);
    closeDatabase(db);
  });

  it('explains that the database is unchanged', () => {
    const { db } = openDatabase({ path: dbPath() });
    expect(() => applyTo(db, exploding)).toThrow(/rolled back/);
    expect(() => applyTo(db, exploding)).toThrow(/unchanged/);
    closeDatabase(db);
  });

  it('refuses to open a database from a newer CareerForge', () => {
    // A stale install must never touch a store a newer build wrote.
    const { db } = openDatabase({ path: dbPath() });
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 99}`);
    expect(() => migrate(db, dbPath())).toThrow(SchemaTooNewError);
    expect(() => migrate(db, dbPath())).toThrow(/Upgrade CareerForge/);
    closeDatabase(db);
  });
});

describe('backups', () => {
  /** A migration that only adds a table, for exercising the upgrade path. */
  const additive: Migration = {
    version: LATEST_SCHEMA_VERSION + 1,
    name: 'adds-a-table',
    up(db) {
      db.exec(`CREATE TABLE later_addition (id TEXT PRIMARY KEY)`);
    },
  };

  it('snapshots the database before changing its schema', () => {
    const path = dbPath();
    const { db } = openDatabase({ path });
    db.prepare(
      `INSERT INTO evidence (id, schema_version, collector_id, source_uri, natural_key,
         content_hash, kind, evidence_class, sensitivity, occurred_at, recorded_at, collector_version)
       VALUES ('ev-1',1,'git','u','nk','ch','git.commit','imported','public',
               '2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z','1.0.0')`,
    ).run();

    // A newer build arriving with one more migration. The real runner, not a
    // simulation of it.
    const report = migrate(db, path, [...MIGRATIONS, additive]);
    closeDatabase(db);

    expect(report.from).toBe(LATEST_SCHEMA_VERSION);
    expect(report.applied.map((a) => a.name)).toEqual(['adds-a-table']);
    expect(report.backupPath).not.toBeNull();
    expect(existsSync(report.backupPath!)).toBe(true);

    // The backup is a real, openable database holding the pre-migration
    // state — data present, new table absent.
    const restored = openDatabase({ path: report.backupPath!, migrate: false });
    const row = restored.db.prepare(`SELECT id FROM evidence`).get() as { id: string };
    expect(row.id).toBe('ev-1');
    expect(
      restored.db.prepare(`SELECT name FROM sqlite_master WHERE name='later_addition'`).all(),
    ).toEqual([]);
    expect(schemaVersion(restored.db)).toBe(LATEST_SCHEMA_VERSION);
    closeDatabase(restored.db);
  });

  it('names the backup for the schema version it preserves', () => {
    const path = dbPath();
    const { db } = openDatabase({ path });
    const report = migrate(db, path, [...MIGRATIONS, additive]);
    closeDatabase(db);
    expect(report.backupPath).toContain(`pre-v${LATEST_SCHEMA_VERSION}`);
  });

  it('overwrites a stale backup rather than failing a retried migration', () => {
    // VACUUM INTO refuses to overwrite an existing file, so a second upgrade
    // would fail on the leftover from the first if the runner did not clear
    // it. Two successive migrations against one connection, so the version
    // guard is never asked to open a future schema with an older list.
    const path = dbPath();
    const second: Migration = {
      version: LATEST_SCHEMA_VERSION + 2,
      name: 'adds-another-table',
      up(db) {
        db.exec(`CREATE TABLE second_addition (id TEXT PRIMARY KEY)`);
      },
    };

    const { db } = openDatabase({ path });
    try {
      const first = migrate(db, path, [...MIGRATIONS, additive]);
      expect(first.applied.map((a) => a.name)).toEqual(['adds-a-table']);
      expect(existsSync(first.backupPath!)).toBe(true);

      const next = migrate(db, path, [...MIGRATIONS, additive, second]);
      expect(next.applied.map((a) => a.name)).toEqual(['adds-another-table']);
      expect(existsSync(next.backupPath!)).toBe(true);
      expect(next.backupPath).not.toBe(first.backupPath);
    } finally {
      closeDatabase(db);
    }
  });

  it('takes no backup for a brand-new database — there is nothing to lose', () => {
    const { migration, db } = openDatabase({ path: dbPath() });
    expect(migration.from).toBe(0);
    expect(migration.backupPath).toBeNull();
    closeDatabase(db);
  });

  it('takes no backup for an in-memory database', () => {
    const { migration, db } = openDatabase({ path: IN_MEMORY });
    expect(migration.backupPath).toBeNull();
    closeDatabase(db);
  });
});

describe('the fixture harness', () => {
  /**
   * Every future migration ships with a test that migrates a real database
   * written by the previous version. This is that harness, exercised now with
   * the only version that exists so it is proven before it is needed.
   */
  it('migrates a database created by an earlier build', () => {
    const fixturePath = join(dir, 'fixture.db');

    // Stand in for "a database written by the previous release": create it,
    // put real data in it, close it.
    const original = openDatabase({ path: fixturePath });
    original.db
      .prepare(
        `INSERT INTO evidence (id, schema_version, collector_id, source_uri, natural_key,
           content_hash, kind, evidence_class, sensitivity, occurred_at, recorded_at, collector_version)
         VALUES ('ev-old',1,'git','u','nk','ch','git.commit','imported','public',
                 '2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z','0.0.1')`,
      )
      .run();
    original.db
      .prepare(`INSERT INTO evidence_content (evidence_id, title) VALUES ('ev-old','Ancient work')`)
      .run();
    const before = readFileSync(fixturePath).byteLength;
    closeDatabase(original.db);
    expect(before).toBeGreaterThan(0);

    // Re-open with the current build. Data survives; integrity holds.
    const upgraded = openDatabase({ path: fixturePath });
    expect(schemaVersion(upgraded.db)).toBe(LATEST_SCHEMA_VERSION);
    const row = upgraded.db
      .prepare(`SELECT title FROM evidence_current WHERE id = 'ev-old'`)
      .get() as { title: string };
    expect(row.title).toBe('Ancient work');
    expect(checkIntegrity(upgraded.db).ok).toBe(true);
    closeDatabase(upgraded.db);
  });

  it('refuses to create a database when told it must already exist', () => {
    expect(() => openDatabase({ path: join(dir, 'absent.db'), mustExist: true })).toThrow();
  });
});
