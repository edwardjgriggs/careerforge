import { describe, expect, it } from 'vitest';

import { assessEvidence, suggestImprovements, type SupportingRecord } from '@careerforge/domain';

import {
  escapeHtml,
  renderAssessment,
  renderClaimProof,
  renderEmptyState,
  renderImprovements,
  renderQuestions,
  renderStatement,
} from './render.js';
import type { AssetView, ClaimView, ExplorerView, GroundView } from './view-model.js';

/**
 * The Explorer's rendering, as pure functions.
 *
 * No DOM and no browser harness: every one of these is a string comparison,
 * which is what makes "does an unsupported claim look unsupported?" a normal
 * test rather than a screenshot somebody eyeballs.
 *
 * What is being tested is not markup. It is whether the screen answers the two
 * questions it exists for — and, most of all, whether the second answer says
 * what each option would be *worth* rather than merely that something is
 * missing.
 */

const ground = (overrides: Partial<GroundView> = {}): GroundView => ({
  id: '01EV1',
  provenanceClass: 'observed',
  classLabel: 'observed',
  label: 'Rewrote the transcript reader',
  detail: 'git.commit · 2026-05-04',
  sensitivity: 'internal',
  ...overrides,
});

const claim = (overrides: Partial<ClaimView> = {}): ClaimView => ({
  id: '01CL1',
  text: 'Rewrote the transcript reader',
  claimType: 'action',
  span: [0, 29],
  grounds: [ground()],
  interpretation: [],
  withheld: 0,
  ...overrides,
});

const record = (overrides: Partial<SupportingRecord> = {}): SupportingRecord => ({
  id: 'a',
  collectorId: 'git',
  evidenceClass: 'imported',
  corroborating: false,
  suppressed: false,
  recordsOutcome: false,
  ...overrides,
});

const asset = (overrides: Partial<AssetView> = {}): AssetView => {
  const claims = overrides.claims ?? [claim()];
  const assessment = assessEvidence({
    claimTypes: claims.map((c) => c.claimType as never),
    support: [record()],
    droppedClaimTypes: [],
    openQuestionCount: 0,
  });
  return {
    id: '01AS1',
    workUnitId: '01WU1',
    workUnitTitle: 'The transcript reader',
    text: 'Rewrote the transcript reader.',
    reviewState: 'draft',
    grade: assessment.grade,
    assessment,
    driftedFrom: null,
    claims,
    improvements: [],
    ...overrides,
  };
};

describe('the statement', () => {
  it('marks each claim at its exact span, not by searching for its text', () => {
    // Spans are exact by construction (ADR-0025). Matching text would find the
    // wrong occurrence of a repeated phrase, and a proof pointing at the wrong
    // words says something confident and false.
    const html = renderStatement(
      asset({
        text: 'Fixed the parser, and fixed the parser tests.',
        claims: [
          claim({ id: 'a', text: 'Fixed the parser', span: [0, 16] }),
          claim({ id: 'b', text: 'fixed the parser tests', span: [22, 44] }),
        ],
      }),
    );
    expect(html).toContain('data-claim="a"');
    expect(html).toContain('data-claim="b"');
    // The joining text between claims is rendered plainly: it is punctuation,
    // not assertion.
    expect(html).toContain(', and ');
  });

  it('labels every claim with its type, so a role claim is visibly a role claim', () => {
    const html = renderStatement(
      asset({ claims: [claim({ claimType: 'role', text: 'Led the rewrite', span: [0, 15] })] }),
    );
    expect(html).toContain('>role</sup>');
  });

  it('leaves text outside any claim unmarked', () => {
    const html = renderStatement(
      asset({ text: 'Rewrote it. Trailing prose.', claims: [claim({ span: [0, 10] })] }),
    );
    expect(html).toContain('Trailing prose.');
    expect(html.match(/class="claim"/g)).toHaveLength(1);
  });

  it('uses a native button and exposes its selected state', () => {
    const html = renderStatement(asset());
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label=');
    expect(html).not.toContain('role="button"');
  });
});

describe('why CareerForge believes it', () => {
  it('labels each ground with the four-way distinction in words, not class names', () => {
    // Vision.md §7 promises a user can tell these apart at a glance, and a
    // person reading their own résumé has not read the schema.
    const html = renderClaimProof(
      claim({
        grounds: [
          ground({ id: 'a', provenanceClass: 'observed' }),
          ground({ id: 'b', provenanceClass: 'stated', label: 'I led this work.' }),
          ground({ id: 'c', provenanceClass: 'derived', label: 'Computed: 12 files' }),
        ],
      }),
    );
    expect(html).toContain('Observed — a collector saw this happen');
    expect(html).toContain('You said so — your own answer, in an interview');
    expect(html).toContain('Computed — CareerForge worked this out from other facts');
  });

  it('puts the strongest ground first', () => {
    // A person scanning a proof stops after two or three lines.
    const html = renderClaimProof(
      claim({
        grounds: [
          ground({ id: 'a', provenanceClass: 'grouped', label: 'A work unit' }),
          ground({ id: 'b', provenanceClass: 'stated', label: 'You said so' }),
        ],
      }),
    );
    expect(html.indexOf('You said so')).toBeLessThan(html.indexOf('A work unit'));
  });

  it('keeps interpretation in a separate section with a caveat', () => {
    // Presenting a model's reading in the same list as a commit is how every
    // AI résumé tool launders a guess into a citation (ADR-0020).
    const html = renderClaimProof(
      claim({
        interpretation: [
          ground({ id: 'ai', provenanceClass: 'interpreted', label: 'skills interpretation' }),
        ],
      }),
    );
    expect(html).toContain('What shaped the wording');
    expect(html).toContain('never a reason to believe it');
    expect(html.indexOf('Why CareerForge believes this')).toBeLessThan(
      html.indexOf('What shaped the wording'),
    );
  });

  it('omits the interpretation section entirely when there is none', () => {
    expect(renderClaimProof(claim())).not.toContain('What shaped the wording');
  });

  it('shows sensitivity on every evidence item', () => {
    const html = renderClaimProof(claim({ grounds: [ground({ sensitivity: 'restricted' })] }));
    expect(html).toContain('sens-restricted');
    expect(html).toContain('restricted');
  });

  it('counts withheld records without naming them', () => {
    const html = renderClaimProof(claim({ withheld: 3 }));
    expect(html).toContain('3 record(s)');
    expect(html).toContain('counted, not shown');
  });

  it('says plainly when nothing stands behind a claim', () => {
    expect(renderClaimProof(claim({ grounds: [] }))).toContain(
      'Nothing in your store stands behind this claim',
    );
  });
});

describe('the grade', () => {
  it.each([
    ['corroborated', 'Corroborated'],
    ['confirmed', 'Confirmed'],
    ['observed', 'Observed'],
    ['asserted', 'Unsupported'],
  ] as const)('renders %s as "%s" with a sentence a person can act on', (grade, title) => {
    const support =
      grade === 'corroborated'
        ? [record({ id: 'a' }), record({ id: 'b', collectorId: 'session' })]
        : grade === 'confirmed'
          ? [record({ evidenceClass: 'user_confirmed' })]
          : grade === 'observed'
            ? [record()]
            : [];
    const assessment = assessEvidence({
      claimTypes: ['action'],
      support,
      droppedClaimTypes: [],
      openQuestionCount: 0,
    });
    const html = renderAssessment(assessment, null);
    expect(html).toContain(`grade-${grade}`);
    expect(html).toContain(title);
  });

  it('separates strengths from limits', () => {
    const assessment = assessEvidence({
      claimTypes: ['action'],
      support: [record({ id: 'a' }), record({ id: 'b', collectorId: 'session' })],
      droppedClaimTypes: [],
      openQuestionCount: 0,
    });
    const html = renderAssessment(assessment, null);
    expect(html).toContain('class="signals strength"');
    expect(html).toContain('class="signals limit"');
  });

  it('says so when the evidence has moved since the words were written', () => {
    const before = assessEvidence({
      claimTypes: ['action'],
      support: [record({ id: 'a' }), record({ id: 'b', collectorId: 'session' })],
      droppedClaimTypes: [],
      openQuestionCount: 0,
    });
    const now = assessEvidence({
      claimTypes: ['action'],
      support: [record({ id: 'a' })],
      droppedClaimTypes: [],
      openQuestionCount: 0,
    });
    const html = renderAssessment(now, before);
    expect(html).toContain('evidence has moved');
    expect(html).toContain('Regenerate before relying on it');
  });
});

describe('what would make it stronger', () => {
  const improvementsFor = (openGaps: { id: string; gapType: string; question: string }[] = []) => {
    const support = [record()];
    return suggestImprovements({
      workUnitId: '01WU1',
      assessment: assessEvidence({
        claimTypes: ['action'],
        support,
        droppedClaimTypes: [],
        openQuestionCount: openGaps.length,
      }),
      support,
      claimTypes: ['action'],
      openGaps,
      outcomeCollectorAvailable: false,
    });
  };

  it('leads each option with what it would be worth', () => {
    // The difference between an explanation and a to-do list. A list of what
    // is missing, with no indication of what any of it is worth, leaves a
    // person no way to choose.
    const html = renderImprovements(
      improvementsFor([{ id: '01G', gapType: 'role', question: 'Did you lead this work?' }]),
    );
    expect(html).toMatch(/Observed → Corroborated/);
    expect(html).toContain('class="effect raises"');
  });

  it('puts the question directly on the page, answerable', () => {
    const html = renderImprovements(
      improvementsFor([{ id: '01G', gapType: 'role', question: 'Did you lead this work?' }]),
    );
    expect(html).toContain('data-gap="01G"');
    expect(html).toContain('Did you lead this work?');
    expect(html).toContain('<textarea');
    expect(html).toContain('for="answer-01G"');
    expect(html).toContain('id="answer-01G"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Record this as evidence');
  });

  it('shows a command rather than a form when there is nothing to answer', () => {
    const html = renderImprovements(improvementsFor());
    expect(html).toContain('careerforge collect --backfill');
  });

  it('marks an unavailable improvement as unavailable instead of hiding it', () => {
    // Hiding it makes the limitation invisible; offering it as actionable
    // sends somebody looking for a button that does not exist.
    const html = renderImprovements(improvementsFor());
    expect(html).toContain('hint unavailable');
    expect(html).toContain('No collector in this build');
  });

  it('says so plainly when there is nothing useful left to do', () => {
    expect(renderImprovements([])).toContain(
      'as well evidenced as your store can currently make it',
    );
  });
});

describe('the empty state', () => {
  const view = (overrides: Partial<ExplorerView['totals']> = {}): ExplorerView => ({
    assets: [],
    units: [],
    questions: [],
    pagination: { page: 1, pageSize: 25, totalPages: 1 },
    totals: { evidence: 0, units: 0, assets: 0, questions: 0, ...overrides },
  });

  it('tells a brand new user what to run, not that there is no data', () => {
    // Not cosmetic. Backfill is the acquisition model, so the first screen a
    // new user sees is a nearly empty database, and this is where cold start
    // is won or lost.
    const html = renderEmptyState(view());
    expect(html).toContain('Nothing collected yet');
    expect(html).toContain('careerforge collect --backfill');
    expect(html).toContain('does not ask you to write anything down');
  });

  it('says collection works with no key, on the very first screen', () => {
    expect(renderEmptyState(view())).toContain('no API key');
  });

  it('distinguishes "nothing collected" from "nothing written yet"', () => {
    const html = renderEmptyState(view({ evidence: 40, units: 6 }));
    expect(html).toContain('6 unit(s) of work, nothing written yet');
    expect(html).toContain('generate resume-bullet');
  });

  it('points at waiting questions as a reason to answer before generating', () => {
    const html = renderEmptyState(view({ evidence: 40, units: 6, questions: 3 }));
    expect(html).toContain('3 question(s) are already waiting');
  });

  it('disappears once there is something to look at', () => {
    expect(renderEmptyState(view({ evidence: 40, units: 6, assets: 1 }))).toBe('');
  });
});

describe('open questions across the store', () => {
  it('shows the rationale, so an ask never feels arbitrary', () => {
    const html = renderQuestions([
      {
        id: '01G',
        workUnitId: '01WU',
        workUnitTitle: 'The parser work',
        gapType: 'role',
        question: 'Did you lead this?',
        rationale: 'Leadership cannot be inferred from activity.',
      },
    ]);
    expect(html).toContain('Leadership cannot be inferred from activity.');
    expect(html).toContain('data-gap="01G"');
  });

  it('says something useful when there are none', () => {
    expect(renderQuestions([])).toContain('you have answered');
  });
});

describe('escaping', () => {
  it('escapes store content everywhere it is interpolated', () => {
    // The store holds arbitrary text — commit messages, prompts, answers a
    // user typed. None of it is trusted markup.
    const nasty = '<img src=x onerror="alert(1)">';
    const html = renderClaimProof(claim({ text: nasty, grounds: [ground({ label: nasty })] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes the quote characters an attribute would break out of', () => {
    expect(escapeHtml(`" '`)).toBe('&quot; &#39;');
  });
});
