import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CursorStore,
  EvidenceStore,
  IN_MEMORY,
  closeDatabase,
  deterministicPlatform,
  openDatabase,
} from '@careerforge/store';
import { describeConformance, runCollection, type CollectorEvent } from '@careerforge/collect';

import { buildFixtureRepository, FIXTURE_COMMIT_COUNT } from './fixture.js';
import { GitCollector, gitScopeFor, isGitRepository } from './index.js';

/**
 * The Git collector, and the golden fixture that guards its semantics.
 *
 * The fixture repository is built from pinned inputs, so its commit SHAs are
 * identical on every machine. `golden.json` records exactly what the collector
 * emits from it. Any change to collection semantics — a renamed attribute, a
 * different timestamp, a changed source URI — shows up as a reviewable diff
 * rather than as a surprise in someone's career history months later.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden.json');

let root: string;
let repo: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-git-'));
  repo = buildFixtureRepository(join(root, 'fixture-repo'));
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly.
  }
});

async function drain(path: string, cursor: string | null = null): Promise<CollectorEvent[]> {
  const events: CollectorEvent[] = [];
  for await (const event of new GitCollector().collect(gitScopeFor(path), cursor)) {
    events.push(event);
  }
  return events;
}

async function drafts(path: string, cursor: string | null = null) {
  return (await drain(path, cursor))
    .filter((e) => e.kind === 'evidence')
    .map((e) => (e as Extract<CollectorEvent, { kind: 'evidence' }>).draft);
}

describe('repository detection', () => {
  it('recognises a repository', () => {
    expect(isGitRepository(repo)).toBe(true);
  });

  it('rejects a plain directory and a missing path', () => {
    expect(isGitRepository(root)).toBe(false);
    expect(isGitRepository(join(root, 'nope'))).toBe(false);
  });

  it('discovers a repository directly', async () => {
    const found = await new GitCollector().discover(repo);
    expect(found).toHaveLength(1);
    expect(found[0]!.label).toBe('fixture-repo');
  });

  it('discovers repositories inside a directory', async () => {
    const found = await new GitCollector().discover(root);
    expect(found.map((f) => f.label)).toContain('fixture-repo');
  });

  it('returns nothing for a path that is not a directory', async () => {
    expect(await new GitCollector().discover(join(root, 'absent'))).toEqual([]);
  });
});

describe('the golden fixture', () => {
  it('builds reproducibly — identical SHAs from a second build', () => {
    // The whole golden approach rests on this. If it ever fails, the fixture
    // has an unpinned input and the golden file is meaningless.
    const second = buildFixtureRepository(join(root, 'fixture-repo-2'));
    const shas = (path: string) =>
      execFileSync('git', ['log', '--format=%H'], { cwd: path, encoding: 'utf8' });
    expect(shas(second)).toBe(shas(repo));
  });

  it('emits exactly the recorded evidence', async () => {
    const emitted = await drafts(repo);

    // The workspace is an absolute temp path, so it is excluded — it is
    // machine-specific and deliberately not part of the content hash.
    const comparable = emitted.map((draft) => ({
      ...draft,
      context: { ...draft.context, workspace: '<workspace>' },
    }));

    if (!existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(comparable, null, 2)}\n`, 'utf8');
      throw new Error(
        `No golden file existed, so one was written to ${GOLDEN}. Review it carefully and commit it.`,
      );
    }

    const golden: unknown = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(
      comparable,
      'Collection semantics changed. If that was intentional, review the diff and update golden.json.',
    ).toEqual(golden);
  });

  it('covers the commit shapes that actually occur', async () => {
    const emitted = await drafts(repo);
    expect(emitted).toHaveLength(FIXTURE_COMMIT_COUNT);

    const byTitle = new Map(emitted.map((d) => [d.title, d]));

    // A commit body becomes the summary, source-authored and never AI.
    expect(byTitle.get('Implement parsing')?.summary).toContain('three record shapes');

    // Co-authored-by trailers are extracted.
    expect(byTitle.get('Implement parsing')?.attributes['coauthors']).toEqual([
      'Ada Lovelace <ada@example.invalid>',
    ]);

    // A commit with no body has no summary rather than an empty string.
    expect(byTitle.get('Add project skeleton')?.summary).toBeNull();

    // Deletions are counted.
    expect(Number(byTitle.get('Remove dead helper')?.attributes['deletions'])).toBeGreaterThan(0);

    // UTF-8 survives the round trip through the process boundary.
    expect([...byTitle.keys()].some((t) => t.includes('日本語'))).toBe(true);
  });
});

describe('evidence shape', () => {
  it('keys evidence on repository identity, not path', async () => {
    // A re-clone into a different directory is the same history, not a second
    // copy of it.
    const moved = buildFixtureRepository(join(root, 'moved-repo'));
    const original = await drafts(repo);
    const relocated = await drafts(moved);
    expect(relocated.map((d) => d.sourceUri)).toEqual(original.map((d) => d.sourceUri));
  });

  it('produces identical content hashes from two locations', async () => {
    // The stronger claim: not just the same identity, but the same *state*.
    // A path-derived attribute here would make the two supersede each other
    // on every run, forever.
    const moved = join(root, 'moved-repo');
    const a = await drafts(repo);
    const b = await drafts(moved);
    expect(b.map((d) => d.attributes)).toEqual(a.map((d) => d.attributes));
  });

  it('classifies commits as confidential by default', async () => {
    for (const draft of await drafts(repo)) {
      expect(draft.sensitivity).toBe('confidential');
    }
  });

  it('marks evidence as imported, never derived or user-confirmed', async () => {
    for (const draft of await drafts(repo)) {
      expect(draft.evidenceClass).toBe('imported');
    }
  });

  it('hints at grouping without deciding it', async () => {
    // Collectors hint; the core groups (ADR-0006).
    for (const draft of await drafts(repo)) {
      expect(draft.groupingHint).toMatch(/^.+:\d{4}-W\d{2}$/);
    }
  });

  it('uses author time for when the work happened', async () => {
    const first = (await drafts(repo)).find((d) => d.title === 'Add project skeleton');
    expect(first?.occurredAt).toBe('2026-01-15T09:00:00.000Z');
  });
});

describe('cursors and incremental collection', () => {
  it('emits a cursor pointing at the newest commit', async () => {
    const events = await drain(repo);
    const cursor = events.find((e) => e.kind === 'cursor');
    expect(cursor).toBeDefined();

    const newest = execFileSync('git', ['log', '-1', '--format=%H'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    expect((cursor as Extract<CollectorEvent, { kind: 'cursor' }>).cursor).toBe(newest);
  });

  it('collects nothing new when resumed from the newest commit', async () => {
    const newest = execFileSync('git', ['log', '-1', '--format=%H'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    expect(await drafts(repo, newest)).toHaveLength(0);
  });

  it('collects only what is new when resumed from an older commit', async () => {
    const shas = execFileSync('git', ['log', '--format=%H'], { cwd: repo, encoding: 'utf8' })
      .trim()
      .split('\n');
    const secondOldest = shas[shas.length - 2]!;
    const emitted = await drafts(repo, secondOldest);
    expect(emitted.length).toBe(FIXTURE_COMMIT_COUNT - 2);
  });

  it('replays in full rather than collecting nothing when a cursor is gone', async () => {
    // A rebase or a force-push can leave a stored cursor pointing at a commit
    // that no longer exists. Silently collecting nothing would be the worst
    // outcome: the user's history would just stop.
    const events = await drain(repo, '0000000000000000000000000000000000000000');
    const skips = events.filter((e) => e.kind === 'skipped');
    expect(skips.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.kind === 'evidence')).toHaveLength(FIXTURE_COMMIT_COUNT);
  });
});

describe('tolerance', () => {
  it('reports a non-repository as a skip rather than throwing', async () => {
    const plain = join(root, 'not-a-repo');
    mkdirSync(plain, { recursive: true });
    const events = await drain(plain);
    expect(events.filter((e) => e.kind === 'evidence')).toHaveLength(0);
    expect(events.some((e) => e.kind === 'skipped')).toBe(true);
  });

  it('handles a repository with no commits', async () => {
    const empty = join(root, 'empty-repo');
    mkdirSync(empty, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: empty });
    const events = await drain(empty);
    expect(events.filter((e) => e.kind === 'evidence')).toHaveLength(0);
    expect(events.some((e) => e.kind === 'skipped')).toBe(true);
  });
});

describe('integration with the host', () => {
  it('collects into a real store', async () => {
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const platform = deterministicPlatform();
      const store = new EvidenceStore(db, platform);
      const report = await runCollection({
        collector: new GitCollector(),
        scope: gitScopeFor(repo),
        store,
        cursors: new CursorStore(db, platform),
        backfill: true,
      });

      expect(report.emitted).toBe(FIXTURE_COMMIT_COUNT);
      expect(report.inserted).toBe(FIXTURE_COMMIT_COUNT);
      expect(report.skipped).toEqual({});
      expect(store.count()).toBe(FIXTURE_COMMIT_COUNT);
      expect(store.search('parsing')).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('saves a cursor and resumes from it', async () => {
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const platform = deterministicPlatform();
      const store = new EvidenceStore(db, platform);
      const cursors = new CursorStore(db, platform);
      const scope = gitScopeFor(repo);

      await runCollection({ collector: new GitCollector(), scope, store, cursors, backfill: true });
      expect(cursors.read('git', scope.key)).not.toBeNull();

      const second = await runCollection({
        collector: new GitCollector(),
        scope,
        store,
        cursors,
      });
      expect(second.emitted).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});

// The shared contract, run against this collector exactly as a third-party
// collector would run it against theirs.
describeConformance(
  {
    name: 'git',
    create: () => new GitCollector(),
    scope: () => gitScopeFor(repo),
    malformedScopes: () => [
      { label: 'not a repository', scope: gitScopeFor(join(root, 'not-a-repo')) },
      { label: 'repository with no commits', scope: gitScopeFor(join(root, 'empty-repo')) },
      { label: 'path that does not exist', scope: gitScopeFor(join(root, 'absent')) },
    ],
  },
  { describe, it },
);
