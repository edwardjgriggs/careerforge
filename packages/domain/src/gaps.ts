import type { ClaimType, SupportFailureCode } from './claims.js';
import type { EvidenceId, GapId, WorkUnitId } from './ids.js';
import type { Instant } from './time.js';

/**
 * Gaps: missing information as first-class data.
 *
 * The "Missing Information" panel is not UI garnish. When a stronger claim
 * would be warranted but is unsupported, CareerForge asks instead of guessing,
 * and the question it asks is a row. Making gaps queryable is what turns a
 * sparse database from *visibly empty* into *visibly full of answerable
 * questions* — which is how cold start is won.
 */

export const GAP_TYPES = ['metric', 'role', 'scope', 'outcome', 'context'] as const;
export type GapType = (typeof GAP_TYPES)[number];

export const GAP_STATUSES = ['open', 'answered', 'declined', 'stale'] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export interface Gap {
  readonly id: GapId;
  readonly workUnitId: WorkUnitId;
  readonly gapType: GapType;
  /** The question, in plain language, ready to put to the user. */
  readonly question: string;
  /** Why answering it would help. Shown so the ask never feels arbitrary. */
  readonly rationale: string;
  readonly status: GapStatus;
  /** The `user_confirmed` evidence that answered it. */
  readonly answeredBy: EvidenceId | null;
  readonly askedCount: number;
  readonly lastAskedAt: Instant | null;
  /**
   * The earlier gap record this one replaces.
   *
   * Gaps are append-only like everything else (ADR-0013): being asked,
   * answered, or declined writes a new row rather than editing one. The chain
   * is a complete record of the interaction, which is what lets the interview
   * engine know it has already asked twice and been declined.
   */
  readonly supersedes: GapId | null;
}

/**
 * Which kind of gap a failed claim produces.
 *
 * Total over `SupportFailureCode`, so a new failure mode cannot be added
 * without deciding what question it raises — the compiler will insist.
 */
export function gapTypeForFailure(code: SupportFailureCode, claimType: ClaimType): GapType {
  switch (code) {
    case 'role_requires_confirmation':
      return 'role';
    case 'metric_requires_derived_or_confirmed':
      return 'metric';
    case 'scope_requires_corroborating_evidence':
      return 'scope';
    case 'outcome_requires_evidence':
      return 'outcome';
    case 'no_support':
    case 'interpretation_only':
      // Nothing specific is missing — the whole assertion is unfounded, so
      // the useful question is about the work itself.
      return claimType === 'metric' ? 'metric' : 'context';
  }
}

/**
 * Whether a gap may be put to the user again.
 *
 * `Vision.md` §7 requires that CareerForge never ask the same question twice.
 * A declined gap is never re-raised, and an answered one never returns —
 * enforceable here rather than left to the generator to remember.
 */
export function isAskable(gap: Pick<Gap, 'status'>): boolean {
  return gap.status === 'open';
}

/**
 * Whether an existing answer already covers a proposed question.
 *
 * Deduplication happens against stored `user_confirmed` evidence before a gap
 * is ever raised. Answers are reusable across every future asset, which is the
 * mechanism by which the system gets smarter with use.
 */
export function isAlreadyAnswered(
  candidate: Pick<Gap, 'workUnitId' | 'gapType'>,
  existing: readonly Pick<Gap, 'workUnitId' | 'gapType' | 'status'>[],
): boolean {
  return existing.some(
    (gap) =>
      gap.workUnitId === candidate.workUnitId &&
      gap.gapType === candidate.gapType &&
      (gap.status === 'answered' || gap.status === 'declined'),
  );
}

/**
 * Every transition mints a new record superseding the old one.
 *
 * The `id` parameter is not ceremony: it is what keeps gaps inside the
 * append-only model (ADR-0013) instead of carving out an exception for the
 * one table whose state visibly changes.
 */

/** Record that a gap was put to the user. */
export function markAsked(gap: Gap, id: GapId, at: Instant): Gap {
  return {
    ...gap,
    id,
    askedCount: gap.askedCount + 1,
    lastAskedAt: at,
    supersedes: gap.id,
  };
}

/** Record an answer. The answer becomes evidence; the gap closes for good. */
export function markAnswered(gap: Gap, id: GapId, evidenceId: EvidenceId): Gap {
  return { ...gap, id, status: 'answered', answeredBy: evidenceId, supersedes: gap.id };
}

/** The user chose not to answer. Never asked again for this work unit. */
export function markDeclined(gap: Gap, id: GapId): Gap {
  return { ...gap, id, status: 'declined', supersedes: gap.id };
}
