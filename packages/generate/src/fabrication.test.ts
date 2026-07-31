import { describe, expect, it } from 'vitest';

import { generateBullet, isPublishable, type ProposedClaim } from './bullet.js';
import { spansAreExact } from './render.js';
import type { CandidateRecord } from './support.js';

/**
 * The most important tests in the project.
 *
 * Everything else CareerForge does is in service of one promise: it will not
 * write a sentence about your career that the evidence cannot carry. These are
 * the executable form of that promise. If they pass, the product does what it
 * claims. If they are weak, nothing else here matters.
 *
 * Each case is a model behaving badly in a realistic way — not a malicious
 * model, an ordinary one doing what résumé generators do: rounding activity up
 * into leadership, attaching a plausible percentage, describing scope nobody
 * measured. The evidence is deliberately ordinary and deliberately silent on
 * the point being claimed.
 *
 * The assertion is always the same three things: the claim is absent, its
 * *words* are absent, and a question exists in its place.
 */

const commit = (id: string, overrides: Partial<CandidateRecord> = {}): CandidateRecord => ({
  id,
  collectorId: 'git',
  kind: 'git.commit',
  evidenceClass: 'imported',
  attributes: { files: ['src/parser.ts'], verbs: ['commit'] },
  text: 'Rewrote the transcript reader to stream rather than buffer',
  suppressed: false,
  ...overrides,
});

const session = (id: string, overrides: Partial<CandidateRecord> = {}): CandidateRecord =>
  commit(id, { collectorId: 'session', kind: 'session.fragment', ...overrides });

const answer = (id: string, text: string): CandidateRecord =>
  commit(id, {
    collectorId: 'interview',
    kind: 'interview.answer',
    evidenceClass: 'user_confirmed',
    attributes: {},
    text,
  });

const EVIDENCE = [commit('01A'), session('01B')];

const action: ProposedClaim = {
  text: 'rewrote the transcript reader to stream rather than buffer',
  claimType: 'action',
  evidence: ['01A'],
};

const generate = (
  proposals: readonly ProposedClaim[],
  available: readonly CandidateRecord[] = EVIDENCE,
) => generateBullet(proposals, { workUnitId: '01WU', available, openQuestionCount: 0 });

describe('leadership is never inferred from activity', () => {
  const led: ProposedClaim = {
    // Exactly what a résumé generator produces from two commits, and exactly
    // what somebody then has to defend in an interview.
    text: 'led the rewrite of the transcript pipeline',
    claimType: 'role',
    evidence: ['01A', '01B'],
  };

  it('drops the claim', () => {
    const bullet = generate([action, led]);
    expect(bullet.claims.map((claim) => claim.claimType)).toEqual(['action']);
  });

  it('leaves none of its words in the bullet', () => {
    // The real guarantee. Dropping a claim while its phrasing survives in the
    // sentence would be worse than not checking at all, because the check
    // would have reported success.
    const bullet = generate([action, led]);
    expect(bullet.text).not.toContain('led');
    expect(bullet.text).not.toMatch(/\blead/i);
  });

  it('does not hedge it into something weaker', () => {
    // The usual move is "helped lead" or "contributed to leading", which keeps
    // the impression and discards the accountability. There is no code path
    // here that can produce a softened claim: text is composed from survivors.
    const bullet = generate([action, led]);
    expect(bullet.text).not.toMatch(/helped|contributed|assisted|supported/i);
  });

  it('asks instead', () => {
    const bullet = generate([action, led]);
    const dropped = bullet.dropped.find((claim) => claim.claimType === 'role')!;
    expect(dropped.code).toBe('role_requires_confirmation');
    expect(dropped.gapType).toBe('role');
    expect(dropped.question).toMatch(/role|led/i);
  });

  it('accepts it once the person has confirmed it', () => {
    // The whole arc: refuse, ask, and accept the answer as evidence. The claim
    // is not unreachable, it is unreachable *by inference*.
    const bullet = generate(
      [action, { ...led, evidence: ['01A', '01C'] }],
      [...EVIDENCE, answer('01C', 'I led this work and set the approach.')],
    );
    expect(bullet.claims.map((claim) => claim.claimType)).toEqual(['action', 'role']);
    expect(bullet.text).toContain('led the rewrite');
    expect(bullet.assessment.signals).toContain('role_confirmed');
  });
});

describe('a number is never supplied by a model', () => {
  const metric: ProposedClaim = {
    text: 'reduced peak memory use by 60%',
    claimType: 'metric',
    evidence: ['01A', '01B'],
  };

  it('drops the claim and the figure with it', () => {
    const bullet = generate([action, metric]);
    expect(bullet.claims.map((claim) => claim.claimType)).toEqual(['action']);
    expect(bullet.text).not.toContain('60');
    expect(bullet.text).not.toContain('%');
  });

  it('asks for a number rather than estimating one', () => {
    const bullet = generate([action, metric]);
    const dropped = bullet.dropped.find((claim) => claim.claimType === 'metric')!;
    expect(dropped.code).toBe('metric_requires_derived_or_confirmed');
    expect(dropped.gapType).toBe('metric');
  });

  it('accepts a figure the person confirmed', () => {
    const bullet = generate(
      [action, { ...metric, evidence: ['01C'] }],
      [...EVIDENCE, answer('01C', 'Peak memory went from 1.2GB to 480MB.')],
    );
    expect(bullet.text).toContain('60%');
    expect(bullet.assessment.signals).toContain('metric_confirmed');
  });

  it('accepts a figure computed from evidence', () => {
    const bullet = generate(
      [action, { ...metric, evidence: ['01D'] }],
      [
        ...EVIDENCE,
        commit('01D', { evidenceClass: 'derived', attributes: { reductionPercent: 60 } }),
      ],
    );
    expect(bullet.text).toContain('60%');
    expect(bullet.assessment.signals).toContain('metric_derived');
  });
});

describe('scope needs evidence carrying the figure, not evidence that work happened', () => {
  const scope: ProposedClaim = {
    text: 'across 40 files',
    claimType: 'scope',
    evidence: ['01A'],
  };

  it('drops a scope figure no record carries', () => {
    // `01A` records that the work happened. It does not record forty of
    // anything, and "the work happened" is not evidence of its size.
    const bullet = generate([action, scope]);
    expect(bullet.text).not.toContain('40');
    expect(bullet.dropped[0]!.code).toBe('scope_requires_corroborating_evidence');
  });

  it('accepts a figure an attribute actually carries', () => {
    const bullet = generate(
      [action, scope],
      [commit('01A', { attributes: { fileCount: 40, files: ['a.ts'] } })],
    );
    expect(bullet.text).toContain('40 files');
    expect(bullet.assessment.signals).toContain('scope_corroborated');
  });

  it('counts an array as the figure it is, so a collector need not store the count', () => {
    const files = Array.from({ length: 40 }, (_, n) => `src/file-${n}.ts`);
    const bullet = generate([action, scope], [commit('01A', { attributes: { files } })]);
    expect(bullet.text).toContain('40 files');
  });

  it('is not corroborated by prose that happens to mention the number', () => {
    // A claim matched against text would be corroborated by its own
    // restatement. Attributes are values a collector computed; text is
    // whatever somebody typed.
    const bullet = generate(
      [action, scope],
      [commit('01A', { text: 'touched about 40 files today, I think', attributes: {} })],
    );
    expect(bullet.text).not.toContain('40');
  });

  it('requires every figure in the claim, not merely one of them', () => {
    const bullet = generate(
      [
        action,
        { text: 'across 40 files in 3 repositories', claimType: 'scope', evidence: ['01A'] },
      ],
      [commit('01A', { attributes: { fileCount: 40 } })],
    );
    expect(bullet.text).not.toContain('40');
  });
});

describe('an outcome needs a record of the outcome', () => {
  it('drops an outcome claim resting only on a work unit', () => {
    const bullet = generate([
      action,
      { text: 'eliminated the nightly memory alerts', claimType: 'outcome', evidence: [] },
    ]);
    expect(bullet.dropped.map((claim) => claim.claimType)).toContain('outcome');
    expect(bullet.text).not.toContain('alerts');
  });

  it('says so in the assessment even when nothing was claimed', () => {
    // The most common honest limitation in a coding record. No shipped
    // collector observes what changed in the world, so this is true of almost
    // every real asset — and stating it is better than implying otherwise.
    const bullet = generate([action]);
    expect(bullet.assessment.signals).toContain('outcome_not_evidenced');
  });
});

describe('citations are checked here too, not only at the provider', () => {
  it('refuses a claim citing a record that is not in the store', () => {
    const bullet = generate([{ ...action, evidence: ['01NOWHERE'] }]);
    expect(bullet.claims).toEqual([]);
    expect(bullet.unusableCitations).toEqual(['01NOWHERE']);
  });

  it('refuses a claim resting only on evidence that has been withdrawn', () => {
    // Evidence corrected away must not go on justifying a sentence. The claim
    // fails loudly and becomes a question rather than quietly weakening.
    const bullet = generate([action], [commit('01A', { suppressed: true })]);
    expect(bullet.claims).toEqual([]);
    expect(bullet.dropped[0]!.code).toBe('no_support');
  });

  it('keeps a claim whose other citations survive', () => {
    const bullet = generate([{ ...action, evidence: ['01A', '01GONE'] }]);
    expect(bullet.claims).toHaveLength(1);
    expect(bullet.claims[0]!.evidence).toEqual(['01A']);
    expect(bullet.unusableCitations).toEqual(['01GONE']);
  });
});

describe('the composed sentence', () => {
  it('is empty when nothing survived, and is not publishable', () => {
    // A correct outcome for a work unit whose evidence carries nothing. An
    // empty asset in the store is something a user would later find and
    // wonder about; the questions are the useful product here.
    const bullet = generate([{ text: 'led the migration', claimType: 'role', evidence: ['01A'] }]);
    expect(bullet.text).toBe('');
    expect(isPublishable(bullet)).toBe(false);
    expect(bullet.dropped).toHaveLength(1);
  });

  it('places every claim exactly where it says it is', () => {
    // An explanation highlighting the wrong words is worse than one
    // highlighting none: it says something confident and false about which
    // part of the bullet the evidence covers.
    const bullet = generate([
      action,
      { text: 'added a fixture for a 40MB transcript', claimType: 'action', evidence: ['01B'] },
      { text: 'removed the buffering path', claimType: 'action', evidence: ['01A'] },
    ]);
    expect(spansAreExact({ text: bullet.text, claims: bullet.claims })).toBe(true);
  });

  it('reads as a sentence rather than a list', () => {
    const bullet = generate([
      action,
      { text: 'added a streaming fixture', claimType: 'action', evidence: ['01B'] },
      { text: 'removed the buffering path', claimType: 'action', evidence: ['01A'] },
    ]);
    expect(bullet.text).toBe(
      'Rewrote the transcript reader to stream rather than buffer, added a streaming fixture, and removed the buffering path.',
    );
  });

  it('does not claim anything the model did not propose', () => {
    const bullet = generate([action]);
    expect(bullet.text).toBe('Rewrote the transcript reader to stream rather than buffer.');
  });
});

describe('the assessment describes what survived, not what was available', () => {
  it('counts only the records the surviving claims cite', () => {
    // A bullet resting on two of forty records is backed by two. Counting the
    // other thirty-eight would flatter it.
    const many = [commit('01A'), ...Array.from({ length: 20 }, (_, n) => commit(`01X${n}`))];
    const bullet = generate([action], many);
    expect(bullet.assessment.recordCount).toBe(1);
  });

  it('rises to corroborated when two collectors back the same claim', () => {
    const bullet = generate([{ ...action, evidence: ['01A', '01B'] }]);
    expect(bullet.assessment.grade).toBe('corroborated');
    expect(bullet.assessment.signals).toContain('multiple_independent_sources');
  });

  it('records the claim types that were dropped, so the absence is visible', () => {
    const bullet = generate([
      action,
      { text: 'led it', claimType: 'role', evidence: ['01A'] },
      { text: 'by 60%', claimType: 'metric', evidence: ['01A'] },
    ]);
    expect(bullet.assessment.droppedClaimTypes).toEqual(['metric', 'role']);
  });

  it('counts each dropped claim as an open question', () => {
    const bullet = generate([action, { text: 'led it', claimType: 'role', evidence: ['01A'] }]);
    expect(bullet.assessment.openQuestionCount).toBe(1);
    expect(bullet.assessment.signals).toContain('open_questions');
  });
});

describe('answering a question strengthens the bullet, measurably', () => {
  it('goes from three claims dropped to none, and from observed to corroborated', () => {
    const proposals: ProposedClaim[] = [
      action,
      { text: 'led the rewrite', claimType: 'role', evidence: ['01A', '01C'] },
      { text: 'across 12 files', claimType: 'scope', evidence: ['01A'] },
    ];

    const before = generate(proposals, [commit('01A', { attributes: {} })]);
    expect(before.dropped).toHaveLength(2);
    expect(before.assessment.grade).toBe('observed');

    const after = generate(proposals, [
      commit('01A', { attributes: { files: Array.from({ length: 12 }, (_, n) => `f${n}.ts`) } }),
      answer('01C', 'I led this work.'),
    ]);
    expect(after.dropped).toHaveLength(0);
    expect(after.assessment.grade).toBe('corroborated');
    expect(after.text).toContain('led the rewrite');
    expect(after.text).toContain('12 files');
  });
});
