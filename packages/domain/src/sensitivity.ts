/**
 * How exposed a piece of evidence may be.
 *
 * Classification lives on the row, not on the source: a session transcript
 * from a client project and one from a personal project have identical
 * provenance and entirely different exposure rules. Row-level classification
 * is what makes per-project consent enforceable. See ADR-0009.
 */
export const SENSITIVITY_LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const;

export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

const RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export function isSensitivity(value: string): value is Sensitivity {
  return Object.prototype.hasOwnProperty.call(RANK, value);
}

export function sensitivityRank(level: Sensitivity): number {
  return RANK[level];
}

/** Negative when `a` is less sensitive than `b`. */
export function compareSensitivity(a: Sensitivity, b: Sensitivity): number {
  return RANK[a] - RANK[b];
}

/**
 * The most restrictive level in a set.
 *
 * Always the maximum, never the minimum or an average. A work unit holding
 * one restricted artifact is restricted; anything else would let a single
 * permissive member downgrade the whole group. An empty set is `public`
 * because there is nothing to protect.
 */
export function maxSensitivity(levels: readonly Sensitivity[]): Sensitivity {
  let highest: Sensitivity = 'public';
  for (const level of levels) {
    if (RANK[level] > RANK[highest]) highest = level;
  }
  return highest;
}

/**
 * Whether evidence at `level` may be sent to a provider permitted up to
 * `granted`.
 *
 * The domain states the rule. It performs no egress and knows nothing about
 * providers, consent storage, or redaction — that is the Policy Engine's
 * work (ADR-0009). Having the comparison here means the rule is testable
 * without a network stack anywhere near it.
 */
export function isPermittedAt(level: Sensitivity, granted: Sensitivity): boolean {
  return RANK[level] <= RANK[granted];
}
