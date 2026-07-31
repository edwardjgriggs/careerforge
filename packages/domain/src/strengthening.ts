import {
  assessEvidence,
  gradeRank,
  type AssessmentInput,
  type EvidenceAssessment,
  type EvidenceGrade,
  type SupportingRecord,
} from './assessment.js';
import type { ClaimType } from './claims.js';

/**
 * What evidence would make this stronger?
 *
 * The second question Evidence Explorer exists to answer, and the harder one.
 * "Why do you believe this?" is a traversal — the graph already holds the
 * answer. "What would make it stronger?" is about records that do not exist,
 * and nothing in a graph of what *is* can be walked to find them.
 *
 * The naive version is a list of open questions. That is a to-do list, and it
 * fails the user in a specific way: it says what is missing without saying
 * what any of it is worth. Somebody looking at four questions has no way to
 * tell that answering one turns a bullet from unusable into publishable while
 * answering another changes nothing they can see.
 *
 * So an improvement carries its own effect, computed rather than asserted:
 * `assessEvidence` is pure and total, so the same function that grades the
 * evidence now can grade the evidence as it *would be*, and the difference is
 * the answer. Nothing here estimates, and no model is consulted.
 *
 * ── The honest cases ─────────────────────────────────────────────────────
 *
 * Some improvements are not available. No shipped collector observes outcomes,
 * so "record what changed" is real advice that a user cannot currently act on.
 * Saying so plainly beats either hiding it — which would make the limitation
 * invisible — or offering it as though it were actionable, which sends
 * somebody looking for a button that is not there.
 */

export const IMPROVEMENT_KINDS = [
  /** Answer a question already raised against this work. */
  'answer_question',
  /** Say whether you led it. Unlocks `role` claims, which are never inferred. */
  'confirm_role',
  /** Supply or compute a figure. Unlocks `metric` claims. */
  'confirm_metric',
  /** Point at evidence carrying a scope figure. Unlocks `scope` claims. */
  'corroborate_scope',
  /** Record what changed. Unlocks `outcome` claims. */
  'record_outcome',
  /** Collect a second, independent source for the same work. */
  'add_independent_source',
  /** Collect more of the work itself. For a claim resting on almost nothing. */
  'collect_more_evidence',
  /** Some support has been withdrawn; the statement should be revisited. */
  'revisit_withdrawn_support',
  /**
   * Evidence exists that this statement does not use.
   *
   * The case an interview creates. Answering a question makes the *evidence*
   * stronger and leaves the *sentence* untouched — the words on screen still
   * rest on the records they were written from. Showing an improved grade
   * would be a lie about what a reader is looking at, so the honest move is to
   * say the statement is now behind its own evidence.
   */
  'regenerate_with_new_evidence',
] as const;

export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];

/**
 * How to actually do it.
 *
 * A closed union, for the reason `Remedy` is one (ADR-0022): an improvement
 * nobody can act on is a complaint, and the type system should ask.
 */
export type ImprovementAction =
  | {
      /** A question is already open. Answer it. */
      readonly kind: 'answer';
      readonly gapId: string;
      readonly question: string;
      readonly command: string;
    }
  | {
      /** No question exists yet, but one could be asked. */
      readonly kind: 'ask';
      readonly question: string;
      readonly command: string;
    }
  | {
      /** Run a collector, or connect one. */
      readonly kind: 'collect';
      readonly detail: string;
      readonly command: string;
    }
  | {
      /**
       * Nothing available does this yet.
       *
       * Rare and deliberately visible. Hiding an unavailable improvement makes
       * the limitation invisible; offering it as actionable sends somebody
       * looking for a button that does not exist.
       */
      readonly kind: 'not_available';
      readonly detail: string;
    };

export interface ImprovementEffect {
  readonly gradeNow: EvidenceGrade;
  readonly gradeAfter: EvidenceGrade;
  /** True when the grade would actually move, not merely the signals. */
  readonly raisesGrade: boolean;
  /** Claim types the statement could then make that it cannot make now. */
  readonly unlocks: readonly ClaimType[];
}

export interface Improvement {
  readonly kind: ImprovementKind;
  /** One line, in the imperative. What the person would do. */
  readonly summary: string;
  /** Why it is worth doing, in terms of this statement. */
  readonly why: string;
  readonly effect: ImprovementEffect;
  readonly action: ImprovementAction;
}

/** What the caller knows about the statement being improved. */
export interface StrengtheningContext {
  readonly workUnitId: string;
  readonly assessment: EvidenceAssessment;
  /** The records currently standing behind it. */
  readonly support: readonly SupportingRecord[];
  readonly claimTypes: readonly ClaimType[];
  /** Questions already raised, so an improvement can point at one. */
  readonly openGaps: readonly {
    readonly id: string;
    readonly gapType: string;
    readonly question: string;
  }[];
  /**
   * Whether any collector in this build observes outcomes.
   *
   * Passed in rather than assumed: the domain does not know what collectors
   * exist, and this is the difference between honest advice and a dead end.
   */
  readonly outcomeCollectorAvailable: boolean;
  /**
   * Records collected *since* this statement was written that it does not use.
   *
   * Deliberately not "records this statement does not cite" — a bullet never
   * cites every record in its unit, and the first version of this fired on
   * every asset with "8 records here are not used", which is not a problem and
   * not news. What is news is evidence that arrived after the words did.
   */
  readonly newerRecordCount?: number;
  /** Whether any of those uncited records is the person's own answer. */
  readonly uncitedIncludesAnswer?: boolean;
}

/** A record that does not exist yet, used to grade a hypothetical. */
type Hypothetical = Partial<SupportingRecord> & { readonly collectorId: string };

/**
 * Grade the evidence as it would be with one more record.
 *
 * The whole mechanism. `assessEvidence` is pure and total, so asking what a
 * statement would be worth after an improvement is the same call with one
 * extra element — no separate model of "improvement value" to drift out of
 * step with the real grading.
 */
function gradeWith(
  context: StrengtheningContext,
  added: Hypothetical,
  extraClaimTypes: readonly ClaimType[] = [],
): EvidenceAssessment {
  const record: SupportingRecord = {
    id: '(hypothetical)',
    evidenceClass: 'imported',
    corroborating: false,
    suppressed: false,
    recordsOutcome: false,
    ...added,
  };

  const input: AssessmentInput = {
    claimTypes: [...context.claimTypes, ...extraClaimTypes],
    support: [...context.support, record],
    droppedClaimTypes: [],
    // The improvement being modelled is the question being answered, so it is
    // no longer open in the world this describes.
    openQuestionCount: Math.max(0, context.assessment.openQuestionCount - 1),
  };
  return assessEvidence(input);
}

const effectOf = (
  context: StrengtheningContext,
  after: EvidenceAssessment,
  unlocks: readonly ClaimType[],
): ImprovementEffect => ({
  gradeNow: context.assessment.grade,
  gradeAfter: after.grade,
  raisesGrade: gradeRank(after.grade) > gradeRank(context.assessment.grade),
  unlocks,
});

const interviewCommand = (gapId: string) => `careerforge interview --gap ${gapId} --answer "..."`;

/**
 * Everything that would make this statement stronger, best first.
 *
 * Ranked by what it would actually change: a grade improvement first, then the
 * number of claim types it unlocks, then whether it can be acted on at all.
 * Ordering matters more here than completeness — a user reads the first two
 * items, and the first two need to be the ones worth doing.
 */
export function suggestImprovements(context: StrengtheningContext): readonly Improvement[] {
  const improvements: Improvement[] = [];
  const signals = new Set(context.assessment.signals);
  const claiming = new Set(context.claimTypes);

  // ── Questions already raised ───────────────────────────────────────────
  // First, because they are the only improvements with a button attached.
  for (const gap of context.openGaps) {
    const unlocks = UNLOCKED_BY[gap.gapType] ?? [];
    const after = gradeWith(
      context,
      { collectorId: 'interview', evidenceClass: 'user_confirmed', corroborating: true },
      unlocks,
    );
    improvements.push({
      kind:
        gap.gapType === 'role'
          ? 'confirm_role'
          : gap.gapType === 'metric'
            ? 'confirm_metric'
            : 'answer_question',
      summary: ANSWER_SUMMARY[gap.gapType] ?? 'Answer an open question about this work',
      why:
        unlocks.length > 0
          ? `Your answer becomes evidence you stand behind, which is the only thing that can support a ${unlocks.join(' or ')} claim.`
          : 'Your answer becomes evidence you stand behind, reusable in everything written about this work afterwards.',
      effect: effectOf(
        context,
        after,
        unlocks.filter((type) => !claiming.has(type)),
      ),
      action: {
        kind: 'answer',
        gapId: gap.id,
        question: gap.question,
        command: interviewCommand(gap.id),
      },
    });
  }

  // ── A second, independent source ───────────────────────────────────────
  if (signals.has('single_source')) {
    const after = gradeWith(context, { collectorId: '(another collector)' });
    improvements.push({
      kind: 'add_independent_source',
      summary: 'Collect the same work from a second source',
      why: 'Two unrelated records of the same work is a stronger claim about the world than one record, however detailed. It is the difference between observed and corroborated.',
      effect: effectOf(context, after, []),
      action: {
        kind: 'collect',
        detail:
          'If this work also exists as commits or as a coding session that is not yet collected, collecting it corroborates what is already here.',
        command: 'careerforge collect --backfill',
      },
    });
  }

  // ── An outcome ─────────────────────────────────────────────────────────
  if (signals.has('outcome_not_evidenced')) {
    const after = gradeWith(
      context,
      { collectorId: 'interview', evidenceClass: 'user_confirmed', recordsOutcome: true },
      ['outcome'],
    );
    const alreadyAsked = context.openGaps.some((gap) => gap.gapType === 'outcome');
    improvements.push({
      kind: 'record_outcome',
      summary: 'Record what changed because of this work',
      why: 'The evidence shows the work happening and nothing about what came of it. An outcome is the difference between describing activity and describing impact, and it can never be inferred from the change that caused it.',
      effect: effectOf(context, after, claiming.has('outcome') ? [] : ['outcome']),
      action: alreadyAsked
        ? {
            kind: 'answer',
            gapId: context.openGaps.find((gap) => gap.gapType === 'outcome')!.id,
            question: context.openGaps.find((gap) => gap.gapType === 'outcome')!.question,
            command: interviewCommand(
              context.openGaps.find((gap) => gap.gapType === 'outcome')!.id,
            ),
          }
        : context.outcomeCollectorAvailable
          ? {
              kind: 'collect',
              detail: 'Collect the merge, release, or closed issue that recorded the result.',
              command: 'careerforge collect --backfill',
            }
          : {
              kind: 'not_available',
              detail:
                'No collector in this build observes outcomes — Git records commits and sessions record conversations, and neither sees what changed afterwards. Answering it yourself is the only route today.',
            },
    });
  }

  // ── Thin evidence ──────────────────────────────────────────────────────
  if (signals.has('thin_evidence')) {
    const after = gradeWith(context, { collectorId: context.support[0]?.collectorId ?? 'git' });
    improvements.push({
      kind: 'collect_more_evidence',
      summary: 'Collect more of the work itself',
      why: 'One record is a restatement of one artifact. A statement that rests on it is true and thin, and thin is what a reader notices.',
      effect: effectOf(context, after, []),
      action: {
        kind: 'collect',
        detail:
          'Run a backfill, or check that the repository and session directories for this work are being collected.',
        command: 'careerforge collect --backfill',
      },
    });
  }

  // ── Evidence this statement does not use ───────────────────────────────
  // Answering a question lands here. It is the difference between "your
  // evidence is stronger" and "this sentence is stronger", and conflating the
  // two would show an improved grade above words that had not changed.
  const newer = context.newerRecordCount ?? 0;
  if (newer > 0 || context.uncitedIncludesAnswer === true) {
    const after = gradeWith(
      context,
      context.uncitedIncludesAnswer === true
        ? { collectorId: 'interview', evidenceClass: 'user_confirmed' }
        : { collectorId: '(uncited)' },
    );
    improvements.push({
      kind: 'regenerate_with_new_evidence',
      summary:
        context.uncitedIncludesAnswer === true
          ? 'Regenerate — your answer is not in this statement yet'
          : `Regenerate — ${newer} record(s) collected since this was written`,
      why:
        context.uncitedIncludesAnswer === true
          ? 'Answering made the evidence stronger; it did not change the words already written. These still rest on the records they were generated from. Regenerating lets the statement use what you just confirmed.'
          : 'Evidence has been collected for this work since the statement was written. The words are still true, and they are not yet using everything that is here.',
      effect: effectOf(context, after, []),
      action: {
        kind: 'collect',
        detail: 'Regenerating rebuilds the statement from the evidence as it stands now.',
        command: `careerforge generate resume-bullet --unit ${context.workUnitId}`,
      },
    });
  }

  // ── Withdrawn support ──────────────────────────────────────────────────
  if (signals.has('support_superseded')) {
    improvements.push({
      kind: 'revisit_withdrawn_support',
      summary: 'Regenerate — some evidence behind this has been withdrawn',
      why: 'A record this statement rests on has been corrected or hidden since it was written. What it says may no longer be what the evidence says.',
      effect: {
        gradeNow: context.assessment.grade,
        gradeAfter: context.assessment.grade,
        raisesGrade: false,
        unlocks: [],
      },
      action: {
        kind: 'collect',
        detail: 'Regenerating rebuilds the statement from the evidence as it stands now.',
        command: `careerforge generate resume-bullet --unit ${context.workUnitId}`,
      },
    });
  }

  return [...improvements].sort(compareImprovements);
}

/**
 * Best first.
 *
 * A grade improvement outranks everything: it is the only change a reader of
 * the statement would see. Then claim types unlocked, because a bullet that
 * can finally say what you did outranks one that says it slightly better.
 * Actionability breaks the remaining ties — advice with a button beats advice
 * with an explanation.
 */
function compareImprovements(a: Improvement, b: Improvement): number {
  // A statement that has fallen behind its own evidence comes first whatever
  // else is true: everything below it is advice about collecting more, and
  // the user has already done the collecting.
  const byStale = rankStale(a) - rankStale(b);
  if (byStale !== 0) return byStale;

  const byGrade =
    gradeRank(b.effect.gradeAfter) -
    gradeRank(b.effect.gradeNow) -
    (gradeRank(a.effect.gradeAfter) - gradeRank(a.effect.gradeNow));
  if (byGrade !== 0) return byGrade;

  const byUnlocks = b.effect.unlocks.length - a.effect.unlocks.length;
  if (byUnlocks !== 0) return byUnlocks;

  return actionRank(a.action) - actionRank(b.action);
}

const rankStale = (improvement: Improvement): number =>
  improvement.kind === 'regenerate_with_new_evidence' ||
  improvement.kind === 'revisit_withdrawn_support'
    ? 0
    : 1;

const actionRank = (action: ImprovementAction): number =>
  action.kind === 'answer' ? 0 : action.kind === 'ask' ? 1 : action.kind === 'collect' ? 2 : 3;

/** Which claim types a kind of answer makes possible. */
const UNLOCKED_BY: Readonly<Record<string, readonly ClaimType[]>> = {
  role: ['role'],
  metric: ['metric'],
  scope: ['scope'],
  outcome: ['outcome'],
  context: [],
};

const ANSWER_SUMMARY: Readonly<Record<string, string>> = {
  role: 'Confirm what your role was',
  metric: 'Supply a figure you can stand behind',
  scope: 'Confirm how large this was',
  outcome: 'Say what changed as a result',
  context: 'Say what problem this was solving',
};

/** Whether anything here would actually change the statement. */
export function hasActionableImprovement(improvements: readonly Improvement[]): boolean {
  return improvements.some(
    (improvement) =>
      improvement.action.kind !== 'not_available' &&
      (improvement.effect.raisesGrade || improvement.effect.unlocks.length > 0),
  );
}
