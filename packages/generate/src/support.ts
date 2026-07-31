import type { ClaimType, EvidenceClass, SupportNode } from '@careerforge/domain';

/**
 * Resolving what actually stands behind a proposed claim.
 *
 * The model cites record ids. This turns those ids into the support nodes the
 * claim predicate understands — and, for the one question the predicate cannot
 * answer for itself, decides whether a cited record *corroborates* the claim
 * or merely accompanies it.
 */

/** One record the generator may cite, as the store knows it. */
export interface CandidateRecord {
  readonly id: string;
  readonly collectorId: string;
  readonly kind: string;
  readonly evidenceClass: EvidenceClass;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly suppressed: boolean;
}

/**
 * Evidence kinds that record a result rather than the work.
 *
 * Declared and, today, empty in practice: no shipped collector emits any of
 * them. Git records commits and the session collector records conversations,
 * and neither observes what changed in the world afterwards.
 *
 * That is why `outcome_not_evidenced` will be true of almost every real asset
 * this milestone produces, and saying so plainly is the honest position. The
 * alternative — treating a commit as evidence of its own outcome — is exactly
 * the inference that makes résumé tools untrustworthy.
 */
export const OUTCOME_KINDS: readonly string[] = Object.freeze([
  'git.release',
  'git.merge',
  'issue.closed',
  'deploy.completed',
  'incident.resolved',
]);

export function recordsOutcome(record: Pick<CandidateRecord, 'kind'>): boolean {
  return OUTCOME_KINDS.includes(record.kind);
}

/**
 * The numbers a claim asserts.
 *
 * Deliberately crude, and crude in the safe direction: it over-collects
 * candidates, and every one of them then has to be found in the evidence. A
 * cleverer parser that occasionally decided a figure was not a figure would
 * make claims pass corroboration by failing to notice they made one.
 */
export function assertedFigures(text: string): readonly string[] {
  return [...text.matchAll(/\d[\d,._]*\d|\d/g)].map((match) => match[0].replace(/[,_]/g, ''));
}

const flatten = (value: unknown, into: string[]): void => {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const member of value) flatten(member, into);
    return;
  }
  if (typeof value === 'object') {
    for (const member of Object.values(value as Record<string, unknown>)) flatten(member, into);
    return;
  }
  into.push(String(value));
};

/**
 * Whether a record carries the figure a claim asserts.
 *
 * This is the answer `ProvenanceEdge.corroborating` has been waiting for since
 * M7, and it deliberately lives here rather than in the domain: matching
 * depends on a collector's attribute schema, which the domain does not
 * interpret.
 *
 * The rule is strict on purpose. A `scope` claim saying "40 files" is
 * corroborated only by a record whose *attributes* contain 40 — not by one
 * whose prose happens to mention forty of something. Attributes are structured
 * values a collector computed; text is whatever somebody typed, and a claim
 * that matched against text would be corroborated by its own restatement.
 */
export function corroboratesFigures(
  figures: readonly string[],
  record: Pick<CandidateRecord, 'attributes'>,
): boolean {
  if (figures.length === 0) return false;

  const values: string[] = [];
  flatten(record.attributes, values);
  // Array lengths count: a collector recording twelve touched files
  // corroborates "12 files" without needing to have stored the number.
  for (const member of Object.values(record.attributes)) {
    if (Array.isArray(member)) values.push(String(member.length));
  }

  return figures.every((figure) => values.includes(figure));
}

export interface ResolvedSupport {
  readonly nodes: readonly SupportNode[];
  /** Ids that will carry `corroborating` on their provenance edge. */
  readonly corroboratingIds: readonly string[];
  /** Cited ids that are not in the store, or have been withdrawn. */
  readonly unusableIds: readonly string[];
}

/**
 * Turn a claim's citations into support the predicate can judge.
 *
 * Suppressed records are dropped rather than passed through as weak support.
 * Evidence that has been corrected away must not go on justifying a sentence,
 * and a claim that survives only because of a withdrawn record should fail —
 * loudly, and become a question.
 */
export function resolveSupport(
  claimText: string,
  claimType: ClaimType,
  citedIds: readonly string[],
  available: ReadonlyMap<string, CandidateRecord>,
  workUnitId: string,
): ResolvedSupport {
  const nodes: SupportNode[] = [];
  const corroboratingIds: string[] = [];
  const unusableIds: string[] = [];

  // Only a claim that asserts a figure can be corroborated by one. Asking
  // whether an `action` claim's numbers appear in the evidence would attach
  // the flag to claims that make no quantitative assertion at all.
  const figures = claimType === 'scope' || claimType === 'metric' ? assertedFigures(claimText) : [];

  for (const id of citedIds) {
    const record = available.get(id);
    if (record === undefined || record.suppressed) {
      unusableIds.push(id);
      continue;
    }

    const corroborating = figures.length > 0 && corroboratesFigures(figures, record);
    if (corroborating) corroboratingIds.push(id);

    nodes.push({
      kind: 'evidence',
      id: id as never,
      evidenceClass: record.evidenceClass,
      corroborating,
      // Whether this record observes a result rather than the work. The domain
      // cannot know: it depends on the collector's kind vocabulary.
      recordsOutcome: recordsOutcome(record),
    });
  }

  // The work unit is offered alongside the records, never instead of them. It
  // is what lets an `action` claim rest on the grouped work as a whole; it can
  // never satisfy `scope`, `role`, or `metric`, and the predicate is what
  // enforces that rather than this function.
  if (nodes.length > 0) nodes.push({ kind: 'work_unit', id: workUnitId as never });

  return { nodes, corroboratingIds, unusableIds };
}
