import type { Migration } from './types.js';

/**
 * The provenance graph, and the records it connects.
 *
 * Four tables arrive together because they are one idea: a claim is only
 * meaningful with its support, support is only meaningful as typed edges, a
 * failed claim is only useful if it becomes a question, and an enrichment must
 * exist in the same graph as fact so that a proof can show the two apart.
 *
 * Enrichment tables land here rather than with the provider that fills them
 * (M9). Without a real enrichment row there is no way to test the rule this
 * milestone exists to enforce — that a model's reading can accompany a claim
 * and never stand behind it.
 */
export const migration0004: Migration = {
  version: 4,
  name: 'provenance',
  up(db) {
    db.exec(`
      -- ── Enrichment: AI interpretation, structurally apart from fact ──────
      CREATE TABLE enrichment_runs (
        id              TEXT PRIMARY KEY,
        provider_id     TEXT NOT NULL,
        model           TEXT NOT NULL,
        params_hash     TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        -- The hash, not the prompt. A user can ask years later why an asset
        -- said what it said without the store keeping the sensitive text that
        -- produced it.
        prompt_hash     TEXT NOT NULL,
        input_ids       TEXT NOT NULL,
        input_hash      TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        finished_at     TEXT
      );

      CREATE TRIGGER enrichment_runs_no_update
        BEFORE UPDATE ON enrichment_runs
        BEGIN
          SELECT RAISE(ABORT, 'enrichment_runs is append-only: write a superseding record instead (ADR-0001)');
        END;

      CREATE TRIGGER enrichment_runs_no_delete
        BEFORE DELETE ON enrichment_runs
        BEGIN
          SELECT RAISE(ABORT, 'enrichment_runs is append-only: write a tombstone instead (ADR-0001)');
        END;

      CREATE TABLE enrichments (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL REFERENCES enrichment_runs(id),
        target_kind     TEXT NOT NULL CHECK (target_kind IN ('evidence','work_unit')),
        target_id       TEXT NOT NULL,
        enrichment_type TEXT NOT NULL,
        value           TEXT NOT NULL,
        confidence      REAL,
        recorded_at     TEXT NOT NULL,
        supersedes      TEXT REFERENCES enrichments(id)
      );

      CREATE TRIGGER enrichments_no_update
        BEFORE UPDATE ON enrichments
        BEGIN
          SELECT RAISE(ABORT, 'enrichments is append-only: write a superseding record instead (ADR-0001)');
        END;

      CREATE TRIGGER enrichments_no_delete
        BEFORE DELETE ON enrichments
        BEGIN
          SELECT RAISE(ABORT, 'enrichments is append-only: write a tombstone instead (ADR-0001)');
        END;

      CREATE INDEX ix_enrichments_target ON enrichments(target_kind, target_id);

      -- ── Assets and claims ────────────────────────────────────────────────
      CREATE TABLE assets (
        id            TEXT PRIMARY KEY,
        asset_type    TEXT NOT NULL,
        work_unit_id  TEXT REFERENCES work_units(id),
        content       TEXT NOT NULL,
        review_state  TEXT NOT NULL CHECK (review_state IN ('draft','reviewed','rejected')),
        recorded_at   TEXT NOT NULL,
        supersedes    TEXT REFERENCES assets(id)
      );

      CREATE TRIGGER assets_no_update
        BEFORE UPDATE ON assets
        BEGIN
          SELECT RAISE(ABORT, 'assets is append-only: write a superseding record instead (ADR-0001)');
        END;

      CREATE TRIGGER assets_no_delete
        BEFORE DELETE ON assets
        BEGIN
          SELECT RAISE(ABORT, 'assets is append-only: write a tombstone instead (ADR-0001)');
        END;

      CREATE TABLE claims (
        id            TEXT PRIMARY KEY,
        asset_id      TEXT NOT NULL REFERENCES assets(id),
        text          TEXT NOT NULL,
        span_start    INTEGER NOT NULL,
        span_end      INTEGER NOT NULL,
        claim_type    TEXT NOT NULL CHECK (claim_type IN ('action','scope','role','metric','outcome')),
        support_state TEXT NOT NULL CHECK (support_state IN ('supported','unsupported','contested')),
        -- Never 'model'. A number in a claim is computed or confirmed, and the
        -- CHECK is the last line of a rule the predicate already enforces.
        metric_source TEXT CHECK (metric_source IN ('derived','user_confirmed')),
        recorded_at   TEXT NOT NULL,
        supersedes    TEXT REFERENCES claims(id)
      );

      CREATE TRIGGER claims_no_update
        BEFORE UPDATE ON claims
        BEGIN
          SELECT RAISE(ABORT, 'claims is append-only: write a superseding record instead (ADR-0001)');
        END;

      CREATE TRIGGER claims_no_delete
        BEFORE DELETE ON claims
        BEGIN
          SELECT RAISE(ABORT, 'claims is append-only: write a tombstone instead (ADR-0001)');
        END;

      CREATE INDEX ix_claims_asset ON claims(asset_id);

      -- ── Gaps: missing information as queryable data ──────────────────────
      CREATE TABLE gaps (
        id            TEXT PRIMARY KEY,
        work_unit_id  TEXT NOT NULL REFERENCES work_units(id),
        gap_type      TEXT NOT NULL CHECK (gap_type IN ('metric','role','scope','outcome','context')),
        question      TEXT NOT NULL,
        rationale     TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('open','answered','declined','stale')),
        answered_by   TEXT REFERENCES evidence(id),
        asked_count   INTEGER NOT NULL DEFAULT 0,
        last_asked_at TEXT,
        recorded_at   TEXT NOT NULL,
        supersedes    TEXT REFERENCES gaps(id)
      );

      CREATE TRIGGER gaps_no_update
        BEFORE UPDATE ON gaps
        BEGIN
          SELECT RAISE(ABORT, 'gaps is append-only: being asked, answered or declined writes a new record (ADR-0013)');
        END;

      CREATE TRIGGER gaps_no_delete
        BEFORE DELETE ON gaps
        BEGIN
          SELECT RAISE(ABORT, 'gaps is append-only: write a tombstone instead (ADR-0001)');
        END;

      CREATE INDEX ix_gaps_unit ON gaps(work_unit_id, gap_type);

      -- ── The graph ────────────────────────────────────────────────────────
      CREATE TABLE provenance_edges (
        id            TEXT PRIMARY KEY,
        from_kind     TEXT NOT NULL CHECK (from_kind IN ('evidence','work_unit','enrichment','claim','asset','gap')),
        from_id       TEXT NOT NULL,
        to_kind       TEXT NOT NULL CHECK (to_kind IN ('evidence','work_unit','enrichment','claim','asset','gap')),
        to_id         TEXT NOT NULL,
        relation      TEXT NOT NULL CHECK (relation IN ('supports','derived_from','grouped_into','interprets','answers','contradicts','supersedes')),
        weight        REAL,
        -- Whether this evidence carries the claim's asserted value, not merely
        -- the fact that the work happened. Only whoever built the edge can
        -- know; the domain does not interpret collector attributes.
        corroborating INTEGER NOT NULL DEFAULT 0,
        recorded_at   TEXT NOT NULL,

        -- An enrichment may explain a claim and may never support one. Stated
        -- here as well as in the domain because this is the distinction the
        -- whole product rests on, and one guard for it is not enough
        -- (ADR-0020).
        CHECK (NOT (relation = 'supports' AND from_kind = 'enrichment')),
        CHECK (NOT (relation = 'supports' AND to_kind <> 'claim')),
        CHECK (NOT (from_kind = to_kind AND from_id = to_id))
      );

      CREATE TRIGGER provenance_edges_no_update
        BEFORE UPDATE ON provenance_edges
        BEGIN
          SELECT RAISE(ABORT, 'provenance_edges is append-only: write a superseding record instead (ADR-0001)');
        END;

      CREATE TRIGGER provenance_edges_no_delete
        BEFORE DELETE ON provenance_edges
        BEGIN
          SELECT RAISE(ABORT, 'provenance_edges is append-only: write a tombstone instead (ADR-0001)');
        END;

      -- Explanation walks backwards, so the incoming index is the hot one.
      CREATE INDEX ix_edges_incoming ON provenance_edges(to_kind, to_id, relation);
      CREATE INDEX ix_edges_outgoing ON provenance_edges(from_kind, from_id, relation);

      CREATE VIEW claims_current AS
        SELECT c.* FROM claims c
        WHERE NOT EXISTS (SELECT 1 FROM claims s WHERE s.supersedes = c.id)
          AND NOT EXISTS (
            SELECT 1 FROM tombstones t WHERE t.target_kind = 'claim' AND t.target_id = c.id
          );

      CREATE VIEW gaps_current AS
        SELECT g.* FROM gaps g
        WHERE NOT EXISTS (SELECT 1 FROM gaps s WHERE s.supersedes = g.id)
          AND NOT EXISTS (
            SELECT 1 FROM tombstones t WHERE t.target_kind = 'gap' AND t.target_id = g.id
          );

      CREATE VIEW enrichments_current AS
        SELECT e.* FROM enrichments e
        WHERE NOT EXISTS (SELECT 1 FROM enrichments s WHERE s.supersedes = e.id)
          AND NOT EXISTS (
            SELECT 1 FROM tombstones t WHERE t.target_kind = 'enrichment' AND t.target_id = e.id
          );

      CREATE VIEW assets_current AS
        SELECT a.* FROM assets a
        WHERE NOT EXISTS (SELECT 1 FROM assets s WHERE s.supersedes = a.id)
          AND NOT EXISTS (
            SELECT 1 FROM tombstones t WHERE t.target_kind = 'asset' AND t.target_id = a.id
          );
    `);
  },
};
