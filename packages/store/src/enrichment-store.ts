import {
  createUlidFactory,
  instantFromEpochMillis,
  type EnrichmentType,
  type Instant,
  type Platform,
  type UlidFactory,
} from '@careerforge/domain';
import type { ComparableRun, RunFingerprint, ValidatedResponse } from '@careerforge/enrich';

import type { Db } from './migrations/index.js';
import { ProvenanceStore } from './provenance-store.js';

/**
 * Where enrichment runs and their results are kept.
 *
 * `enrich` has no route to this file — it cannot import the store and cannot
 * import a database driver, enforced by lint. Interpretation is produced
 * there and persisted here, and the separation is what makes "AI never writes
 * evidence" (ADR-0002) a property of the build graph rather than a rule
 * somebody remembers.
 *
 * Nothing in this class writes to `evidence`, `claims`, or a `supports` edge.
 * The only graph edges it creates are `interprets`, which explain a record
 * without ever standing behind it (ADR-0020).
 */

export interface RecordRunInput {
  readonly fingerprint: RunFingerprint;
  readonly target: { readonly kind: 'evidence' | 'work_unit'; readonly id: string };
  readonly enrichmentType: EnrichmentType;
  readonly resolvedModel: string | null;
  readonly policyDecisionId: string | null;
  readonly redactionProfile: string;
  readonly status: 'completed' | 'refused' | 'unusable';
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly validated: ValidatedResponse | null;
  readonly startedAt: Instant;
}

export interface StoredRun extends ComparableRun {
  readonly id: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly enrichmentType: EnrichmentType;
  readonly status: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly rejectedCount: number;
  readonly unknownCitations: readonly string[];
  readonly policyDecisionId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface StoredEnrichment {
  readonly id: string;
  readonly runId: string;
  readonly enrichmentType: EnrichmentType;
  readonly value: unknown;
  readonly basis: readonly string[];
  readonly reviewState: 'unreviewed' | 'accepted' | 'rejected';
  readonly recordedAt: string;
  /** True when the evidence beneath it has moved since the run. */
  readonly stale: boolean;
}

interface RunRow {
  id: string;
  provider_id: string;
  model: string;
  resolved_model: string | null;
  params_hash: string;
  prompt_template: string;
  prompt_hash: string;
  input_ids: string;
  input_hash: string;
  target_kind: string;
  target_id: string;
  enrichment_type: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  rejected_count: number;
  unknown_citations: string;
  policy_decision_id: string | null;
  started_at: string;
  finished_at: string | null;
}

const toRun = (row: RunRow): StoredRun => ({
  id: row.id,
  templateId: row.prompt_template,
  promptHash: row.prompt_hash,
  paramsHash: row.params_hash,
  inputHash: row.input_hash,
  inputIds: JSON.parse(row.input_ids) as string[],
  providerId: row.provider_id,
  model: row.model,
  resolvedModel: row.resolved_model,
  targetKind: row.target_kind,
  targetId: row.target_id,
  enrichmentType: row.enrichment_type as EnrichmentType,
  status: row.status,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  rejectedCount: row.rejected_count,
  unknownCitations: JSON.parse(row.unknown_citations) as string[],
  policyDecisionId: row.policy_decision_id,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export class EnrichmentStore {
  private readonly nextId: UlidFactory;
  private readonly provenance: ProvenanceStore;

  constructor(
    private readonly db: Db,
    private readonly platform: Platform,
  ) {
    this.nextId = createUlidFactory(platform.clock, platform.entropy);
    this.provenance = new ProvenanceStore(db, platform);
  }

  private now(): Instant {
    return instantFromEpochMillis(this.platform.clock());
  }

  /**
   * A completed run that answers this exact request, or null.
   *
   * All five dimensions must match. Anything less would return an answer
   * produced by a different instrument and call it a cache hit, which is the
   * one thing a reproducibility record exists to prevent.
   *
   * Refused and unusable runs are excluded deliberately: a failure must not
   * become permanent by being cached.
   */
  findCached(fingerprint: RunFingerprint): { runId: string; fingerprint: RunFingerprint } | null {
    const row = this.db
      .prepare(
        `SELECT id FROM enrichment_runs
         WHERE input_hash = ? AND prompt_hash = ? AND model = ? AND params_hash = ?
           AND provider_id = ? AND status = 'completed'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(
        fingerprint.inputHash,
        fingerprint.promptHash,
        fingerprint.model,
        fingerprint.paramsHash,
        fingerprint.providerId,
      ) as { id: string } | undefined;

    return row === undefined ? null : { runId: row.id, fingerprint };
  }

  /**
   * Write the run and everything it produced, in one transaction.
   *
   * All or nothing on purpose. A run row without its enrichments would be
   * cached as a success and answer forever with nothing.
   */
  recordRun(input: RecordRunInput): string {
    const runId = this.nextId() as string;
    const items = input.validated?.items ?? [];

    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO enrichment_runs
             (id, provider_id, model, resolved_model, params_hash, prompt_template, prompt_hash,
              input_ids, input_hash, target_kind, target_id, enrichment_type, status,
              policy_decision_id, redaction_profile, input_tokens, output_tokens,
              rejected_count, rejections, unknown_citations, started_at, finished_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          runId,
          input.fingerprint.providerId,
          input.fingerprint.model,
          input.resolvedModel,
          input.fingerprint.paramsHash,
          input.fingerprint.templateId,
          input.fingerprint.promptHash,
          JSON.stringify(input.fingerprint.inputIds),
          input.fingerprint.inputHash,
          input.target.kind,
          input.target.id,
          input.enrichmentType,
          input.status,
          input.policyDecisionId,
          input.redactionProfile,
          input.usage.inputTokens,
          input.usage.outputTokens,
          input.validated?.rejections.length ?? 0,
          JSON.stringify(input.validated?.rejections ?? []),
          JSON.stringify(input.validated?.unknownCitations ?? []),
          input.startedAt,
          this.now(),
        );

      for (const item of items) {
        const enrichmentId = this.nextId() as string;
        this.db
          .prepare(
            `INSERT INTO enrichments
               (id, run_id, target_kind, target_id, enrichment_type, value, confidence,
                recorded_at, supersedes, basis, review_state)
             VALUES (?,?,?,?,?,?,?,?,?,?,'unreviewed')`,
          )
          .run(
            enrichmentId,
            runId,
            input.target.kind,
            input.target.id,
            input.enrichmentType,
            JSON.stringify(item.value),
            null,
            this.now(),
            null,
            JSON.stringify(item.evidence),
          );

        // The enrichment explains the target and the records it read. Both
        // edges are `interprets`, never `supports` — the domain predicate and
        // the well-formedness check both refuse the latter, and this is the
        // only place that could try.
        this.provenance.link({ kind: 'enrichment', id: enrichmentId }, 'interprets', {
          kind: input.target.kind,
          id: input.target.id,
        });
        for (const evidenceId of item.evidence) {
          this.provenance.link({ kind: 'enrichment', id: enrichmentId }, 'interprets', {
            kind: 'evidence',
            id: evidenceId,
          });
        }
      }
    });

    write();
    return runId;
  }

  runById(id: string): StoredRun | null {
    const row = this.db.prepare(`SELECT * FROM enrichment_runs WHERE id = ?`).get(id) as
      RunRow | undefined;
    return row === undefined ? null : toRun(row);
  }

  /** Every run against a target, newest first. The history of what was asked. */
  runsFor(targetId: string, enrichmentType?: EnrichmentType): readonly StoredRun[] {
    const rows = (
      enrichmentType === undefined
        ? this.db
            .prepare(`SELECT * FROM enrichment_runs WHERE target_id = ? ORDER BY id DESC`)
            .all(targetId)
        : this.db
            .prepare(
              `SELECT * FROM enrichment_runs
               WHERE target_id = ? AND enrichment_type = ? ORDER BY id DESC`,
            )
            .all(targetId, enrichmentType)
    ) as RunRow[];
    return rows.map(toRun);
  }

  /**
   * What is currently believed about a target, with staleness resolved.
   *
   * Staleness is computed at read time by re-hashing the evidence the run
   * named, not stored on the row. A flag written at run time would be wrong
   * the moment somebody corrected a record, and silently wrong is worse than
   * absent — a résumé built from a stale interpretation reads exactly like one
   * built from a fresh one.
   */
  currentFor(
    targetId: string,
    currentInputHash: (inputIds: readonly string[]) => string,
    enrichmentType?: EnrichmentType,
  ): readonly StoredEnrichment[] {
    const rows = (
      enrichmentType === undefined
        ? this.db
            .prepare(`SELECT * FROM enrichments_current WHERE target_id = ? ORDER BY id`)
            .all(targetId)
        : this.db
            .prepare(
              `SELECT * FROM enrichments_current
               WHERE target_id = ? AND enrichment_type = ? ORDER BY id`,
            )
            .all(targetId, enrichmentType)
    ) as {
      id: string;
      run_id: string;
      enrichment_type: string;
      value: string;
      basis: string;
      review_state: string;
      recorded_at: string;
    }[];

    const staleness = new Map<string, boolean>();

    return rows.map((row) => {
      let stale = staleness.get(row.run_id);
      if (stale === undefined) {
        const run = this.runById(row.run_id);
        stale = run === null ? true : currentInputHash(run.inputIds) !== run.inputHash;
        staleness.set(row.run_id, stale);
      }
      return {
        id: row.id,
        runId: row.run_id,
        enrichmentType: row.enrichment_type as EnrichmentType,
        value: JSON.parse(row.value) as unknown,
        basis: JSON.parse(row.basis) as string[],
        reviewState: row.review_state as StoredEnrichment['reviewState'],
        recordedAt: row.recorded_at,
        stale,
      };
    });
  }

  /**
   * Record a person's judgement on an interpretation.
   *
   * A superseding row rather than an edit, because the table is append-only
   * and because a review that erased what the model originally said would
   * leave nothing to review against. "I rejected this in March" stays
   * answerable, and so does what was rejected.
   */
  review(enrichmentId: string, reviewState: 'accepted' | 'rejected'): string {
    const row = this.db.prepare(`SELECT * FROM enrichments WHERE id = ?`).get(enrichmentId) as
      | {
          run_id: string;
          target_kind: string;
          target_id: string;
          enrichment_type: string;
          value: string;
          confidence: number | null;
          basis: string;
        }
      | undefined;

    if (row === undefined) throw new Error(`No enrichment ${enrichmentId}.`);

    const id = this.nextId() as string;
    this.db
      .prepare(
        `INSERT INTO enrichments
           (id, run_id, target_kind, target_id, enrichment_type, value, confidence,
            recorded_at, supersedes, basis, review_state)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        row.run_id,
        row.target_kind,
        row.target_id,
        row.enrichment_type,
        row.value,
        row.confidence,
        this.now(),
        enrichmentId,
        row.basis,
        reviewState,
      );
    return id;
  }

  /** Total spend across every run. Answerable, never estimated. */
  usage(): { readonly runs: number; readonly inputTokens: number; readonly outputTokens: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(input_tokens),0) AS input_tokens,
                COALESCE(SUM(output_tokens),0) AS output_tokens
         FROM enrichment_runs`,
      )
      .get() as { runs: number; input_tokens: number; output_tokens: number };
    return { runs: row.runs, inputTokens: row.input_tokens, outputTokens: row.output_tokens };
  }
}
