import { describe, expect, it } from 'vitest';

import { isUnusable, validateResponse } from './response.js';
import { TEMPLATES } from './templates.js';

/**
 * An interpretation cites its inputs or it is discarded.
 *
 * The rule reads as pedantry until you watch a model produce a fluent,
 * plausible, entirely invented capability and attach it to an id that was
 * never sent. Schema conformance does not catch that. This does.
 */

const skills = TEMPLATES['skills@1']!;
const star = TEMPLATES['star_candidate@1']!;

const SENT = ['01EV1', '01EV2', '01EV3'];

const skill = (name: string, evidence: string[]) => ({
  name,
  category: 'engineering',
  rationale: `demonstrated by ${name}`,
  evidence,
});

describe('citations decide what survives', () => {
  it('keeps an item that cites what it was shown', () => {
    const result = validateResponse(
      { skills: [skill('incremental parsing', ['01EV1'])] },
      skills,
      SENT,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.evidence).toEqual(['01EV1']);
    expect(result.rejections).toEqual([]);
  });

  it('discards an item that cites a record it was never shown', () => {
    const result = validateResponse(
      { skills: [skill('kubernetes tuning', ['01NOPE'])] },
      skills,
      SENT,
    );
    expect(result.items).toEqual([]);
    expect(result.rejections[0]!.reason).toBe('fabricated_citation');
    expect(result.unknownCitations).toEqual(['01NOPE']);
  });

  it('keeps an item that cites some real inputs and some invented ones, minus the inventions', () => {
    // The partial case is the common one and the tempting one to drop whole.
    // What the model said is still grounded in something real; the invented
    // id simply does not travel with it into the graph.
    const result = validateResponse(
      { skills: [skill('streaming parse', ['01EV2', '01MADEUP'])] },
      skills,
      SENT,
    );
    expect(result.items[0]!.evidence).toEqual(['01EV2']);
    expect(result.unknownCitations).toEqual(['01MADEUP']);
  });

  it('discards an item that cites nothing at all', () => {
    const result = validateResponse({ skills: [skill('leadership', [])] }, skills, SENT);
    expect(result.rejections[0]!.reason).toBe('uncited');
  });

  it('reports every invented id once, not once per item', () => {
    const result = validateResponse(
      { skills: [skill('a', ['01GHOST']), skill('b', ['01GHOST'])] },
      skills,
      SENT,
    );
    expect(result.unknownCitations).toEqual(['01GHOST']);
  });

  it('deduplicates and sorts the citations it keeps, so a run is comparable', () => {
    const result = validateResponse(
      { skills: [skill('parsing', ['01EV3', '01EV1', '01EV3'])] },
      skills,
      SENT,
    );
    expect(result.items[0]!.evidence).toEqual(['01EV1', '01EV3']);
  });
});

describe('shape', () => {
  it('rejects an item missing a required field', () => {
    const result = validateResponse(
      { skills: [{ name: 'parsing', evidence: ['01EV1'] }] },
      skills,
      SENT,
    );
    expect(result.rejections[0]!.reason).toBe('malformed');
    expect(result.rejections[0]!.summary).toContain('category');
  });

  it('treats a wholly wrong shape as one failure, not an empty success', () => {
    // The distinction matters: an empty success would be cached, and the
    // failure would become permanent.
    const result = validateResponse({ answer: 'Sure!' }, skills, SENT);
    expect(result.items).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    expect(isUnusable(result)).toBe(true);
  });

  it('accepts an empty list as a real answer, not a failure', () => {
    // The most common honest answer for a thin work unit is nothing at all,
    // and treating that as an error would push the prompt toward inventing.
    const result = validateResponse({ skills: [] }, skills, SENT);
    expect(result.items).toEqual([]);
    expect(isUnusable(result)).toBe(false);
  });

  it('drops a repeated statement about the same inputs', () => {
    const result = validateResponse(
      { skills: [skill('parsing', ['01EV1']), skill('parsing', ['01EV1'])] },
      skills,
      SENT,
    );
    expect(result.items).toHaveLength(1);
    expect(result.rejections[0]!.reason).toBe('duplicate');
  });

  it('keeps the same statement about different inputs — that is two observations', () => {
    const result = validateResponse(
      { skills: [skill('parsing', ['01EV1']), skill('parsing', ['01EV2'])] },
      skills,
      SENT,
    );
    expect(result.items).toHaveLength(2);
  });

  it('never puts the whole item into a rejection summary', () => {
    const long = skill('x'.repeat(500), ['01NOPE']);
    const result = validateResponse({ skills: [long] }, skills, SENT);
    expect(result.rejections[0]!.summary.length).toBeLessThanOrEqual(80);
  });
});

describe('the STAR template carries its own honesty flag', () => {
  const candidate = (resultBasis: string) => ({
    situation: 'the parser dropped long lines',
    task: 'read them without buffering',
    action: 'split on the newline byte',
    result: 'long transcripts parse',
    resultBasis,
    evidence: ['01EV1'],
  });

  it('keeps a candidate that admits its result is not evidenced', () => {
    // Expected, not exceptional. Most coding work has no recorded outcome,
    // and the flag is what lets a résumé generator refuse to use it.
    const result = validateResponse({ candidates: [candidate('not_evidenced')] }, star, SENT);
    expect(result.items[0]!.value['resultBasis']).toBe('not_evidenced');
  });

  it('rejects a candidate that omits the flag rather than assuming the safe value', () => {
    const { resultBasis: _omitted, ...withoutFlag } = candidate('stated_in_evidence');
    const result = validateResponse({ candidates: [withoutFlag] }, star, SENT);
    expect(result.rejections[0]!.reason).toBe('malformed');
  });
});
