import type { TombstoneId } from './ids.js';
import type { ProvenanceNodeKind } from './provenance.js';
import type { Instant } from './time.js';

/**
 * Tombstones: deletion without destroying history.
 *
 * Nothing is ever removed by `DELETE`. A user "delete" writes one of these,
 * and every read path excludes what it suppresses. See ADR-0001.
 */

export const TOMBSTONE_SCOPES = [
  /** Suppressed everywhere. Bytes retained; fully reversible. */
  'hidden',
  /** Excerpt and payload cleared; the record's existence remains visible. */
  'redacted',
  /** Bytes actually removed. Irreversible. */
  'purged',
] as const;

export type TombstoneScope = (typeof TOMBSTONE_SCOPES)[number];

export interface Tombstone {
  readonly id: TombstoneId;
  readonly targetKind: ProvenanceNodeKind;
  readonly targetId: string;
  readonly reason: string | null;
  readonly scope: TombstoneScope;
  readonly recordedAt: Instant;
}

/**
 * `purged` is the one case where bytes leave — required for leaked
 * credentials and third-party personal data that must not persist.
 *
 * The tombstone itself always survives, so provenance stays explicable
 * ("evidence removed at user request") instead of silently dangling.
 */
export function destroysContent(scope: TombstoneScope): boolean {
  return scope === 'purged' || scope === 'redacted';
}

export function isReversible(scope: TombstoneScope): boolean {
  return scope === 'hidden';
}

/**
 * Whether a tombstone hides a record from ordinary reads.
 *
 * True for every scope: a redacted or purged record has lost its content, so
 * it can no longer support a claim, and surfacing it would imply evidence
 * that is no longer there.
 */
export function suppressesFromReads(_scope: TombstoneScope): boolean {
  return true;
}

/**
 * Ids suppressed by a set of tombstones, for filtering current views.
 *
 * Every read path derives its exclusions from here rather than reimplementing
 * the rule. A tombstone that leaks into an exported resume is the failure
 * this centralisation exists to prevent.
 */
export function suppressedIds(tombstones: readonly Tombstone[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const tombstone of tombstones) {
    if (suppressesFromReads(tombstone.scope)) ids.add(tombstone.targetId);
  }
  return ids;
}
