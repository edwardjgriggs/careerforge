import type { ClaimType } from './claims.js';
import type { EvidenceClass } from './evidence.js';

/**
 * How strong is the evidence behind this asset?
 *
 * Not how confident a model is. A model's confidence is a number about the
 * model, and attaching one to a career claim manufactures precision about the
 * wrong thing — a fluent invention scores high, and a true statement resting
 * on one commit scores high too. Neither number tells you whether to put the
 * sentence on a résumé.
 *
 * This is a description of the *record*: how many independent sources back it,
 * whether the person confirmed anything, whether an outcome was ever observed.
 * Every field is computed from the provenance graph. Nothing here is asked of
 * a model, and nothing here can be asserted by one.
 *
 * ── Why it is recorded and also recomputed ───────────────────────────────
 *
 * The assessment is stored beside the asset, because a consumer reading an
 * asset a year from now needs to know what the evidence looked like when the
 * words were written. It is also recomputed on read, because evidence moves —
 * a record gets corrected, a gap gets answered, a source gets tombstoned. When
 * the two disagree, both are shown. A stored assessment presented as current
 * would be the same failure as a stored support verdict, which M7 rejected for
 * the same reason (ADR-0020).
 *
 * ── It does not gate generation ──────────────────────────────────────────
 *
 * Deliberately. What may be *claimed* is already decided by `evaluateSupport`,
 * which is a hard rule about individual assertions. This is a description of
 * the whole, for a consumer to reason with. Letting it veto generation would
 * duplicate the claim predicate badly and hide the real reason a bullet is
 * thin, which is that the underlying work was not recorded.
 */

/**
 * The headline grade, ordered weakest to strongest.
 *
 * Four rather than a score, because a number invites arithmetic that means
 * nothing — the difference between `observed` and `corroborated` is not a
 * quantity, and averaging two assets' grades produces a fiction.
 */
export const EVIDENCE_GRADES = ['asserted', 'observed', 'confirmed', 'corroborated'] as const;

export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

export function gradeRank(grade: EvidenceGrade): number {
  return EVIDENCE_GRADES.indexOf(grade);
}

/**
 * Named findings about the evidence, each carrying its own sentence.
 *
 * A closed union, like `Remedy`: a new way for evidence to be strong or weak
 * cannot be added without deciding how to say it to a person. Signals are
 * where the nuance lives — the grade is one word and a résumé bullet resting
 * on one commit from one collector deserves more than one word.
 */
export const EVIDENCE_SIGNALS = [
  /** Two or more collectors independently record this work. */
  'multiple_independent_sources',
  /** Everything backing this came from one collector. */
  'single_source',
  /** The person answered a question and their answer is in the support. */
  'user_confirmed',
  /** Nothing but observed activity — commits, sessions. Nobody confirmed it. */
  'activity_only',
  /** Something in the support records a result, not merely the work. */
  'outcome_evidenced',
  /** No evidence records what changed because of this work. */
  'outcome_not_evidenced',
  /** A number in the asset was computed from evidence. */
  'metric_derived',
  /** A number in the asset was confirmed by the person. */
  'metric_confirmed',
  /** A scope figure is carried by evidence rather than estimated. */
  'scope_corroborated',
  /** Role or leadership is confirmed rather than inferred. */
  'role_confirmed',
  /** Very few records. True, and thin. */
  'thin_evidence',
  /** Some support has been corrected or tombstoned since generation. */
  'support_superseded',
  /** Questions are open whose answers would strengthen this. */
  'open_questions',
] as const;

export type EvidenceSignal = (typeof EVIDENCE_SIGNALS)[number];

export type SignalPolarity = 'strength' | 'limit';

/**
 * The sentence and polarity for each signal.
 *
 * Kept in the domain so the CLI, the eventual UI, and an export consumer all
 * say the same thing. A limit phrased differently in two places reads as two
 * different limits.
 */
const SIGNAL_COPY: Readonly<
  Record<EvidenceSignal, { readonly polarity: SignalPolarity; readonly text: string }>
> = {
  multiple_independent_sources: {
    polarity: 'strength',
    text: 'Corroborated by multiple independent evidence sources.',
  },
  single_source: {
    polarity: 'limit',
    text: 'All supporting evidence came from a single source.',
  },
  user_confirmed: {
    polarity: 'strength',
    text: 'Supported by your own answer in an interview.',
  },
  activity_only: {
    polarity: 'limit',
    text: 'Based only on observed activity. Nobody confirmed any part of it.',
  },
  outcome_evidenced: {
    polarity: 'strength',
    text: 'Evidence records a result, not only the work.',
  },
  outcome_not_evidenced: {
    polarity: 'limit',
    text: 'No evidence records what changed because of this work.',
  },
  metric_derived: {
    polarity: 'strength',
    text: 'A figure here was computed from evidence rather than estimated.',
  },
  metric_confirmed: {
    polarity: 'strength',
    text: 'A figure here was confirmed by you.',
  },
  scope_corroborated: {
    polarity: 'strength',
    text: 'The scope figure is carried by evidence, not inferred from it.',
  },
  role_confirmed: {
    polarity: 'strength',
    text: 'Your role is confirmed rather than assumed from activity.',
  },
  thin_evidence: {
    polarity: 'limit',
    text: 'Very little evidence stands behind this. True, and thin.',
  },
  support_superseded: {
    polarity: 'limit',
    text: 'Some supporting evidence has been corrected or withdrawn since this was written.',
  },
  open_questions: {
    polarity: 'limit',
    text: 'Open questions remain whose answers would make this stronger.',
  },
};

export function describeSignal(signal: EvidenceSignal): string {
  return SIGNAL_COPY[signal].text;
}

export function signalPolarity(signal: EvidenceSignal): SignalPolarity {
  return SIGNAL_COPY[signal].polarity;
}

/** One record standing behind some claim in the asset. */
export interface SupportingRecord {
  readonly id: string;
  /** The collector that produced it. The unit of source independence. */
  readonly collectorId: string;
  readonly evidenceClass: EvidenceClass;
  /** True when this record carries a claim's asserted value, not just the activity. */
  readonly corroborating: boolean;
  /** True when the record has since been superseded or tombstoned. */
  readonly suppressed: boolean;
  /** True when the record observes a result rather than the work itself. */
  readonly recordsOutcome: boolean;
}

export interface AssessmentInput {
  readonly claimTypes: readonly ClaimType[];
  readonly support: readonly SupportingRecord[];
  /** Claims that were proposed and dropped for want of support. */
  readonly droppedClaimTypes: readonly ClaimType[];
  readonly openQuestionCount: number;
}

export interface EvidenceAssessment {
  readonly grade: EvidenceGrade;
  readonly signals: readonly EvidenceSignal[];
  /** Distinct collectors among the support. The independence count. */
  readonly sourceCount: number;
  readonly recordCount: number;
  readonly confirmedCount: number;
  readonly openQuestionCount: number;
  /** Claim types the evidence could not carry. Absent from the asset text. */
  readonly droppedClaimTypes: readonly ClaimType[];
}

/**
 * Below this, the evidence is thin however good it is.
 *
 * Two records is where a bullet stops being a restatement of one artifact.
 * Not tuned against a corpus — an honest threshold nobody has measured, and
 * marked as such so it is not mistaken for one that has been.
 */
export const THIN_EVIDENCE_BELOW = 2;

/**
 * Describe the strength of the evidence behind an asset.
 *
 * Total and pure. Given the same support it returns the same assessment, which
 * is what makes it safe to recompute on every read and compare against what
 * was stored.
 */
export function assessEvidence(input: AssessmentInput): EvidenceAssessment {
  // Suppressed records are counted as a limit, never as strength. Evidence
  // that has been corrected away must not go on propping up a sentence.
  const live = input.support.filter((record) => !record.suppressed);

  const sources = new Set(live.map((record) => record.collectorId));
  const confirmed = live.filter((record) => record.evidenceClass === 'user_confirmed');
  const derived = live.filter((record) => record.evidenceClass === 'derived');

  const signals = new Set<EvidenceSignal>();

  if (sources.size >= 2) signals.add('multiple_independent_sources');
  else if (live.length > 0) signals.add('single_source');

  if (confirmed.length > 0) signals.add('user_confirmed');
  else signals.add('activity_only');

  if (live.some((record) => record.recordsOutcome)) signals.add('outcome_evidenced');
  else signals.add('outcome_not_evidenced');

  if (input.claimTypes.includes('metric')) {
    if (confirmed.length > 0) signals.add('metric_confirmed');
    if (derived.length > 0) signals.add('metric_derived');
  }
  if (input.claimTypes.includes('scope') && live.some((record) => record.corroborating)) {
    signals.add('scope_corroborated');
  }
  if (input.claimTypes.includes('role') && confirmed.length > 0) signals.add('role_confirmed');

  if (live.length < THIN_EVIDENCE_BELOW) signals.add('thin_evidence');
  if (live.length < input.support.length) signals.add('support_superseded');
  if (input.openQuestionCount > 0) signals.add('open_questions');

  return {
    grade: gradeOf(sources.size, confirmed.length, live.length),
    // Sorted so a stored assessment and a recomputed one compare by value.
    signals: [...signals].sort(),
    sourceCount: sources.size,
    recordCount: live.length,
    confirmedCount: confirmed.length,
    openQuestionCount: input.openQuestionCount,
    droppedClaimTypes: [...input.droppedClaimTypes].sort(),
  };
}

/**
 * The grade, from three counts.
 *
 * The ordering says something worth stating: independent agreement outranks a
 * single confirmation. A person's own answer is authoritative about their role
 * and their numbers — that is why `evaluateSupport` demands it — but two
 * unrelated sources recording the same work is a stronger claim about the
 * world than one person's recollection, and a consumer reasoning about
 * evidence quality should be told which they have.
 */
function gradeOf(sourceCount: number, confirmedCount: number, recordCount: number): EvidenceGrade {
  if (recordCount === 0) return 'asserted';
  if (sourceCount >= 2) return 'corroborated';
  if (confirmedCount > 0) return 'confirmed';
  return 'observed';
}

/** The one-line summary, for a list where the full assessment will not fit. */
export function summariseAssessment(assessment: EvidenceAssessment): string {
  const scale =
    assessment.recordCount === 1
      ? '1 record'
      : `${assessment.recordCount} records from ${assessment.sourceCount} source(s)`;
  return `${assessment.grade} — ${scale}`;
}

/**
 * Whether two assessments describe the same evidence.
 *
 * Used to detect that the ground has moved under a stored assessment. Compares
 * the derived facts rather than the object, so a change to the copy of a signal
 * does not read as a change in the evidence.
 */
export function sameAssessment(a: EvidenceAssessment, b: EvidenceAssessment): boolean {
  return (
    a.grade === b.grade &&
    a.recordCount === b.recordCount &&
    a.sourceCount === b.sourceCount &&
    a.confirmedCount === b.confirmedCount &&
    a.signals.length === b.signals.length &&
    a.signals.every((signal, index) => signal === b.signals[index])
  );
}
