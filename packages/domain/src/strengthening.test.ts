import { describe, expect, it } from 'vitest';

import { assessEvidence, type SupportingRecord } from './assessment.js';
import {
  hasActionableImprovement,
  suggestImprovements,
  type StrengtheningContext,
} from './strengthening.js';
import type { ClaimType } from './claims.js';

/**
 * "What evidence would make this stronger?"
 *
 * The harder of the two questions Evidence Explorer answers, because it is
 * about records that do not exist and nothing in a graph of what *is* can be
 * walked to find them.
 *
 * The failure mode being tested against is a to-do list: four questions with
 * no indication that answering one turns a bullet from unusable into
 * publishable while answering another changes nothing visible. Every
 * improvement here carries its computed effect, and the ordering is part of
 * the answer rather than incidental.
 */

const record = (overrides: Partial<SupportingRecord> = {}): SupportingRecord => ({
  id: 'ev-1',
  collectorId: 'git',
  evidenceClass: 'imported',
  corroborating: false,
  suppressed: false,
  recordsOutcome: false,
  ...overrides,
});

function context(overrides: Partial<StrengtheningContext> = {}): StrengtheningContext {
  const support = overrides.support ?? [record({ id: 'a' }), record({ id: 'b' })];
  const claimTypes: readonly ClaimType[] = overrides.claimTypes ?? ['action'];
  const openGaps = overrides.openGaps ?? [];
  return {
    workUnitId: '01WU',
    support,
    claimTypes,
    openGaps,
    outcomeCollectorAvailable: false,
    assessment: assessEvidence({
      claimTypes,
      support,
      droppedClaimTypes: [],
      openQuestionCount: openGaps.length,
    }),
    ...overrides,
  };
}

const roleGap = { id: '01GAP', gapType: 'role', question: 'Did you lead this work?' };

describe('every improvement says what it would be worth', () => {
  it('computes the grade an answer would produce rather than asserting one', () => {
    // The mechanism: the same pure function that grades the evidence now
    // grades the evidence as it would be. There is no separate model of
    // "improvement value" to drift out of step with the real grading.
    const improvements = suggestImprovements(context({ openGaps: [roleGap] }));
    const answer = improvements.find((i) => i.action.kind === 'answer')!;

    expect(answer.effect.gradeNow).toBe('observed');
    expect(answer.effect.gradeAfter).toBe('corroborated');
    expect(answer.effect.raisesGrade).toBe(true);
  });

  it('names the claim types an answer would unlock', () => {
    const improvements = suggestImprovements(context({ openGaps: [roleGap] }));
    expect(improvements[0]!.effect.unlocks).toEqual(['role']);
  });

  it('does not claim to unlock something the statement already says', () => {
    const improvements = suggestImprovements(
      context({ openGaps: [roleGap], claimTypes: ['action', 'role'] }),
    );
    const answer = improvements.find((i) => i.action.kind === 'answer')!;
    expect(answer.effect.unlocks).toEqual([]);
    // And it drops down the ranking accordingly: recording an outcome now
    // unlocks something this one does not.
    expect(improvements[0]!.kind).toBe('record_outcome');
  });

  it('reports an improvement that changes nothing visible as changing nothing', () => {
    // A to-do list would show this identically to the one above. That is the
    // failure being designed against.
    const improvements = suggestImprovements(
      context({
        openGaps: [{ id: '01G2', gapType: 'context', question: 'What problem was this solving?' }],
        support: [
          record({ id: 'a', collectorId: 'git' }),
          record({ id: 'b', collectorId: 'session' }),
        ],
        claimTypes: ['action'],
      }),
    );
    const answer = improvements.find((i) => i.action.kind === 'answer')!;
    expect(answer.effect.raisesGrade).toBe(false);
    expect(answer.effect.unlocks).toEqual([]);
  });
});

describe('ordering is part of the answer', () => {
  it('puts a grade improvement above everything else', () => {
    const improvements = suggestImprovements(context({ support: [record()], openGaps: [roleGap] }));
    expect(improvements[0]!.effect.raisesGrade).toBe(true);
  });

  it('prefers what unlocks more when the grade change is equal', () => {
    const improvements = suggestImprovements(
      context({
        support: [
          record({ id: 'a', collectorId: 'git' }),
          record({ id: 'b', collectorId: 'session' }),
        ],
        openGaps: [{ id: '01G1', gapType: 'context', question: 'What problem?' }, roleGap],
      }),
    );
    expect(improvements[0]!.effect.unlocks).toEqual(['role']);
  });

  it('puts advice with a button above advice with an explanation', () => {
    const improvements = suggestImprovements(context({ support: [record()], openGaps: [roleGap] }));
    const kinds = improvements.map((i) => i.action.kind);
    expect(kinds.indexOf('answer')).toBeLessThan(kinds.lastIndexOf('collect'));
  });
});

describe('the single-source case', () => {
  it('offers a second independent source, and says why it is different', () => {
    const improvements = suggestImprovements(context());
    const second = improvements.find((i) => i.kind === 'add_independent_source')!;
    expect(second.effect.gradeAfter).toBe('corroborated');
    expect(second.why).toContain('stronger claim about the world');
  });

  it('does not offer it when two sources already agree', () => {
    const improvements = suggestImprovements(
      context({
        support: [
          record({ id: 'a', collectorId: 'git' }),
          record({ id: 'b', collectorId: 'session' }),
        ],
      }),
    );
    expect(improvements.some((i) => i.kind === 'add_independent_source')).toBe(false);
  });
});

describe('the outcome case is honest about being unavailable', () => {
  it('offers recording an outcome, because it is the biggest limitation there is', () => {
    const improvements = suggestImprovements(context());
    const outcome = improvements.find((i) => i.kind === 'record_outcome')!;
    expect(outcome.effect.unlocks).toEqual(['outcome']);
    expect(outcome.why).toContain('never be inferred');
  });

  it('says plainly that no collector can do it, rather than offering a dead end', () => {
    // Hiding it would make the limitation invisible. Offering it as actionable
    // would send somebody looking for a button that does not exist.
    const outcome = suggestImprovements(context()).find((i) => i.kind === 'record_outcome')!;
    expect(outcome.action.kind).toBe('not_available');
    if (outcome.action.kind !== 'not_available') throw new Error('unreachable');
    expect(outcome.action.detail).toContain('No collector in this build');
  });

  it('offers collection instead once a collector could observe one', () => {
    const improvements = suggestImprovements(context({ outcomeCollectorAvailable: true }));
    const outcome = improvements.find((i) => i.kind === 'record_outcome')!;
    expect(outcome.action.kind).toBe('collect');
  });

  it('points at the open question when one has already been raised', () => {
    const improvements = suggestImprovements(
      context({
        openGaps: [{ id: '01GO', gapType: 'outcome', question: 'What changed as a result?' }],
      }),
    );
    const outcome = improvements.find((i) => i.kind === 'record_outcome')!;
    expect(outcome.action.kind).toBe('answer');
    if (outcome.action.kind !== 'answer') throw new Error('unreachable');
    expect(outcome.action.gapId).toBe('01GO');
  });
});

describe('thin and withdrawn evidence', () => {
  it('says plainly when a statement rests on almost nothing', () => {
    const improvements = suggestImprovements(context({ support: [record()] }));
    const thin = improvements.find((i) => i.kind === 'collect_more_evidence')!;
    expect(thin.why).toContain('true and thin');
  });

  it('asks for a regeneration when support has been withdrawn', () => {
    const improvements = suggestImprovements(
      context({ support: [record({ id: 'a' }), record({ id: 'b', suppressed: true })] }),
    );
    const revisit = improvements.find((i) => i.kind === 'revisit_withdrawn_support')!;
    expect(revisit.action.kind).toBe('collect');
    expect(revisit.why).toContain('may no longer be what the evidence says');
  });
});

describe('when there is nothing useful to say', () => {
  it('reports no actionable improvement for a statement that is already strong', () => {
    const strong = context({
      support: [
        record({ id: 'a', collectorId: 'git' }),
        record({ id: 'b', collectorId: 'session' }),
        record({ id: 'c', collectorId: 'interview', evidenceClass: 'user_confirmed' }),
        record({ id: 'd', collectorId: 'git', recordsOutcome: true }),
      ],
    });
    const improvements = suggestImprovements(strong);
    expect(hasActionableImprovement(improvements)).toBe(false);
  });

  it('is total — never throws on a statement with no support at all', () => {
    expect(() => suggestImprovements(context({ support: [] }))).not.toThrow();
  });
});
