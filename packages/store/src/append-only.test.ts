import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, IN_MEMORY, openDatabase } from './database.js';
import type { Db } from './migrations/index.js';

/**
 * Append-only, enforced by the database itself.
 *
 * The working principle for this milestone: append-only behaviour should be
 * impossible to violate *accidentally*. These tests attack the tables
 * directly with raw SQL — bypassing every repository, every helper, and every
 * good intention — and assert the database refuses.
 *
 * If someone later adds a table without its triggers, the coverage test at
 * the bottom fails. That is the point.
 */

let db: Db;

beforeEach(() => {
  db = openDatabase({ path: IN_MEMORY }).db;
});

afterEach(() => {
  closeDatabase(db);
});

const seedEvidence = (id = 'ev-1') => {
  db.prepare(
    `INSERT INTO evidence (
       id, schema_version, collector_id, source_uri, natural_key, content_hash,
       kind, evidence_class, sensitivity, occurred_at, recorded_at, collector_version
     ) VALUES (?,1,'git','git://r/c/1','nk-${id}','ch','git.commit','imported','confidential',
               '2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z','1.0.0')`,
  ).run(id);
  db.prepare(`INSERT INTO evidence_content (evidence_id, title) VALUES (?, 'Add parser')`).run(id);
};

describe('evidence — the immutable spine', () => {
  it('rejects UPDATE', () => {
    seedEvidence();
    expect(() => db.prepare(`UPDATE evidence SET kind = 'x' WHERE id = 'ev-1'`).run()).toThrow(
      /append-only/,
    );
  });

  it('rejects DELETE', () => {
    seedEvidence();
    expect(() => db.prepare(`DELETE FROM evidence WHERE id = 'ev-1'`).run()).toThrow(/append-only/);
  });

  it('rejects a bulk UPDATE across the whole table', () => {
    seedEvidence('ev-1');
    seedEvidence('ev-2');
    expect(() => db.prepare(`UPDATE evidence SET sensitivity = 'public'`).run()).toThrow(
      /append-only/,
    );
  });

  it('rejects DELETE with no WHERE clause', () => {
    seedEvidence();
    expect(() => db.prepare(`DELETE FROM evidence`).run()).toThrow(/append-only/);
  });

  it('leaves the row untouched after a rejected write', () => {
    seedEvidence();
    try {
      db.prepare(`UPDATE evidence SET kind = 'tampered' WHERE id = 'ev-1'`).run();
    } catch {
      // expected
    }
    const row = db.prepare(`SELECT kind FROM evidence WHERE id = 'ev-1'`).get() as { kind: string };
    expect(row.kind).toBe('git.commit');
  });

  it('names the remedy in the error, not just the refusal', () => {
    seedEvidence();
    expect(() => db.prepare(`UPDATE evidence SET kind='x' WHERE id='ev-1'`).run()).toThrow(
      /superseding record/,
    );
    expect(() => db.prepare(`DELETE FROM evidence WHERE id='ev-1'`).run()).toThrow(/tombstone/);
  });

  it('still permits INSERT — append-only, not read-only', () => {
    expect(() => seedEvidence()).not.toThrow();
    expect(() => seedEvidence('ev-2')).not.toThrow();
  });
});

describe('evidence_content — the destroyable body', () => {
  it('rejects UPDATE: content is never edited in place', () => {
    seedEvidence();
    expect(() =>
      db.prepare(`UPDATE evidence_content SET title = 'x' WHERE evidence_id = 'ev-1'`).run(),
    ).toThrow(/append-only/);
  });

  it('permits DELETE, so redaction can actually remove bytes', () => {
    // ADR-0015: this is why identity and content are separate tables. Without
    // the split, purging would need to drop the triggers — the accidental
    // violation vector this milestone exists to eliminate.
    seedEvidence();
    expect(() =>
      db.prepare(`DELETE FROM evidence_content WHERE evidence_id = 'ev-1'`).run(),
    ).not.toThrow();

    // The spine survives, so provenance stays explicable.
    const spine = db.prepare(`SELECT content_hash FROM evidence WHERE id = 'ev-1'`).get();
    expect(spine).toBeDefined();
  });
});

describe('tombstones and identities', () => {
  it('rejects mutation of tombstones', () => {
    db.prepare(
      `INSERT INTO tombstones (id, target_kind, target_id, scope, recorded_at)
       VALUES ('t1','evidence','ev-1','hidden','2026-07-30T00:00:00.000Z')`,
    ).run();
    expect(() => db.prepare(`UPDATE tombstones SET scope='purged'`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM tombstones`).run()).toThrow(/append-only/);
  });

  it('rejects mutation of identities', () => {
    expect(() => db.prepare(`UPDATE identities SET display_name='x'`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM identities`).run()).toThrow(/append-only/);
  });
});

describe('trigger coverage', () => {
  /** Tables permitted to accept DELETE, with the ADR that says why. */
  const DELETE_ALLOWED = new Set(['evidence_content']); // ADR-0015

  /** Derived data. Rebuilt by `reindex`, never synced, never backed up. */
  const DERIVED = new Set(['evidence_fts']);

  function domainTables(): string[] {
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name).filter((name) => !DERIVED.has(name));
  }

  it('every domain table rejects UPDATE', () => {
    const triggers = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    const missing = domainTables().filter((table) => !triggers.has(`${table}_no_update`));
    expect(missing, 'tables without an UPDATE guard').toEqual([]);
  });

  it('every domain table rejects DELETE unless an ADR permits it', () => {
    const triggers = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    const missing = domainTables().filter(
      (table) => !DELETE_ALLOWED.has(table) && !triggers.has(`${table}_no_delete`),
    );
    expect(missing, 'tables without a DELETE guard').toEqual([]);
  });

  it('found the tables it claims to be checking', () => {
    // Guards the guard: if the discovery query silently returned nothing,
    // both tests above would pass vacuously.
    //
    // This list is meant to need updating. A new table appearing here is the
    // moment to ask whether it belongs inside the append-only model — which
    // is exactly the question `collector_cursors` had to answer in M4.
    expect(domainTables().sort()).toEqual([
      'assets',
      'claims',
      'collector_cursors',
      'consent_grants',
      'enrichment_runs',
      'enrichments',
      'evidence',
      'evidence_content',
      'gaps',
      'identities',
      'policy_decisions',
      'provenance_edges',
      'tombstones',
      'work_unit_members',
      'work_units',
    ]);
  });
});
