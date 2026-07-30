import type { EvidenceId, WorkUnitId } from './ids.js';
import { maxSensitivity, type Sensitivity } from './sensitivity.js';
import type { Instant } from './time.js';

/**
 * Work Units: the level at which humans describe accomplishments.
 *
 * Measurement forced this. Over 90% of AI session files are sub-minute
 * fragments and only ~8% represent substantive work; Git has the same shape
 * from the other direction, where a feature is forty commits rather than one.
 * Nobody says "I made commit a3f9c2". See ADR-0006.
 */

export const MEMBER_ROLES = ['primary', 'supporting', 'incidental'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export type MemberAssigner = 'strategy' | 'user';

export interface WorkUnit {
  readonly id: WorkUnitId;
  readonly schemaVersion: number;
  readonly title: string;
  readonly occurredAt: Instant;
  readonly occurredEnd: Instant | null;
  readonly projectKey: string | null;
  readonly stream: string | null;
  /** Always the maximum over members. Computed, never independently stored. */
  readonly sensitivity: Sensitivity;
  /** Versioned so grouping stays reproducible: `context-temporal@1`. */
  readonly groupingStrategy: string;
  readonly groupingKey: string;
  /** Set once a human edits membership. Strategies must never touch it. */
  readonly pinned: boolean;
  /** Forward-pointing only; suppression is derived by join (ADR-0013). */
  readonly supersedes: WorkUnitId | null;
}

export const WORK_UNIT_SCHEMA_VERSION = 1;

/**
 * Membership is a record in its own right, not an array on the unit.
 *
 * Many-to-many because one commit can support two accomplishments. Forcing
 * exclusivity would mean choosing which career story an artifact belongs to
 * at collection time, before anyone knows what the stories are.
 */
export interface WorkUnitMember {
  readonly workUnitId: WorkUnitId;
  readonly evidenceId: EvidenceId;
  readonly role: MemberRole;
  readonly assignedBy: MemberAssigner;
  /** Null whenever a human made the call — people do not emit confidences. */
  readonly confidence: number | null;
  readonly recordedAt: Instant;
}

/**
 * A unit is only worth surfacing if it clears a substance threshold.
 *
 * Thresholds are configuration rather than constants because they will be
 * wrong at first and must be tunable without a release. Presence of a commit
 * is its own qualifier: a merged change is a completed piece of work however
 * briefly it took.
 */
export interface SubstanceThreshold {
  readonly minDurationMinutes: number;
  readonly minDistinctArtifacts: number;
  readonly commitQualifiesAlone: boolean;
}

export interface SubstanceSignals {
  readonly durationMinutes: number;
  readonly distinctArtifacts: number;
  readonly hasCommit: boolean;
}

export function meetsThreshold(signals: SubstanceSignals, threshold: SubstanceThreshold): boolean {
  if (threshold.commitQualifiesAlone && signals.hasCommit) return true;
  return (
    signals.durationMinutes >= threshold.minDurationMinutes ||
    signals.distinctArtifacts >= threshold.minDistinctArtifacts
  );
}

/**
 * A work unit is as sensitive as its most sensitive member.
 *
 * Maximum, never minimum or average — one restricted artifact makes the whole
 * unit restricted, and anything else would let a single permissive member
 * downgrade the group.
 */
export function deriveSensitivity(memberSensitivities: readonly Sensitivity[]): Sensitivity {
  return maxSensitivity(memberSensitivities);
}

/**
 * Whether a grouping strategy may rewrite this unit.
 *
 * Without this, improving the algorithm silently destroys curation — the
 * fastest way to lose the trust of someone holding a decade of history here.
 */
export function isRewritable(
  unit: Pick<WorkUnit, 'id' | 'pinned'>,
  suppressed: ReadonlySet<string> = new Set(),
): boolean {
  return !unit.pinned && !suppressed.has(unit.id);
}

/** Membership assigned by a person pins the unit against future strategies. */
export function pinsUnit(member: Pick<WorkUnitMember, 'assignedBy'>): boolean {
  return member.assignedBy === 'user';
}
