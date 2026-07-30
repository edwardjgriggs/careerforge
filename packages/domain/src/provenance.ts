import type { ProvenanceEdgeId } from './ids.js';
import type { Instant } from './time.js';

/**
 * The provenance graph: what makes Evidence Explorer possible and unsupported
 * claims impossible.
 *
 * Nodes are heterogeneous and live in their own tables; edges are append-only
 * and typed. Asking "why does it say this?" is a bounded reverse traversal,
 * not a heuristic explanation. See ADR-0007.
 */

export const PROVENANCE_NODE_KINDS = [
  'evidence',
  'work_unit',
  'enrichment',
  'claim',
  'asset',
  'gap',
] as const;

export type ProvenanceNodeKind = (typeof PROVENANCE_NODE_KINDS)[number];

export const PROVENANCE_RELATIONS = [
  /** Evidence or a work unit stands behind a claim. The load-bearing edge. */
  'supports',
  /** A derived record was computed from another. */
  'derived_from',
  /** Evidence belongs to a work unit. */
  'grouped_into',
  /** An enrichment interprets a record. Explains; never supports. */
  'interprets',
  /** User-confirmed evidence answers a gap. */
  'answers',
  /** Two records disagree. Surfaced, never silently resolved. */
  'contradicts',
  /** A correction replaces an earlier record. */
  'supersedes',
] as const;

export type ProvenanceRelation = (typeof PROVENANCE_RELATIONS)[number];

export interface ProvenanceEdge {
  readonly id: ProvenanceEdgeId;
  readonly fromKind: ProvenanceNodeKind;
  readonly fromId: string;
  readonly toKind: ProvenanceNodeKind;
  readonly toId: string;
  readonly relation: ProvenanceRelation;
  readonly weight: number | null;
  readonly recordedAt: Instant;
}

/**
 * Maximum traversal depth when explaining a claim.
 *
 * Evidence Explorer sits on a UI path, so the walk is bounded rather than
 * exhaustive. Four hops reaches claim → work unit → evidence → correction,
 * which covers every explanation the product actually renders.
 */
export const MAX_EXPLANATION_DEPTH = 4;

/**
 * Which relations may carry support, and which merely describe.
 *
 * The distinction is the whole point: `interprets` is deliberately absent, so
 * an AI interpretation can accompany a claim and explain it without ever
 * counting as its support.
 */
const SUPPORTING_RELATIONS: ReadonlySet<ProvenanceRelation> = new Set(['supports']);

export function isSupportingRelation(relation: ProvenanceRelation): boolean {
  return SUPPORTING_RELATIONS.has(relation);
}

/**
 * Whether an edge is structurally legal.
 *
 * A cheap, total guard against malformed graphs — a `supports` edge pointing
 * at nothing, or self-referential edges that would make traversal loop.
 */
export function isWellFormed(edge: ProvenanceEdge): boolean {
  if (edge.fromId === '' || edge.toId === '') return false;
  if (edge.fromKind === edge.toKind && edge.fromId === edge.toId) return false;
  if (edge.relation === 'supports' && edge.toKind !== 'claim') return false;
  if (edge.relation === 'answers' && edge.toKind !== 'gap') return false;
  if (edge.relation === 'grouped_into' && edge.toKind !== 'work_unit') return false;
  return true;
}

/** Edges that vouch for a given claim. */
export function supportEdgesFor(
  claimId: string,
  edges: readonly ProvenanceEdge[],
): readonly ProvenanceEdge[] {
  return edges.filter(
    (edge) =>
      edge.toKind === 'claim' && edge.toId === claimId && isSupportingRelation(edge.relation),
  );
}
