import { describe, expect, it } from 'vitest';

import {
  assessEvidence,
  describeSignal,
  gradeRank,
  sameAssessment,
  signalPolarity,
  summariseAssessment,
  EVIDENCE_GRADES,
  EVIDENCE_SIGNALS,
  type AssessmentInput,
  type SupportingRecord,
} from './assessment.js';

/**
 * The strength of the record, not the confidence of a model.
 *
 * Every number below comes from counting rows. Nothing here can be influenced
 * by how fluent a sentence is, which is the entire point: a fluent invention
 * and a terse truth must not score alike, and only the evidence can tell them
 * apart.
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

const input = (overrides: Partial<AssessmentInput> = {}): AssessmentInput => ({
  claimTypes: ['action'],
  support: [record()],
  droppedClaimTypes: [],
  openQuestionCount: 0,
  ...overrides,
});

describe('the grade', () => {
  it('is `asserted` when nothing live stands behind it', () => {
    expect(assessEvidence(input({ support: [] })).grade).toBe('asserted');
  });

  it('is `observed` for activity from one source that nobody confirmed', () => {
    expect(assessEvidence(input()).grade).toBe('observed');
  });

  it('is `confirmed` when the person answered a question', () => {
    const assessment = assessEvidence(
      input({ support: [record({ evidenceClass: 'user_confirmed' })] }),
    );
    expect(assessment.grade).toBe('confirmed');
  });

  it('is `corroborated` when two collectors independently record the work', () => {
    const assessment = assessEvidence(
      input({
        support: [
          record({ id: 'a', collectorId: 'git' }),
          record({ id: 'b', collectorId: 'session' }),
        ],
      }),
    );
    expect(assessment.grade).toBe('corroborated');
    expect(assessment.sourceCount).toBe(2);
  });

  it('does not treat two records from one collector as independent', () => {
    // Two commits in the same repository are one source saying something
    // twice, which is not corroboration.
    const assessment = assessEvidence(
      input({ support: [record({ id: 'a' }), record({ id: 'b' })] }),
    );
    expect(assessment.sourceCount).toBe(1);
    expect(assessment.grade).toBe('observed');
  });

  it('ranks independent agreement above a single confirmation', () => {
    // A person's own answer is authoritative about their role and their
    // numbers. Two unrelated sources recording the same work is a stronger
    // claim about the world, and a consumer should be told which they have.
    expect(gradeRank('corroborated')).toBeGreaterThan(gradeRank('confirmed'));
    expect(gradeRank('confirmed')).toBeGreaterThan(gradeRank('observed'));
    expect(gradeRank('observed')).toBeGreaterThan(gradeRank('asserted'));
  });

  it('offers four grades rather than a score', () => {
    // A number invites arithmetic that means nothing: the distance between
    // `observed` and `corroborated` is not a quantity.
    expect(EVIDENCE_GRADES).toHaveLength(4);
  });
});

describe('signals carry the nuance the grade cannot', () => {
  it('says when everything came from one place', () => {
    expect(assessEvidence(input()).signals).toContain('single_source');
  });

  it('says when nobody confirmed anything', () => {
    expect(assessEvidence(input()).signals).toContain('activity_only');
  });

  it('says when no evidence records a result', () => {
    // The most common honest limitation in a coding record, and the one a
    // consumer most needs told.
    expect(assessEvidence(input()).signals).toContain('outcome_not_evidenced');
  });

  it('says when evidence does record a result', () => {
    const assessment = assessEvidence(input({ support: [record({ recordsOutcome: true })] }));
    expect(assessment.signals).toContain('outcome_evidenced');
    expect(assessment.signals).not.toContain('outcome_not_evidenced');
  });

  it('names a corroborated scope only when a scope is claimed', () => {
    const withScope = assessEvidence(
      input({ claimTypes: ['action', 'scope'], support: [record({ corroborating: true })] }),
    );
    expect(withScope.signals).toContain('scope_corroborated');

    const withoutScope = assessEvidence(input({ support: [record({ corroborating: true })] }));
    expect(withoutScope.signals).not.toContain('scope_corroborated');
  });

  it('names a confirmed role only when a role is claimed', () => {
    const assessment = assessEvidence(
      input({
        claimTypes: ['action', 'role'],
        support: [record({ evidenceClass: 'user_confirmed' })],
      }),
    );
    expect(assessment.signals).toContain('role_confirmed');
  });

  it('distinguishes a computed figure from a confirmed one', () => {
    const derived = assessEvidence(
      input({ claimTypes: ['metric'], support: [record({ evidenceClass: 'derived' })] }),
    );
    expect(derived.signals).toContain('metric_derived');
    expect(derived.signals).not.toContain('metric_confirmed');

    const confirmed = assessEvidence(
      input({ claimTypes: ['metric'], support: [record({ evidenceClass: 'user_confirmed' })] }),
    );
    expect(confirmed.signals).toContain('metric_confirmed');
  });

  it('says plainly when the evidence is thin', () => {
    expect(assessEvidence(input()).signals).toContain('thin_evidence');
    expect(
      assessEvidence(input({ support: [record({ id: 'a' }), record({ id: 'b' })] })).signals,
    ).not.toContain('thin_evidence');
  });

  it('says when open questions would strengthen it', () => {
    expect(assessEvidence(input({ openQuestionCount: 2 })).signals).toContain('open_questions');
  });

  it('gives every signal a sentence and a polarity', () => {
    // A closed union like `Remedy`: a new way for evidence to be strong or
    // weak cannot be added without deciding how to say it to a person.
    for (const signal of EVIDENCE_SIGNALS) {
      expect(describeSignal(signal).length, signal).toBeGreaterThan(20);
      expect(['strength', 'limit']).toContain(signalPolarity(signal));
    }
  });
});

describe('withdrawn evidence never props up a sentence', () => {
  it('excludes suppressed records from the counts and the grade', () => {
    const assessment = assessEvidence(
      input({
        support: [
          record({ id: 'a', collectorId: 'git' }),
          record({ id: 'b', collectorId: 'session', suppressed: true }),
        ],
      }),
    );
    expect(assessment.recordCount).toBe(1);
    expect(assessment.sourceCount).toBe(1);
    // Would have been `corroborated` had the withdrawn record still counted.
    expect(assessment.grade).toBe('observed');
  });

  it('reports the withdrawal rather than quietly downgrading', () => {
    const assessment = assessEvidence(
      input({ support: [record({ id: 'a' }), record({ id: 'b', suppressed: true })] }),
    );
    expect(assessment.signals).toContain('support_superseded');
  });
});

describe('what was left out is part of the assessment', () => {
  it('records the claim types the evidence could not carry', () => {
    // The absence is the interesting part. An asset with no metric because
    // none could be supported reads identically to one where nobody tried.
    const assessment = assessEvidence(input({ droppedClaimTypes: ['role', 'metric'] }));
    expect(assessment.droppedClaimTypes).toEqual(['metric', 'role']);
  });
});

describe('comparability', () => {
  it('is deterministic, so a stored assessment can be checked against a fresh one', () => {
    const built = () => assessEvidence(input({ claimTypes: ['action', 'scope'] }));
    expect(built()).toEqual(built());
    expect(sameAssessment(built(), built())).toBe(true);
  });

  it('sorts its signals, so two runs compare by value', () => {
    const signals = assessEvidence(input({ openQuestionCount: 1 })).signals;
    expect([...signals].sort()).toEqual([...signals]);
  });

  it('notices when the evidence beneath a stored assessment has moved', () => {
    const before = assessEvidence(input());
    const after = assessEvidence(
      input({ support: [record({ id: 'a' }), record({ id: 'b', collectorId: 'session' })] }),
    );
    expect(sameAssessment(before, after)).toBe(false);
  });

  it('summarises in one line for a list', () => {
    expect(summariseAssessment(assessEvidence(input()))).toBe('observed — 1 record');
  });
});
