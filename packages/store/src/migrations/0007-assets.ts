import type { Migration } from './types.js';

/**
 * What an asset needs beyond its text.
 *
 * M4 created the table with the parts every generated artifact has: the words,
 * the work unit, the review state, and a supersede chain. Generating for real
 * added three things, and all three are about being able to judge the words
 * later rather than produce them.
 *
 * ── The evidence assessment ──────────────────────────────────────────────
 *
 * A description of how strong the supporting record was when the words were
 * written: how many independent sources, whether the person confirmed
 * anything, whether an outcome was ever observed, which claims had to be
 * dropped. Not model confidence — a number about a model says nothing about
 * whether a sentence belongs on a résumé, and a fluent invention would score
 * as well as a terse truth.
 *
 * Stored *and* recomputed on read. Stored because a consumer needs to know
 * what the evidence looked like at the time; recomputed because evidence
 * moves, and an assessment presented as current when the ground has shifted
 * is the same failure as a stored support verdict (ADR-0020). When they
 * disagree, both are shown.
 *
 * `evidence_grade` is its own column rather than only a key inside the JSON,
 * so "show me everything resting on a single unconfirmed source" is a query
 * rather than a scan.
 *
 * ── Style exemplars ──────────────────────────────────────────────────────
 *
 * A before/after pair from a user edit, used to teach phrasing. Kept in its
 * own table because it is not an asset and must never be mistaken for one:
 * exemplars teach wording and can never introduce a fact.
 */
export const migration0007: Migration = {
  version: 7,
  name: 'assets',
  up(db) {
    db.exec(`
      -- Which run produced these words. Null for an asset a person wrote or
      -- edited, which is the honest answer rather than crediting a model.
      ALTER TABLE assets ADD COLUMN run_id TEXT REFERENCES enrichment_runs(id);

      -- Null unless a person changed the text. The supersede chain records
      -- *that* something replaced something; this records who did it, which is
      -- what separates a regeneration from an edit.
      ALTER TABLE assets ADD COLUMN edited_by TEXT CHECK (edited_by IN ('user'));

      ALTER TABLE assets ADD COLUMN evidence_grade TEXT
        CHECK (evidence_grade IN ('asserted','observed','confirmed','corroborated'));
      ALTER TABLE assets ADD COLUMN assessment TEXT NOT NULL DEFAULT '{}';

      CREATE INDEX ix_assets_unit ON assets(work_unit_id, id DESC);
      CREATE INDEX ix_assets_grade ON assets(evidence_grade);

      CREATE TABLE style_exemplars (
        id          TEXT PRIMARY KEY,
        asset_type  TEXT NOT NULL,
        -- What the system wrote, and what the person changed it to. Only ever
        -- captured when the claim set is unchanged: an edit that alters what
        -- is being asserted is a factual disagreement and goes to the
        -- interview engine instead. Without that split, the style loop would
        -- quietly learn to assert things the evidence never supported.
        before      TEXT NOT NULL,
        after       TEXT NOT NULL,
        asset_id    TEXT NOT NULL REFERENCES assets(id),
        recorded_at TEXT NOT NULL
      );

      CREATE TRIGGER style_exemplars_no_update
        BEFORE UPDATE ON style_exemplars
        BEGIN
          SELECT RAISE(ABORT, 'style_exemplars is append-only: record a new exemplar instead (ADR-0001)');
        END;

      CREATE TRIGGER style_exemplars_no_delete
        BEFORE DELETE ON style_exemplars
        BEGIN
          SELECT RAISE(ABORT, 'style_exemplars is append-only: write a tombstone instead (ADR-0001)');
        END;
    `);
  },
};
