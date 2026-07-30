import type { AttributeMap } from './attributes.js';
import type { EvidenceId, TombstoneId } from './ids.js';
import type { Sensitivity } from './sensitivity.js';
import type { Attribution } from './subject.js';
import type { Instant } from './time.js';

/**
 * Evidence: one atomic, factual, historical assertion about the subject's
 * work, normalised from exactly one source artifact.
 *
 * It is not an interpretation, not a summary written by a model, not a
 * generated asset, and never mutable. See ADR-0002.
 */

/**
 * Note there is no `ai_enrichment` member.
 *
 * `Vision.md` §7 names four kinds of record and the user-facing four-way
 * distinction is preserved exactly — Evidence Explorer labels all four. But
 * the fourth lives in the enrichment table, so AI output is *physically
 * incapable* of occupying an Evidence row. The most important boundary in the
 * product does not rest on a string column that a bug could set wrongly.
 */
export const EVIDENCE_CLASSES = ['imported', 'derived', 'user_confirmed'] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/**
 * Where evidence sits in the user's world.
 *
 * `projectKey` is the unit of consent (ADR-0009) — a user enables personal
 * work for a cloud provider while client work reaches only a local model —
 * and, with `stream`, the basis of work-unit grouping.
 */
export interface EvidenceContext {
  readonly projectKey: string | null;
  readonly workspace: string | null;
  /** Branch, client, or engagement — whatever separates streams of work. */
  readonly stream: string | null;
}

export interface Evidence {
  readonly id: EvidenceId;
  readonly schemaVersion: number;

  // ── Identity and idempotency ────────────────────────────────────────────
  readonly collectorId: string;
  readonly sourceUri: string;
  readonly naturalKey: string;
  readonly contentHash: string;

  // ── Classification ──────────────────────────────────────────────────────
  /** Namespaced by collector: `git.commit`, `session.fragment`. */
  readonly kind: string;
  readonly evidenceClass: EvidenceClass;
  readonly sensitivity: Sensitivity;

  readonly attribution: Attribution;

  // ── Time ────────────────────────────────────────────────────────────────
  /** When the work happened. Drives every career question. */
  readonly occurredAt: Instant;
  readonly occurredEnd: Instant | null;
  /** When CareerForge learned of it. Drives sync and incremental collection. */
  readonly recordedAt: Instant;

  readonly context: EvidenceContext;

  // ── Content ─────────────────────────────────────────────────────────────
  readonly title: string;
  /**
   * A summary authored *at the source* — a commit message body, a meeting
   * description, a course abstract. Never written by a model; see ADR-0002.
   */
  readonly summary: string | null;
  /** Bounded extract actually used as evidence. */
  readonly excerpt: string | null;
  /** Content-addressed reference into the blob store. Never inline payload. */
  readonly payloadRef: string | null;
  readonly attributes: AttributeMap;

  /** Hint for work-unit grouping. The core groups; collectors only hint. */
  readonly groupingHint: string | null;

  // ── Append-only lineage ─────────────────────────────────────────────────
  readonly supersedes: EvidenceId | null;
  readonly tombstonedBy: TombstoneId | null;

  // ── Provenance of collection itself ─────────────────────────────────────
  readonly collectorVersion: string;
  /** Observed, recorded, and never branched on. See ADR-0010. */
  readonly sourceFormatVersion: string | null;
}

export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * A collector's output before the core assigns identity.
 *
 * Collectors emit drafts; the core mints the id, derives the natural key and
 * content hash, stamps `recordedAt`, and applies policy. A collector has no
 * store handle and cannot bypass classification (invariant I6).
 */
export interface EvidenceDraft {
  readonly collectorId: string;
  readonly sourceUri: string;
  readonly kind: string;
  readonly evidenceClass: EvidenceClass;
  readonly sensitivity: Sensitivity;
  readonly occurredAt: Instant;
  readonly occurredEnd: Instant | null;
  readonly context: EvidenceContext;
  readonly title: string;
  readonly summary: string | null;
  readonly excerpt: string | null;
  readonly payloadRef: string | null;
  readonly attributes: AttributeMap;
  readonly groupingHint: string | null;
  readonly collectorVersion: string;
  readonly sourceFormatVersion: string | null;
}

/** Visible in current views: neither tombstoned nor superseded. */
export function isCurrent(evidence: Evidence, supersededIds: ReadonlySet<string>): boolean {
  return evidence.tombstonedBy === null && !supersededIds.has(evidence.id);
}

export function isTombstoned(evidence: Evidence): boolean {
  return evidence.tombstonedBy !== null;
}

/**
 * Whether a claim may treat this evidence as a fact the user stands behind.
 *
 * `user_confirmed` is the only class carrying a human assertion, which is why
 * `role` claims require it (ADR-0007).
 */
export function isUserConfirmed(evidence: Pick<Evidence, 'evidenceClass'>): boolean {
  return evidence.evidenceClass === 'user_confirmed';
}

/**
 * The correction record that supersedes an earlier one.
 *
 * A user "edit" writes one of these; nothing is mutated in place (ADR-0001).
 * Identity is carried forward — a correction describes the same artifact, so
 * `naturalKey` is unchanged and only `contentHash` differs.
 */
export function correctionOf(
  original: Evidence,
  changes: Partial<Pick<Evidence, 'title' | 'summary' | 'excerpt' | 'attributes' | 'sensitivity'>>,
  minted: { readonly id: EvidenceId; readonly contentHash: string; readonly recordedAt: Instant },
): Evidence {
  return {
    ...original,
    ...changes,
    id: minted.id,
    contentHash: minted.contentHash,
    recordedAt: minted.recordedAt,
    supersedes: original.id,
    tombstonedBy: null,
  };
}
