import type { Migration } from './types.js';

/**
 * Collector cursors: where each collector got to, per scope.
 *
 * Append-only like everything else. A cursor advance inserts a row rather than
 * updating one, and the current position is the newest row. ULIDs sort by
 * creation, so "newest" is `ORDER BY id DESC LIMIT 1`.
 *
 * Keeping cursors inside the append-only model was cheaper than carving out an
 * exemption for them: a collection run advances a cursor once, so this grows by
 * a few hundred rows a year per scope. The alternative — the first mutable
 * table — would have meant explaining for years why one table is different.
 * It also leaves a record of when collection actually ran, which is exactly
 * what someone debugging "why is my evidence stale?" wants.
 */
export const migration0002: Migration = {
  version: 2,
  name: 'collector-cursors',
  up(db) {
    db.exec(`
      CREATE TABLE collector_cursors (
        id            TEXT PRIMARY KEY,
        collector_id  TEXT NOT NULL,
        scope_key     TEXT NOT NULL,
        cursor        TEXT NOT NULL,
        recorded_at   TEXT NOT NULL,
        supersedes    TEXT REFERENCES collector_cursors(id)
      );

      CREATE TRIGGER collector_cursors_no_update
        BEFORE UPDATE ON collector_cursors
        BEGIN
          SELECT RAISE(ABORT, 'collector_cursors is append-only: write a superseding record instead (ADR-0001)');
        END;

      CREATE TRIGGER collector_cursors_no_delete
        BEFORE DELETE ON collector_cursors
        BEGIN
          SELECT RAISE(ABORT, 'collector_cursors is append-only: write a tombstone instead (ADR-0001)');
        END;

      CREATE INDEX ix_cursors_lookup ON collector_cursors(collector_id, scope_key, id DESC);

      CREATE VIEW collector_cursors_current AS
        SELECT c.*
        FROM collector_cursors c
        WHERE NOT EXISTS (
          SELECT 1 FROM collector_cursors s WHERE s.supersedes = c.id
        );
    `);
  },
};
