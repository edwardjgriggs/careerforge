import { describe, expect, it } from 'vitest';

import {
  groupContextTemporal,
  DEFAULT_GROUPING_CONFIG,
  type GroupableEvidence,
} from './grouping.js';
import { toInstant } from './time.js';
import type { EvidenceId } from './ids.js';

/**
 * Edge cases for the grouping strategy.
 *
 * Whether the grouping is *good* is measured in `eval/grouping` against
 * hand-written labels. What is here is the behaviour that has no judgment in
 * it: empty input, missing attribution, and the guarantees a strategy has to
 * make whatever the data looks like.
 */

let n = 0;
const record = (
  over: Partial<GroupableEvidence> & { at: string; end?: string },
): GroupableEvidence => ({
  id: `ev-${++n}` as EvidenceId,
  kind: 'session.fragment',
  sensitivity: 'confidential',
  occurredAt: toInstant(over.at),
  occurredEnd: over.end === undefined ? null : toInstant(over.end),
  projectKey: 'acme',
  stream: 'feat/x',
  title: `Work ${n}`,
  ...over,
});

describe('grouping edge cases', () => {
  it('returns nothing for no evidence', () => {
    expect(groupContextTemporal([])).toEqual([]);
  });

  it('keeps evidence with no project separate from evidence that has one', () => {
    const groups = groupContextTemporal([
      record({ at: '2026-05-04T09:00:00.000Z', end: '2026-05-04T10:00:00.000Z' }),
      record({ at: '2026-05-04T09:10:00.000Z', end: '2026-05-04T10:10:00.000Z', projectKey: null }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('handles evidence with no end as an instant', () => {
    const [group] = groupContextTemporal([record({ at: '2026-05-04T09:00:00.000Z' })]);
    expect(group!.occurredAt).toBe(group!.occurredEnd);
  });

  it('gives every candidate a reason a person could act on', () => {
    const groups = groupContextTemporal([
      record({ at: '2026-05-04T09:00:00.000Z', end: '2026-05-04T09:00:20.000Z' }),
      record({ at: '2026-06-04T09:00:00.000Z', end: '2026-06-04T11:00:00.000Z' }),
    ]);
    expect(groups).toHaveLength(2);
    for (const group of groups) expect(group.reason.length).toBeGreaterThan(10);
    expect(groups.find((g) => !g.admitted)!.reason).toContain('threshold');
  });

  it('disambiguates two units that start on the same day', () => {
    // The grouping key is what a re-run supersedes on, so two units in one day
    // must not claim the same one.
    const groups = groupContextTemporal([
      record({ at: '2026-05-04T01:00:00.000Z', end: '2026-05-04T02:00:00.000Z', stream: null }),
      record({ at: '2026-05-04T20:00:00.000Z', end: '2026-05-04T21:00:00.000Z', stream: null }),
    ]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.groupingKey)).size).toBe(2);
  });

  it('takes the title from the earliest thing a person asked for, not a commit', () => {
    const groups = groupContextTemporal([
      record({
        at: '2026-05-04T09:00:00.000Z',
        kind: 'git.commit',
        title: 'Tidy imports',
        stream: null,
      }),
      record({
        at: '2026-05-04T09:30:00.000Z',
        end: '2026-05-04T10:30:00.000Z',
        title: 'Rework how the importer handles partial rows.',
      }),
    ]);
    expect(groups[0]!.title).toBe('Rework how the importer handles partial rows.');
  });

  it('never writes prose of its own', () => {
    // A strategy picks a title from its members; composing one would be
    // interpretation, and interpretation belongs to enrichment (ADR-0002).
    const titles = ['A specific thing somebody asked for'];
    const groups = groupContextTemporal([
      record({
        at: '2026-05-04T09:00:00.000Z',
        end: '2026-05-04T10:00:00.000Z',
        title: titles[0]!,
      }),
    ]);
    expect(titles).toContain(groups[0]!.title);
  });

  it('respects a configuration that admits nothing', () => {
    const groups = groupContextTemporal(
      [record({ at: '2026-05-04T09:00:00.000Z', end: '2026-05-04T18:00:00.000Z' })],
      {
        ...DEFAULT_GROUPING_CONFIG,
        threshold: {
          minActiveMinutes: 10_000,
          minDistinctArtifacts: 10_000,
          commitQualifiesAlone: false,
        },
      },
    );
    expect(groups[0]!.admitted).toBe(false);
  });

  it('does not depend on the order evidence arrives in', () => {
    const records = [
      record({ at: '2026-05-04T09:00:00.000Z', end: '2026-05-04T10:00:00.000Z' }),
      record({ at: '2026-05-04T11:00:00.000Z', end: '2026-05-04T12:00:00.000Z' }),
      record({ at: '2026-05-09T09:00:00.000Z', end: '2026-05-09T10:00:00.000Z' }),
    ];
    const forwards = JSON.stringify(groupContextTemporal(records));
    const backwards = JSON.stringify(groupContextTemporal([...records].reverse()));
    expect(backwards).toBe(forwards);
  });
});
