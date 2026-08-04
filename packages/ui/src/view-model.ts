import type {
  EvidenceAssessment,
  EvidenceGrade,
  Improvement,
  ProvenanceClass,
  Sensitivity,
} from '@careerforge/domain';

/**
 * What the Explorer shows, as data.
 *
 * Deliberately separate from both the store that produces it and the HTML that
 * renders it. The view model is the place the two questions the Explorer
 * exists to answer are made explicit:
 *
 *   why do you believe this?          → `grounds`, `interpretation`
 *   what would make it stronger?      → `improvements`
 *
 * Everything else on the screen serves one of those two. A field that serves
 * neither is a field that belongs on a different screen.
 *
 * ── Why this is not a graph ──────────────────────────────────────────────
 *
 * The provenance graph is the mechanism and a bad interface. A node-and-edge
 * view asks a person to learn the schema before they can read their own
 * résumé, and the thing they actually want to know — *should I put this on a
 * CV?* — is nowhere on it. So the traversal is flattened into two lists a
 * person can read in order, and the graph stays where it belongs, underneath.
 */

/** One record standing behind a claim, as a person should see it. */
export interface GroundView {
  readonly id: string;
  /** `observed` · `derived` · `stated` · `grouped`. Never `interpreted`. */
  readonly provenanceClass: ProvenanceClass;
  /** The four-way distinction from Vision.md §7, in words a person reads. */
  readonly classLabel: string;
  readonly label: string;
  readonly detail: string | null;
  readonly sensitivity: Sensitivity | null;
}

export interface ClaimView {
  readonly id: string;
  readonly text: string;
  readonly claimType: string;
  readonly span: readonly [number, number];
  /** What makes it true. Ordered strongest first: stated, derived, observed. */
  readonly grounds: readonly GroundView[];
  /** What shaped its wording. Never a reason to believe it. */
  readonly interpretation: readonly GroundView[];
  /** Suppressed records are counted, never named. */
  readonly withheld: number;
}

export interface AssetView {
  readonly id: string;
  readonly workUnitId: string;
  readonly workUnitTitle: string;
  readonly text: string;
  readonly reviewState: string;
  readonly grade: EvidenceGrade;
  readonly assessment: EvidenceAssessment;
  /** Set when the evidence has moved since the words were written. */
  readonly driftedFrom: EvidenceAssessment | null;
  readonly claims: readonly ClaimView[];
  readonly improvements: readonly Improvement[];
}

/** A work unit with nothing generated yet — still worth showing. */
export interface UnitView {
  readonly id: string;
  readonly title: string;
  readonly recordCount: number;
  readonly occurredAt: string;
  readonly assetCount: number;
  readonly openQuestionCount: number;
}

export interface QuestionView {
  readonly id: string;
  readonly workUnitId: string;
  readonly workUnitTitle: string;
  readonly gapType: string;
  readonly question: string;
  readonly rationale: string;
}

export interface ExplorerView {
  readonly assets: readonly AssetView[];
  readonly units: readonly UnitView[];
  readonly questions: readonly QuestionView[];
  readonly totals: {
    readonly evidence: number;
    readonly units: number;
    readonly assets: number;
    readonly questions: number;
  };
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalPages: number;
  };
}

/**
 * The four-way distinction, spelled out.
 *
 * `Vision.md` §7 promises a user can tell these apart at a glance, and the
 * whole product rests on the last one being visibly different from the other
 * three. Kept as prose rather than a class name because the person reading it
 * has not read the schema and should not have to.
 */
export const CLASS_LABELS: Readonly<Record<ProvenanceClass, string>> = {
  observed: 'Observed — a collector saw this happen',
  derived: 'Computed — CareerForge worked this out from other facts',
  stated: 'You said so — your own answer, in an interview',
  grouped: 'Grouping — how this work was organised, not an observation',
  interpreted: 'AI interpretation — explains the wording, never the truth',
};

/**
 * Strongest first.
 *
 * A person scanning a proof stops after two or three lines, so the two or
 * three most load-bearing records have to be at the top. Their own confirmed
 * answer outranks a computed figure, which outranks a raw observation; the
 * grouping is last because it organises rather than evidences.
 */
const CLASS_ORDER: readonly ProvenanceClass[] = [
  'stated',
  'derived',
  'observed',
  'grouped',
  'interpreted',
];

export function compareGrounds(a: GroundView, b: GroundView): number {
  return (
    CLASS_ORDER.indexOf(a.provenanceClass) - CLASS_ORDER.indexOf(b.provenanceClass) ||
    a.label.localeCompare(b.label)
  );
}

/**
 * How a grade should read to somebody who has never seen one.
 *
 * The word alone is a term of art. The sentence is what a person acts on.
 */
export const GRADE_COPY: Readonly<Record<EvidenceGrade, { title: string; meaning: string }>> = {
  corroborated: {
    title: 'Corroborated',
    meaning: 'More than one independent source records this work.',
  },
  confirmed: {
    title: 'Confirmed',
    meaning: 'You have personally confirmed part of this.',
  },
  observed: {
    title: 'Observed',
    meaning: 'Recorded activity from one source. Nobody has confirmed it.',
  },
  asserted: {
    title: 'Unsupported',
    meaning: 'Nothing currently in your store stands behind this.',
  },
};
