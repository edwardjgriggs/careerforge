import {
  assessEvidence,
  evaluateSupport,
  gapTypeForFailure,
  type ClaimType,
  type EvidenceAssessment,
  type GapType,
  type Remedy,
  type SupportingRecord,
  type SupportVerdict,
} from '@careerforge/domain';

import { renderBullet, type PlacedClaim } from './render.js';
import { recordsOutcome, resolveSupport, type CandidateRecord } from './support.js';

/**
 * Work unit → bullet, with the check in the middle.
 *
 * The order is the design:
 *
 *   1. the model proposes typed, cited assertions — never prose
 *   2. each citation resolves to real records, or is dropped
 *   3. each assertion faces `evaluateSupport`, unchanged since M1
 *   4. what fails becomes a question, not a softer sentence
 *   5. the bullet is composed from what survived
 *   6. the evidence behind the result is described
 *
 * Step four is the one that makes this different from every résumé generator
 * that ships today. The usual move on an unsupported claim is to hedge it —
 * "helped lead", "contributed to leading" — which keeps the impression and
 * discards the accountability. Here the claim is removed and its absence is
 * recorded as an open question, so the bullet under-claims and says why.
 *
 * Step five is what makes it mechanical. Because the sentence is composed
 * after the check, a failed claim's words are never placed at all; there is
 * nothing to notice and strip out later.
 */

export interface ProposedClaim {
  readonly text: string;
  readonly claimType: ClaimType;
  readonly evidence: readonly string[];
}

/** A claim the evidence could not carry, and the question it raises. */
export interface DroppedClaim {
  readonly text: string;
  readonly claimType: ClaimType;
  readonly code: string;
  readonly reason: string;
  readonly remedy: Remedy;
  readonly gapType: GapType;
  /** The question to put, ready to show. */
  readonly question: string;
}

export interface SupportedClaim extends PlacedClaim {
  /** Ids whose provenance edge carries `corroborating`. */
  readonly corroboratingIds: readonly string[];
}

export interface GeneratedBullet {
  readonly text: string;
  readonly claims: readonly SupportedClaim[];
  readonly dropped: readonly DroppedClaim[];
  readonly assessment: EvidenceAssessment;
  /** Cited ids that were not in the store or had been withdrawn. */
  readonly unusableCitations: readonly string[];
}

export interface GenerateOptions {
  readonly workUnitId: string;
  readonly available: readonly CandidateRecord[];
  /** Questions already open against this work unit. */
  readonly openQuestionCount: number;
}

/**
 * The question a dropped claim raises.
 *
 * Taken from the remedy the predicate already produced wherever there is one.
 * `evaluateSupport` decided what was missing; inventing a second phrasing here
 * would mean two vocabularies for the same refusal, one of which drifts.
 */
function questionFor(verdict: Extract<SupportVerdict, { supported: false }>, text: string): string {
  if (verdict.remedy.kind === 'confirm') return verdict.remedy.question;
  if (verdict.remedy.kind === 'evidence') {
    return `What evidence shows "${text}"? ${verdict.remedy.detail}`;
  }
  return verdict.reason;
}

/**
 * Check a set of proposed claims and compose what survives.
 *
 * Pure. Takes the records rather than a store, so the fabrication-resistance
 * tests — the most important in the project — run against hand-built evidence
 * with no database, no provider, and no chance of an incidental pass.
 */
export function generateBullet(
  proposals: readonly ProposedClaim[],
  options: GenerateOptions,
): GeneratedBullet {
  const available = new Map(options.available.map((record) => [record.id, record]));

  const surviving: (PlacedClaim & { corroboratingIds: readonly string[] })[] = [];
  const dropped: DroppedClaim[] = [];
  const unusable = new Set<string>();
  const usedIds = new Set<string>();

  const renderable: {
    text: string;
    claimType: ClaimType;
    evidence: readonly string[];
    corroborating: boolean;
    corroboratingIds: readonly string[];
  }[] = [];

  for (const proposal of proposals) {
    const resolved = resolveSupport(
      proposal.text,
      proposal.claimType,
      proposal.evidence,
      available,
      options.workUnitId,
    );
    for (const id of resolved.unusableIds) unusable.add(id);

    const verdict = evaluateSupport(proposal.claimType, resolved.nodes);
    if (!verdict.supported) {
      dropped.push({
        text: proposal.text,
        claimType: proposal.claimType,
        code: verdict.code,
        reason: verdict.reason,
        remedy: verdict.remedy,
        gapType: gapTypeForFailure(verdict.code, proposal.claimType),
        question: questionFor(verdict, proposal.text),
      });
      continue;
    }

    const cited = proposal.evidence.filter((id) => !resolved.unusableIds.includes(id));
    for (const id of cited) usedIds.add(id);

    renderable.push({
      text: proposal.text,
      claimType: proposal.claimType,
      evidence: cited,
      corroborating: resolved.corroboratingIds.length > 0,
      corroboratingIds: resolved.corroboratingIds,
    });
  }

  const rendered = renderBullet(renderable);
  for (const [index, placed] of rendered.claims.entries()) {
    surviving.push({ ...placed, corroboratingIds: renderable[index]?.corroboratingIds ?? [] });
  }

  // The assessment describes the evidence behind what survived, not everything
  // the work unit contains. A bullet resting on two of forty records is backed
  // by two, and counting the other thirty-eight would flatter it.
  const supporting: SupportingRecord[] = [...usedIds]
    .map((id) => available.get(id))
    .filter((record): record is CandidateRecord => record !== undefined)
    .map((record) => ({
      id: record.id,
      collectorId: record.collectorId,
      evidenceClass: record.evidenceClass,
      corroborating: surviving.some((claim) => claim.corroboratingIds.includes(record.id)),
      suppressed: record.suppressed,
      recordsOutcome: recordsOutcome(record),
    }));

  return {
    text: rendered.text,
    claims: surviving,
    dropped,
    assessment: assessEvidence({
      claimTypes: surviving.map((claim) => claim.claimType),
      support: supporting,
      droppedClaimTypes: dropped.map((claim) => claim.claimType),
      openQuestionCount: options.openQuestionCount + dropped.length,
    }),
    unusableCitations: [...unusable].sort(),
  };
}

/**
 * Whether a bullet is worth recording.
 *
 * An empty bullet is a real and correct outcome for a work unit whose evidence
 * carries nothing — and it must not be stored as an asset, because an asset
 * with no text is something a user would later find and wonder about. The
 * dropped claims and their questions are the useful product in that case.
 */
export function isPublishable(bullet: GeneratedBullet): boolean {
  return bullet.claims.length > 0;
}
