import type { Claim, ClaimType, SupportNode, SupportVerdict } from './claims.js';
import { evaluateSupport } from './claims.js';
import type { EvidenceClass } from './evidence.js';
import type { EnrichmentId, EvidenceId, WorkUnitId } from './ids.js';
import {
  isSupportingRelation,
  MAX_EXPLANATION_DEPTH,
  type ProvenanceEdge,
  type ProvenanceNodeKind,
  type ProvenanceRelation,
} from './provenance.js';

/**
 * Explanation: the answer to "why is this true?"
 *
 * Traversal is the mechanism, not the point. A list of linked records is not a
 * proof — it becomes one when a reader can tell, without knowing how the
 * system works, which parts are things that happened and which parts are a
 * model's reading of them.
 *
 * So an explanation has two sections and they never mix:
 *
 *   grounds         what makes the claim true
 *   interpretation  what shaped how it is worded
 *
 * A résumé bullet produced by an enrichment that synthesised six artifacts is
 * a real and useful fact about the bullet's history. It is not a reason to
 * believe it. Presenting the two in one list is how every AI résumé tool
 * currently on the market launders a guess into a citation.
 */

/**
 * What kind of thing a node in a proof is, epistemically.
 *
 * Deliberately not the same axis as `ProvenanceNodeKind`, which says where a
 * record is stored. This says what standing it has, and it is the vocabulary
 * Evidence Explorer renders — a user should be able to read a proof without
 * learning the schema.
 */
export const PROVENANCE_CLASSES = [
  /** A collector observed it. The original source record. */
  'observed',
  /** CareerForge computed it from other facts. Reproducible. */
  'derived',
  /** The person said so. The only class carrying a human assertion. */
  'stated',
  /** An organising structure over facts, not an observation itself. */
  'grouped',
  /** A model's reading. Explains; never grounds. */
  'interpreted',
] as const;

export type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];

/** Classes that may stand behind a claim. `interpreted` is absent on purpose. */
const GROUNDING_CLASSES: ReadonlySet<ProvenanceClass> = new Set([
  'observed',
  'derived',
  'stated',
  'grouped',
]);

export function isGrounding(provenanceClass: ProvenanceClass): boolean {
  return GROUNDING_CLASSES.has(provenanceClass);
}

/**
 * What the store knows about one node, in display terms.
 *
 * The domain does not read tables. A caller resolves ids to this and the
 * traversal stays pure, testable, and free of SQL (ADR-0012).
 */
export interface NodeDescription {
  readonly kind: ProvenanceNodeKind;
  readonly id: string;
  /** One line a person would recognise: a commit subject, a prompt, a title. */
  readonly label: string;
  /** Where it came from: `git.commit · 2026-05-04`, `claude-opus-5`. */
  readonly detail: string | null;
  /** Only meaningful for evidence; decides `observed` vs `derived` vs `stated`. */
  readonly evidenceClass?: EvidenceClass;
}

/** The graph, as the traversal needs to see it. */
export interface ProvenanceLookup {
  /** Edges pointing *at* this node. Explanation walks backwards. */
  incoming(kind: ProvenanceNodeKind, id: string): readonly ProvenanceEdge[];
  describe(kind: ProvenanceNodeKind, id: string): NodeDescription | null;
}

export interface ExplanationNode {
  readonly kind: ProvenanceNodeKind;
  readonly id: string;
  readonly provenanceClass: ProvenanceClass;
  readonly label: string;
  readonly detail: string | null;
  /** The relation that brought this node into the proof. Null at the root. */
  readonly via: ProvenanceRelation | null;
  readonly depth: number;
  readonly children: readonly ExplanationNode[];
  /**
   * Already shown elsewhere in this proof, so not expanded again.
   *
   * A commit can support two claims and a work unit can hold both; without
   * this the same subtree renders repeatedly and a cycle never terminates.
   */
  readonly repeated: boolean;
}

export interface ExplanationGap {
  readonly id: string;
  readonly question: string;
  readonly gapType: string;
}

export interface Explanation {
  readonly claimId: string;
  readonly text: string;
  readonly claimType: ClaimType;
  /**
   * Recomputed from the graph at explain time, never read from the claim row.
   *
   * A stored verdict is a cached opinion. If evidence has since been
   * tombstoned or superseded, the honest answer is the one the graph gives
   * now — and a user asking "why is this true?" deserves the current answer,
   * not the one that was true when the bullet was generated.
   */
  readonly verdict: SupportVerdict;
  /** What makes the claim true. Never contains an `interpreted` node. */
  readonly grounds: readonly ExplanationNode[];
  /** What shaped the wording. Never counted as support. */
  readonly interpretation: readonly ExplanationNode[];
  /** What is missing, when the claim is not supported. */
  readonly openGaps: readonly ExplanationGap[];
  /** The depth bound was reached; the proof shown is partial. */
  readonly truncated: boolean;
  /**
   * Records that stood behind this claim and can no longer be read.
   *
   * A user who hides or purges evidence should see the proof shrink and the
   * verdict change, not silently keep a sentence that nothing supports any
   * more. Counted rather than named, because naming a purged record would
   * defeat purging it.
   */
  readonly withheld: number;
}

export function classify(node: NodeDescription): ProvenanceClass {
  switch (node.kind) {
    case 'evidence':
      // The three evidence classes are three different epistemic standings,
      // and flattening them would hide the one that matters most: whether a
      // person actually said this.
      if (node.evidenceClass === 'user_confirmed') return 'stated';
      if (node.evidenceClass === 'derived') return 'derived';
      return 'observed';
    case 'work_unit':
      return 'grouped';
    case 'enrichment':
      return 'interpreted';
    case 'claim':
    case 'asset':
    case 'gap':
      // Not facts about the world. They appear in a proof only as the thing
      // being explained, never as a reason to believe it.
      return 'derived';
  }
}

/** Relations that carry a proof backwards towards its grounds. */
const GROUND_RELATIONS: ReadonlySet<ProvenanceRelation> = new Set([
  'supports',
  'grouped_into',
  'derived_from',
  'answers',
]);

interface WalkState {
  readonly lookup: ProvenanceLookup;
  readonly maxDepth: number;
  readonly seen: Set<string>;
  truncated: boolean;
}

const nodeKey = (kind: ProvenanceNodeKind, id: string): string => `${kind}:${id}`;

/**
 * Walk backwards from one node, gathering what stands behind it.
 *
 * Bounded by depth and by a seen-set, so this is safe on a UI path however
 * tangled the graph becomes. A cycle is not an error to reject — a correction
 * chain can legitimately loop back — it is a thing to stop walking.
 */
function walk(
  kind: ProvenanceNodeKind,
  id: string,
  via: ProvenanceRelation | null,
  depth: number,
  state: WalkState,
): ExplanationNode | null {
  const description = state.lookup.describe(kind, id);
  if (description === null) return null;

  const key = nodeKey(kind, id);
  const repeated = state.seen.has(key);
  state.seen.add(key);

  const base = {
    kind,
    id,
    provenanceClass: classify(description),
    label: description.label,
    detail: description.detail,
    via,
    depth,
  };

  if (repeated) return { ...base, children: [], repeated: true };

  if (depth >= state.maxDepth) {
    // Truncated rather than silently complete: a proof that stops early must
    // say so, or a reader will take a partial answer for a whole one.
    if (state.lookup.incoming(kind, id).length > 0) state.truncated = true;
    return { ...base, children: [], repeated: false };
  }

  const children: ExplanationNode[] = [];
  for (const edge of state.lookup.incoming(kind, id)) {
    if (!GROUND_RELATIONS.has(edge.relation)) continue;
    const child = walk(edge.fromKind, edge.fromId, edge.relation, depth + 1, state);
    if (child !== null) children.push(child);
  }

  return { ...base, children, repeated: false };
}

export interface ExplainOptions {
  readonly maxDepth?: number;
  readonly openGaps?: readonly ExplanationGap[];
}

/**
 * Build the proof behind a claim.
 *
 * The support set is derived from the graph rather than passed in, so an
 * explanation cannot disagree with what is actually recorded — which is the
 * only way it is worth showing to somebody about to put it on a résumé.
 */
export function explainClaim(
  claim: Pick<Claim, 'id' | 'text' | 'claimType'>,
  lookup: ProvenanceLookup,
  options: ExplainOptions = {},
): Explanation {
  const maxDepth = options.maxDepth ?? MAX_EXPLANATION_DEPTH;
  const state: WalkState = {
    lookup,
    maxDepth,
    seen: new Set([nodeKey('claim', claim.id)]),
    truncated: false,
  };

  const grounds: ExplanationNode[] = [];
  const interpretation: ExplanationNode[] = [];
  const support: SupportNode[] = [];
  let withheld = 0;

  for (const edge of lookup.incoming('claim', claim.id)) {
    const description = lookup.describe(edge.fromKind, edge.fromId);
    if (description === null) {
      // Cited once and unreadable now: hidden, purged, or superseded away.
      if (isSupportingRelation(edge.relation)) withheld++;
      continue;
    }
    const provenanceClass = classify(description);

    // An enrichment reaches a claim through `interprets`, never `supports`
    // (see `isWellFormed`). Even so, section membership is decided by what a
    // node *is* rather than by which edge carried it — a structural rule and
    // a presentational one, because this is the distinction the whole product
    // rests on and one guard for it is not enough.
    if (provenanceClass === 'interpreted') {
      const node = walk(edge.fromKind, edge.fromId, edge.relation, 1, state);
      if (node !== null) interpretation.push(node);
      continue;
    }

    if (!isSupportingRelation(edge.relation)) continue;

    const node = walk(edge.fromKind, edge.fromId, edge.relation, 1, state);
    if (node !== null) grounds.push(node);
    support.push(toSupportNode(edge, description));
  }

  return {
    claimId: claim.id,
    text: claim.text,
    claimType: claim.claimType,
    verdict: evaluateSupport(claim.claimType, support),
    grounds,
    interpretation,
    openGaps: options.openGaps ?? [],
    truncated: state.truncated,
    withheld,
  };
}

function toSupportNode(edge: ProvenanceEdge, description: NodeDescription): SupportNode {
  const id = edge.fromId as EvidenceId & WorkUnitId & EnrichmentId;
  if (edge.fromKind === 'work_unit') return { kind: 'work_unit', id };
  if (edge.fromKind === 'enrichment') return { kind: 'enrichment', id };
  return {
    kind: 'evidence',
    id,
    evidenceClass: description.evidenceClass ?? 'imported',
    corroborating: edge.corroborating,
  };
}

/**
 * Every node in a proof, flattened. Order is the order a reader meets them.
 *
 * Used by tests to assert what a section may contain, and by exporters that
 * need the set rather than the shape.
 */
export function flatten(nodes: readonly ExplanationNode[]): readonly ExplanationNode[] {
  const out: ExplanationNode[] = [];
  const visit = (node: ExplanationNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}
