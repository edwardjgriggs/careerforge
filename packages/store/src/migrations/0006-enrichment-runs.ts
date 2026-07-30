import type { Migration } from './types.js';

/**
 * What it takes to make an enrichment reproducible.
 *
 * M4 created `enrichment_runs` with the hashes an interpretation needs to be
 * explicable. Running the pipeline for real showed what was missing, and it
 * was all the same kind of thing: the columns that answer *why is this
 * different from last time?*
 *
 * Five things independently decide an output — the evidence, the prompt, the
 * provider, the model, and the sampling parameters — and every one of them
 * gets its own column so a difference can be attributed rather than merely
 * observed. A single opaque run hash would say two runs differ and nothing
 * about which of the five moved, which is the only question a person actually
 * has.
 *
 * ── `resolved_model`, and why it is separate from `model` ────────────────
 *
 * `model` is what was asked for. `resolved_model` is what the provider says
 * answered. An alias quietly advancing to a newer snapshot is the most common
 * real cause of a changed interpretation, and it is completely invisible in
 * the first column. Recording only the request would make every run record
 * subtly untrue.
 *
 * ── Why a run row is written once, at the end ────────────────────────────
 *
 * These tables are append-only, so a row cannot be inserted as `running` and
 * updated to `completed`. That is not a limitation worked around — it is the
 * right shape. `policy_decisions` already records that egress was *permitted*,
 * written before the call; `enrichment_runs` records what *came back*, written
 * after it. A crashed call therefore leaves a decision with no run, which is a
 * truthful description of what happened rather than a row claiming a status
 * nobody observed.
 */
export const migration0006: Migration = {
  version: 6,
  name: 'enrichment-runs',
  up(db) {
    db.exec(`
      -- Added rather than rebuilt: the table already holds the hashes, and a
      -- table rebuild under an append-only trigger regime is a good way to
      -- lose a decade of history to a typo.
      ALTER TABLE enrichment_runs ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'work_unit';
      ALTER TABLE enrichment_runs ADD COLUMN target_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE enrichment_runs ADD COLUMN enrichment_type TEXT NOT NULL DEFAULT '';

      -- What actually answered, which is routinely more specific than what
      -- was asked for.
      ALTER TABLE enrichment_runs ADD COLUMN resolved_model TEXT;

      -- The decision that permitted this call. Null only for a local provider,
      -- where nothing left the machine and there was nothing to permit.
      ALTER TABLE enrichment_runs ADD COLUMN policy_decision_id TEXT REFERENCES policy_decisions(id);
      ALTER TABLE enrichment_runs ADD COLUMN redaction_profile TEXT NOT NULL DEFAULT '';

      ALTER TABLE enrichment_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
        CHECK (status IN ('completed','refused','unusable'));

      ALTER TABLE enrichment_runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE enrichment_runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;

      -- How much of the answer was thrown away, and why. A run that quietly
      -- discarded half its output while reporting success would be worse than
      -- one that failed outright, so the count travels with the run.
      ALTER TABLE enrichment_runs ADD COLUMN rejected_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE enrichment_runs ADD COLUMN rejections TEXT NOT NULL DEFAULT '[]';
      -- Ids the model cited that were never sent to it. Many of these is a
      -- signal about the prompt, not about the work unit.
      ALTER TABLE enrichment_runs ADD COLUMN unknown_citations TEXT NOT NULL DEFAULT '[]';

      -- The cache key, in the order the lookup uses it. Identical on all five
      -- dimensions means the answer would be the same answer, so no call is
      -- made and a re-run costs nothing.
      CREATE INDEX ix_enrichment_cache
        ON enrichment_runs(input_hash, prompt_hash, model, params_hash, status);

      CREATE INDEX ix_enrichment_runs_target
        ON enrichment_runs(target_kind, target_id, enrichment_type, id DESC);

      -- ── Enrichments cite what they read ──────────────────────────────────
      -- An interpretation that names records it was never shown is discarded
      -- before it reaches here (ADR-0024). What survives records which inputs
      -- it came from, so a reviewer can put the interpretation beside the
      -- evidence rather than beside the whole work unit.
      ALTER TABLE enrichments ADD COLUMN basis TEXT NOT NULL DEFAULT '[]';

      -- Review is what makes an AI output an artifact rather than an
      -- authority. Unreviewed is the honest default and the one every
      -- generated statement starts in.
      -- Superseding is how a review is recorded: the table is append-only, so
      -- accepting or rejecting writes a new row and the enrichments_current
      -- view (M4) resolves it. What the model first said stays queryable, which is
      -- the point — a review that erased the original would leave nothing to
      -- review against.
      ALTER TABLE enrichments ADD COLUMN review_state TEXT NOT NULL DEFAULT 'unreviewed'
        CHECK (review_state IN ('unreviewed','accepted','rejected'));
    `);
  },
};
