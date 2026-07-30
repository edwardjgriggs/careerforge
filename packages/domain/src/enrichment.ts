import type { EnrichmentId, EnrichmentRunId, EvidenceId, WorkUnitId } from './ids.js';
import type { Instant } from './time.js';

/**
 * Enrichments: AI interpretation, kept structurally apart from fact.
 *
 * Additive and versioned. Re-running produces new rows; prior rows are marked
 * superseded but stay queryable forever, so "how did my resume read before I
 * switched models?" remains answerable. Nothing here can ever write evidence
 * (ADR-0002, ADR-0005).
 */

export const ENRICHMENT_TYPES = [
  'skills',
  'technologies',
  'impact',
  'leadership',
  'keywords',
  'star_candidate',
  'summary',
] as const;

export type EnrichmentType = (typeof ENRICHMENT_TYPES)[number];

export type EnrichmentTargetKind = 'evidence' | 'work_unit';

export interface Enrichment {
  readonly id: EnrichmentId;
  readonly runId: EnrichmentRunId;
  readonly targetKind: EnrichmentTargetKind;
  readonly targetId: EvidenceId | WorkUnitId;
  readonly enrichmentType: EnrichmentType;
  /** Shape depends on `enrichmentType`. Structured output, never prose. */
  readonly value: unknown;
  readonly confidence: number | null;
  readonly supersededBy: EnrichmentId | null;
  readonly recordedAt: Instant;
}

/**
 * Everything needed to reproduce a run.
 *
 * Storing the hashes rather than the prompt keeps sensitive content out of
 * the record while still letting a user ask, years later, why an asset said
 * what it said — including when the model that produced it no longer exists.
 */
export interface EnrichmentRun {
  readonly id: EnrichmentRunId;
  readonly providerId: string;
  readonly model: string;
  readonly paramsHash: string;
  readonly promptTemplate: string;
  readonly promptHash: string;
  readonly inputIds: readonly string[];
  /** Digest of the ordered input content hashes. Cache key and staleness key. */
  readonly inputHash: string;
  /** What the Policy Engine permitted to leave. Never null for remote runs. */
  readonly policyDecisionId: string | null;
  readonly redactionProfile: string;
  readonly startedAt: Instant;
  readonly completedAt: Instant | null;
  readonly status: 'running' | 'completed' | 'failed';
}

/**
 * Whether a previous run can be reused instead of calling a provider again.
 *
 * Identical inputs, template, model, and parameters mean the answer would be
 * identical, so no call is made. Free caching, and the reason a re-run costs
 * nothing.
 */
export function isCacheHit(
  previous: Pick<EnrichmentRun, 'inputHash' | 'promptHash' | 'model' | 'paramsHash' | 'status'>,
  candidate: Pick<EnrichmentRun, 'inputHash' | 'promptHash' | 'model' | 'paramsHash'>,
): boolean {
  return (
    previous.status === 'completed' &&
    previous.inputHash === candidate.inputHash &&
    previous.promptHash === candidate.promptHash &&
    previous.model === candidate.model &&
    previous.paramsHash === candidate.paramsHash
  );
}

/**
 * Whether an enrichment now rests on superseded evidence.
 *
 * Stale enrichments are flagged, never silently reused. An interpretation of
 * a corrected fact is an interpretation of something that is no longer true.
 */
export function isStale(run: Pick<EnrichmentRun, 'inputHash'>, currentInputHash: string): boolean {
  return run.inputHash !== currentInputHash;
}

/** Enrichments are never edited. A newer one supersedes an older one. */
export function supersede(previous: Enrichment, replacementId: EnrichmentId): Enrichment {
  return { ...previous, supersededBy: replacementId };
}
