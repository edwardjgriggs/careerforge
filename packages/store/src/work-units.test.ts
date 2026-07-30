import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toInstant, DEFAULT_GROUPING_CONFIG, type EvidenceDraft } from '@careerforge/domain';

import { closeDatabase, IN_MEMORY, openDatabase } from './database.js';
import { EvidenceStore } from './evidence-store.js';
import { WorkUnitStore } from './work-unit-store.js';
import { deterministicPlatform } from './platform.js';
import type { Db } from './migrations/index.js';

/**
 * Work Units in the store.
 *
 * The grouping *algorithm* is measured in `eval/grouping` against hand-written
 * labels. What is tested here is everything the algorithm does not do: that
 * re-running is safe, that curation survives it, and that merge and split
 * leave a history rather than a hole.
 */

let db: Db;
let evidence: EvidenceStore;
let units: WorkUnitStore;

beforeEach(() => {
  db = openDatabase({ path: IN_MEMORY }).db;
  const platform = deterministicPlatform();
  evidence = new EvidenceStore(db, platform);
  units = new WorkUnitStore(db, platform);
});

afterEach(() => {
  closeDatabase(db);
});

let sequence = 0;

function emit(over: Partial<EvidenceDraft> & { at: string; end?: string }): string {
  const draft: EvidenceDraft = {
    collectorId: 'session',
    sourceUri: `session://${++sequence}`,
    kind: 'session.fragment',
    evidenceClass: 'imported',
    sensitivity: 'confidential',
    occurredAt: toInstant(over.at),
    occurredEnd: over.end === undefined ? null : toInstant(over.end),
    context: { projectKey: 'acme', workspace: null, stream: 'feat/x' },
    title: `Work ${sequence}`,
    summary: null,
    excerpt: null,
    payloadRef: null,
    attributes: {},
    groupingHint: null,
    collectorVersion: '1.0.0',
    sourceFormatVersion: null,
    ...over,
  };
  return evidence.emit(draft).evidence.id;
}

/** A session long enough to clear the substance threshold on its own. */
const session = (day: number, over: Partial<EvidenceDraft> = {}): string =>
  emit({
    at: `2026-05-${String(day).padStart(2, '0')}T09:00:00.000Z`,
    end: `2026-05-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    ...over,
  });

describe('grouping into the store', () => {
  it('creates units from evidence', () => {
    session(4);
    session(5);
    const report = units.group();

    expect(report.admitted).toBeGreaterThan(0);
    expect(report.created).toBe(report.admitted);
    expect(units.count()).toBe(report.admitted);
  });

  it('is idempotent — a second run writes nothing', () => {
    session(4);
    session(5);
    units.group();
    const before = units.currentUnits().map((unit) => unit.id);

    const second = units.group();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(second.admitted);
    expect(units.currentUnits().map((unit) => unit.id)).toEqual(before);
  });

  it('supersedes rather than edits when evidence changes the shape of a unit', () => {
    session(4);
    units.group();
    const [original] = units.currentUnits();

    // More work on the same branch the next day extends the unit.
    session(5);
    const second = units.group();
    expect(second.updated).toBe(1);

    const [replacement] = units.currentUnits();
    expect(replacement!.id).not.toBe(original!.id);
    expect(replacement!.supersedes).toBe(original!.id);
    // The original is still on record, just no longer current (ADR-0013).
    expect(units.byId(original!.id)).not.toBeNull();
    expect(units.currentUnits()).toHaveLength(1);
  });

  it('writes nothing on a dry run but reports what it would do', () => {
    session(4);
    const dry = units.group({ dryRun: true });
    expect(dry.created).toBeGreaterThan(0);
    expect(units.count()).toBe(0);

    const real = units.group();
    expect(real.created).toBe(dry.created);
  });

  it('takes the most sensitive member, not the least', () => {
    session(4, { sensitivity: 'internal' });
    emit({
      at: '2026-05-04T11:00:00.000Z',
      end: '2026-05-04T12:00:00.000Z',
      sensitivity: 'restricted',
    });
    units.group();
    expect(units.currentUnits()[0]!.sensitivity).toBe('restricted');
  });

  it('groups a commit with the session that produced it', () => {
    // The Git collector records no branch on purpose, so the two arrive with
    // different streams. Cross-source grouping is the whole point of a unit.
    const s = session(11, { context: { projectKey: 'acme', workspace: null, stream: 'fix/y' } });
    const c = emit({
      at: '2026-05-11T10:05:00.000Z',
      collectorId: 'git',
      kind: 'git.commit',
      context: { projectKey: 'acme', workspace: null, stream: null },
      title: 'Fix the thing',
    });

    units.group();
    const [unit] = units.currentUnits();
    expect([...units.memberIds(unit!.id)].sort()).toEqual([s, c].sort());
  });

  it('does not group across projects', () => {
    session(4);
    emit({
      at: '2026-05-04T09:30:00.000Z',
      end: '2026-05-04T10:30:00.000Z',
      context: { projectKey: 'other', workspace: null, stream: 'feat/x' },
    });
    units.group();
    expect(units.currentUnits()).toHaveLength(2);
  });

  it('records who assigned each member and how confident the strategy was', () => {
    session(4);
    units.group();
    const [unit] = units.currentUnits();
    const members = units.members(unit!.id);
    expect(members.every((member) => member.assignedBy === 'strategy')).toBe(true);
    expect(members.every((member) => member.confidence !== null)).toBe(true);
    expect(members.filter((member) => member.role === 'primary')).toHaveLength(1);
  });
});

describe('pinning protects curation', () => {
  it('leaves a pinned unit untouched however the evidence changes', () => {
    session(4);
    units.group();
    const [original] = units.currentUnits();
    const pinned = units.pin(original!.id);

    session(5);
    const report = units.group();

    expect(report.pinnedSkipped).toBe(1);
    expect(report.updated).toBe(0);
    const current = units.currentUnits();
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(pinned);
    expect(current[0]!.pinned).toBe(true);
  });

  it('leaves a pinned unit untouched when the thresholds change', () => {
    // Improving the algorithm must never silently destroy curation. That is
    // the promise pinning exists to keep (ADR-0006).
    session(4);
    units.group();
    units.pin(units.currentUnits()[0]!.id);

    const report = units.group({
      config: { ...DEFAULT_GROUPING_CONFIG, idleGapMinutes: 1, sameStreamGapMinutes: 1 },
    });
    expect(report.pinnedSkipped).toBeGreaterThan(0);
    expect(units.currentUnits()[0]!.pinned).toBe(true);
  });

  it('renaming is a person speaking, so it pins', () => {
    session(4);
    units.group();
    const renamed = units.rename(units.currentUnits()[0]!.id, 'Rebuilt the pricing engine');

    const [unit] = units.currentUnits();
    expect(unit!.id).toBe(renamed);
    expect(unit!.title).toBe('Rebuilt the pricing engine');
    expect(unit!.pinned).toBe(true);
    // Membership assigned by a person carries no confidence — people do not
    // emit them.
    expect(units.members(renamed).every((member) => member.confidence === null)).toBe(true);
  });

  it('unpinning is another record, not an erasure', () => {
    session(4);
    units.group();
    const first = units.currentUnits()[0]!.id;
    const pinned = units.pin(first);
    units.pin(pinned, false);

    expect(units.currentUnits()[0]!.pinned).toBe(false);
    expect(units.byId(pinned)!.pinned).toBe(true);
  });
});

describe('merge and split', () => {
  it('merge produces one unit holding both memberships', () => {
    const a = session(4);
    const b = session(20);
    units.group();
    const [second, first] = units.currentUnits();

    const merged = units.merge(first!.id, second!.id, 'One effort after all');

    const current = units.currentUnits();
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(merged);
    expect(current[0]!.title).toBe('One effort after all');
    expect([...units.memberIds(merged)].sort()).toEqual([a, b].sort());
    // Merged units are curated, so a re-run must not undo the decision — nor
    // helpfully recreate the two units that were just merged away.
    expect(current[0]!.pinned).toBe(true);
    const rerun = units.group();
    expect(rerun.pinnedSkipped).toBe(2);
    expect(units.currentUnits()).toHaveLength(1);
  });

  it('merge spans both originals in time', () => {
    session(4);
    session(20);
    units.group();
    const [second, first] = units.currentUnits();
    const merged = units.merge(first!.id, second!.id);

    const unit = units.byId(merged)!;
    expect(unit.occurredAt.slice(0, 10)).toBe('2026-05-04');
    expect(unit.occurredEnd!.slice(0, 10)).toBe('2026-05-20');
  });

  it('split partitions membership without duplicating it', () => {
    const a = session(4);
    const b = emit({ at: '2026-05-04T11:00:00.000Z', end: '2026-05-04T12:00:00.000Z' });
    units.group();
    const [unit] = units.currentUnits();
    expect(units.memberIds(unit!.id)).toHaveLength(2);

    const [left, right] = units.split(unit!.id, [a]);
    expect(units.currentUnits()).toHaveLength(2);
    expect(units.memberIds(left!)).toEqual([a]);
    expect(units.memberIds(right!)).toEqual([b]);
  });

  it('both are reversible, because the originals are still on record', () => {
    session(4);
    session(20);
    units.group();
    const before = units.currentUnits().map((unit) => unit.id);
    const merged = units.merge(before[0]!, before[1]!);

    // Undo is a question about history, not a special code path.
    for (const id of before) expect(units.byId(id)).not.toBeNull();
    expect(units.byId(merged)!.supersedes).toBe(before[0]);
  });

  it('refuses a split that leaves one side empty', () => {
    const a = session(4);
    units.group();
    const [unit] = units.currentUnits();
    expect(() => units.split(unit!.id, [a])).toThrow(/both sides/);
    expect(() => units.split(unit!.id, [])).toThrow(/both sides/);
  });

  it('refuses to split on evidence that is not a member', () => {
    session(4);
    units.group();
    const [unit] = units.currentUnits();
    expect(() => units.split(unit!.id, ['not-a-member'])).toThrow(/not a member/);
  });

  it('refuses to merge a unit with itself', () => {
    session(4);
    units.group();
    const [unit] = units.currentUnits();
    expect(() => units.merge(unit!.id, unit!.id)).toThrow(/itself/);
  });

  it('refuses to operate on a unit that is no longer current', () => {
    session(4);
    units.group();
    const [unit] = units.currentUnits();
    const pinned = units.pin(unit!.id);
    expect(() => units.rename(unit!.id, 'too late')).toThrow(/superseded/);
    expect(() => units.rename(pinned, 'fine')).not.toThrow();
  });
});
