import type { Migration } from './types.js';

/**
 * Initial schema: identities, evidence, evidence content, tombstones.
 *
 * Deliberately not the whole domain. Work units, provenance, claims, gaps,
 * enrichments, and assets each arrive with the milestone that uses them, so
 * every table is designed against working code rather than against a guess —
 * and the migration harness gets exercised repeatedly instead of once.
 */

/**
 * Append-only enforcement.
 *
 * Not a convention, not a code review item: a trigger. `UPDATE` and `DELETE`
 * raise, so violating the model requires deliberately editing the schema
 * rather than forgetting a rule. See ADR-0001 and ADR-0013.
 */
function appendOnly(table: string, options: { readonly allowDelete?: boolean } = {}): string {
  const statements = [
    `CREATE TRIGGER ${table}_no_update
       BEFORE UPDATE ON ${table}
       BEGIN
         SELECT RAISE(ABORT, '${table} is append-only: write a superseding record instead (ADR-0001)');
       END;`,
  ];
  if (options.allowDelete !== true) {
    statements.push(
      `CREATE TRIGGER ${table}_no_delete
         BEFORE DELETE ON ${table}
         BEGIN
           SELECT RAISE(ABORT, '${table} is append-only: write a tombstone instead (ADR-0001)');
         END;`,
    );
  }
  return statements.join('\n');
}

export const migration0001: Migration = {
  version: 1,
  name: 'initial',
  up(db) {
    db.exec(`
      -- ── Identities ──────────────────────────────────────────────────────
      -- One row ('self') for the entire single-user life of the product.
      -- Present from the first migration so peer attestation is a feature
      -- rather than a migration of every row ever written. See ADR-0011.
      CREATE TABLE identities (
        id            TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL,
        is_owner      INTEGER NOT NULL CHECK (is_owner IN (0, 1)),
        recorded_at   TEXT NOT NULL
      );
      ${appendOnly('identities')}

      -- ── Evidence: the immutable spine ───────────────────────────────────
      -- Never updated, never deleted, no exceptions. The historical fact that
      -- something was collected, from here, at this time, with this content
      -- hash, is permanent. Destroyable content lives next door. See ADR-0015.
      CREATE TABLE evidence (
        id                     TEXT PRIMARY KEY,
        schema_version         INTEGER NOT NULL,

        collector_id           TEXT NOT NULL,
        source_uri             TEXT NOT NULL,
        natural_key            TEXT NOT NULL,
        content_hash           TEXT NOT NULL,

        kind                   TEXT NOT NULL,
        evidence_class         TEXT NOT NULL
                                 CHECK (evidence_class IN ('imported','derived','user_confirmed')),
        sensitivity            TEXT NOT NULL
                                 CHECK (sensitivity IN ('public','internal','confidential','restricted')),

        subject_id             TEXT NOT NULL DEFAULT 'self' REFERENCES identities(id),
        asserted_by            TEXT NOT NULL DEFAULT 'self' REFERENCES identities(id),

        occurred_at            TEXT NOT NULL,
        occurred_end           TEXT,
        recorded_at            TEXT NOT NULL,

        project_key            TEXT,
        workspace              TEXT,
        stream                 TEXT,

        grouping_hint          TEXT,

        -- Forward-pointing only. There is no tombstoned_by column: setting
        -- one would be an UPDATE. Suppression is derived by join (ADR-0013).
        supersedes             TEXT REFERENCES evidence(id),

        collector_version      TEXT NOT NULL,
        source_format_version  TEXT,

        -- Idempotent collection. Re-collecting an unchanged artifact is a
        -- no-op; changed content inserts a new row that supersedes.
        UNIQUE (natural_key, content_hash)
      );
      ${appendOnly('evidence')}

      CREATE INDEX ix_evidence_occurred      ON evidence(occurred_at);
      CREATE INDEX ix_evidence_project_time  ON evidence(project_key, occurred_at);
      CREATE INDEX ix_evidence_kind          ON evidence(kind);
      CREATE INDEX ix_evidence_grouping      ON evidence(grouping_hint);
      CREATE INDEX ix_evidence_natural       ON evidence(natural_key);
      CREATE INDEX ix_evidence_supersedes    ON evidence(supersedes);
      CREATE INDEX ix_evidence_collector     ON evidence(collector_id);

      -- ── Evidence content: the destroyable body ──────────────────────────
      -- UPDATE is rejected (content is never edited in place; a correction is
      -- a new evidence row), but DELETE is permitted so redaction and purge
      -- can actually remove bytes without any privileged escape hatch.
      CREATE TABLE evidence_content (
        evidence_id  TEXT PRIMARY KEY REFERENCES evidence(id),
        title        TEXT NOT NULL,
        summary      TEXT,
        excerpt      TEXT,
        payload_ref  TEXT,
        attributes   TEXT NOT NULL DEFAULT '{}'
      );
      ${appendOnly('evidence_content', { allowDelete: true })}

      -- ── Tombstones: suppression without destroying history ──────────────
      CREATE TABLE tombstones (
        id           TEXT PRIMARY KEY,
        target_kind  TEXT NOT NULL,
        target_id    TEXT NOT NULL,
        reason       TEXT,
        scope        TEXT NOT NULL CHECK (scope IN ('hidden','redacted','purged')),
        recorded_at  TEXT NOT NULL
      );
      ${appendOnly('tombstones')}

      CREATE INDEX ix_tombstones_target ON tombstones(target_kind, target_id);

      -- ── The only supported read surface ─────────────────────────────────
      -- Base tables are effectively private. Resolving supersession and
      -- suppression in one place is what stops a tombstoned record surfacing
      -- in an exported resume by way of a read path that forgot to check.
      CREATE VIEW evidence_current AS
        SELECT
          e.*,
          c.title,
          c.summary,
          c.excerpt,
          c.payload_ref,
          c.attributes,
          -- Distinguishes "no excerpt was ever captured" from "the excerpt
          -- was purged", which a caller genuinely needs to tell apart.
          CASE WHEN c.evidence_id IS NULL THEN 1 ELSE 0 END AS content_destroyed
        FROM evidence e
        LEFT JOIN evidence_content c ON c.evidence_id = e.id
        WHERE NOT EXISTS (
                SELECT 1 FROM tombstones t
                WHERE t.target_kind = 'evidence' AND t.target_id = e.id
              )
          AND NOT EXISTS (
                -- Superseded only by a successor that is itself visible.
                -- Otherwise suppressing a correction would silently orphan
                -- the record it replaced.
                SELECT 1 FROM evidence s
                WHERE s.supersedes = e.id
                  AND NOT EXISTS (
                        SELECT 1 FROM tombstones t2
                        WHERE t2.target_kind = 'evidence' AND t2.target_id = s.id
                      )
              );

      -- ── Search ──────────────────────────────────────────────────────────
      -- Fully derived: dropped and rebuilt by \`careerforge reindex\`, never
      -- synced, never backed up. Search must work with no AI (ADR-0005), so
      -- FTS5 is the primary path rather than a fallback.
      CREATE VIRTUAL TABLE evidence_fts USING fts5(
        evidence_id UNINDEXED,
        title,
        summary,
        excerpt,
        tokenize = 'unicode61'
      );
    `);

    db.prepare(
      `INSERT INTO identities (id, display_name, is_owner, recorded_at) VALUES (?, ?, 1, ?)`,
    ).run('self', 'Me', new Date(0).toISOString());
  },
};
