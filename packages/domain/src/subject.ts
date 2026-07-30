import type { Brand } from './primitives.js';

/**
 * Who a record is about, and who is asserting it.
 *
 * Both are `SELF` for the entire single-user life of the product, and no code
 * branches on them today. They exist so that peer attestation, manager
 * confirmation, and references become a feature rather than a migration of
 * every row ever written. See ADR-0011.
 */
export type IdentityId = Brand<string, 'IdentityId'>;

export const SELF = 'self' as IdentityId;

export interface Identity {
  readonly id: IdentityId;
  readonly displayName: string;
  /**
   * True for the person whose career this store documents. Exactly one
   * identity is the owner; everyone else is a future attester.
   */
  readonly isOwner: boolean;
}

/**
 * The two-field attribution carried by every factual record.
 *
 * Kept as one shape because the pair is meaningless apart: the distinction
 * between "whose work this is" and "who is vouching for it" is the entire
 * substance of attestation, and collapsing them to a single owner field would
 * force exactly the migration ADR-0011 exists to avoid.
 */
export interface Attribution {
  /** The identity this record is about. */
  readonly subjectId: IdentityId;
  /** The identity asserting it. */
  readonly assertedBy: IdentityId;
}

export const SELF_ATTRIBUTION: Attribution = { subjectId: SELF, assertedBy: SELF };

/**
 * True when a record is the subject vouching for their own work — every
 * record today.
 */
export function isSelfAsserted(attribution: Attribution): boolean {
  return attribution.subjectId === attribution.assertedBy;
}

/**
 * True when someone else vouched for this record.
 *
 * Always false today. Present so the provenance layer can already express
 * "confirmed by a third party" without a schema change when attestation
 * arrives.
 */
export function isThirdPartyAttestation(attribution: Attribution): boolean {
  return !isSelfAsserted(attribution);
}
