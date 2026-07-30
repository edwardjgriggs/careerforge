import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toInstant, type EvidenceDraft, type EvidenceId, type Instant } from '@careerforge/domain';

import { closeDatabase, IN_MEMORY, openDatabase } from './database.js';
import { EvidenceStore } from './evidence-store.js';
import type { Db } from './migrations/index.js';
import { deterministicPlatform } from './platform.js';

/**
 * Convergence: repeated ingestion of the same logical evidence, in arbitrary
 * order, must always reach the same current state.
 *
 * This is the property that makes collection safe to run at all. A backfill
 * overlapping an incremental run, a resumed job replaying records it already
 * emitted, two devices collecting the same repository — every one of them
 * feeds the same artifact in more than once, in an order nobody controls. If
 * the store did not converge, a user's history would drift a little on every
 * run, and nothing downstream could be trusted.
 *
 * It exercises the whole persistence stack at once, which is the point:
 *
 *   canonicalisation   order-independent content hashing
 *   natural keys       identity across collectors and runs
 *   uniqueness         the (natural_key, content_hash) constraint
 *   append-only        supersession instead of mutation
 *   _current views     resolving what is true now
 */

let db: Db;
let store: EvidenceStore;

beforeEach(() => {
  db = openDatabase({ path: IN_MEMORY }).db;
  store = new EvidenceStore(db, deterministicPlatform());
});

afterEach(() => {
  closeDatabase(db);
});

const T = (iso: string): Instant => toInstant(iso);

interface DraftOptions {
  readonly sourceUri: string;
  readonly title?: string;
  readonly attributes?: Record<string, string | number | readonly string[]>;
  readonly collectorId?: string;
  readonly excerpt?: string | null;
}

function draft(options: DraftOptions): EvidenceDraft {
  return {
    collectorId: options.collectorId ?? 'git',
    sourceUri: options.sourceUri,
    kind: 'git.commit',
    evidenceClass: 'imported',
    sensitivity: 'confidential',
    occurredAt: T('2026-07-18T14:02:11.000Z'),
    occurredEnd: null,
    context: { projectKey: 'careerforge', workspace: null, stream: 'main' },
    title: options.title ?? 'Add tolerant parser',
    summary: null,
    excerpt: options.excerpt === undefined ? 'diff excerpt' : options.excerpt,
    payloadRef: null,
    attributes: options.attributes ?? { repo: 'careerforge', insertions: 412 },
    groupingHint: 'careerforge:main:2026-W30',
    collectorVersion: '1.0.0',
    sourceFormatVersion: null,
  };
}

/** The observable current state, independent of ids and ingestion timing. */
function currentState(s: EvidenceStore): unknown {
  return s
    .all()
    .map((e) => ({
      naturalKey: e.naturalKey,
      contentHash: e.contentHash,
      kind: e.kind,
      title: e.title,
      excerpt: e.excerpt,
      attributes: e.attributes,
      occurredAt: e.occurredAt,
      sensitivity: e.sensitivity,
    }))
    .sort((a, b) => (a.naturalKey < b.naturalKey ? -1 : a.naturalKey > b.naturalKey ? 1 : 0));
}

/** Deterministic shuffle, so a failure is reproducible from its seed. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed || 1;
  const next = () => {
    // xorshift32 — no Math.random, so a failing case can be replayed exactly.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.abs(state);
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('idempotency', () => {
  it('repeated emission of an identical artifact stores exactly one record', () => {
    const d = draft({ sourceUri: 'git://repo/commit/aaa' });
    const results = Array.from({ length: 100 }, () => store.emit(d));

    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(store.count()).toBe(1);
    expect(store.history(results[0]!.evidence.naturalKey)).toHaveLength(1);
  });

  it('is unaffected by attribute insertion order', () => {
    // Two collectors — or one collector across two runs — may build the same
    // object with keys in a different order. That is not a change.
    store.emit(draft({ sourceUri: 'git://repo/commit/aaa', attributes: { repo: 'cf', n: 1 } }));
    store.emit(draft({ sourceUri: 'git://repo/commit/aaa', attributes: { n: 1, repo: 'cf' } }));
    expect(store.count()).toBe(1);
  });

  it('is unaffected by array member order', () => {
    store.emit(
      draft({ sourceUri: 'git://repo/commit/aaa', attributes: { coauthors: ['ada', 'grace'] } }),
    );
    store.emit(
      draft({ sourceUri: 'git://repo/commit/aaa', attributes: { coauthors: ['grace', 'ada'] } }),
    );
    expect(store.count()).toBe(1);
  });

  it('treats a different source as a different artifact', () => {
    store.emit(draft({ sourceUri: 'git://repo/commit/aaa' }));
    store.emit(draft({ sourceUri: 'git://repo/commit/bbb' }));
    expect(store.count()).toBe(2);
  });

  it('treats the same source from a different collector as a different artifact', () => {
    store.emit(draft({ sourceUri: 'shared://thing', collectorId: 'git' }));
    store.emit(draft({ sourceUri: 'shared://thing', collectorId: 'session' }));
    expect(store.count()).toBe(2);
  });
});

describe('change detection', () => {
  it('supersedes rather than mutating when content changes', () => {
    const first = store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'v1' }));
    const second = store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'v2' }));

    expect(second.inserted).toBe(true);
    expect(second.superseded).toBe(first.evidence.id);
    expect(store.count()).toBe(1);
    expect(store.byNaturalKey(first.evidence.naturalKey)?.title).toBe('v2');
    // Both rows survive; only one is current.
    expect(store.history(first.evidence.naturalKey)).toHaveLength(2);
  });

  it('converges on the final state through a long chain of edits', () => {
    const titles = ['v1', 'v2', 'v3', 'v4', 'v5'];
    for (const title of titles) {
      store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title }));
    }
    expect(store.count()).toBe(1);
    expect(store.all()[0]!.title).toBe('v5');
    expect(store.history(store.all()[0]!.naturalKey)).toHaveLength(5);
  });

  it('re-emitting an earlier revision does not resurrect it as current', () => {
    // A collector that flips a value back and forth must not violate the
    // unique constraint, and must not silently make old content current.
    store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'v1' }));
    store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'v2' }));
    expect(() =>
      store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'v1' })),
    ).not.toThrow();
    expect(store.count()).toBe(1);
  });
});

describe('THE convergence property', () => {
  /**
   * The precise claim, and its boundary.
   *
   * CLAIM: given a set of collected facts, ingesting them in any order, any
   * number of times, always reaches the same current state.
   *
   * BOUNDARY: "a set of facts" means each artifact appears with one content
   * state. Two *different* states of the same artifact are not a set of facts
   * ingested out of order — they are a change over time, and which is current
   * legitimately depends on which was collected later. Full order-independence
   * there would be wrong, not merely hard: it would mean a correction could
   * not correct anything.
   *
   * What must hold, and does, is the case that actually occurs in production:
   * once a state has been recorded, re-presenting it never changes anything.
   * That is what makes a backfill overlapping an incremental run safe, and it
   * is exercised below by replaying the entire corpus *after* the revisions.
   */
  const CORPUS: readonly EvidenceDraft[] = [
    draft({ sourceUri: 'git://repo/commit/001' }),
    draft({ sourceUri: 'git://repo/commit/002', title: 'Second commit' }),
    draft({ sourceUri: 'git://repo/commit/003', attributes: { repo: 'cf', tags: ['a', 'b'] } }),
    draft({ sourceUri: 'git://repo/commit/003', attributes: { tags: ['b', 'a'], repo: 'cf' } }),
    draft({ sourceUri: 'git://repo/commit/004', title: 'Fourth v1' }),
    draft({ sourceUri: 'git://repo/commit/005', excerpt: null }),
    draft({ sourceUri: 'session://proj/abc', collectorId: 'ai-session', title: 'Session work' }),
    draft({ sourceUri: 'git://repo/commit/001' }),
    draft({ sourceUri: 'git://repo/commit/002', title: 'Second commit' }),
  ];

  /**
   * Later revisions, applied after the corpus so the expected outcome is
   * unambiguous however the corpus itself is shuffled.
   */
  const REVISIONS: readonly EvidenceDraft[] = [
    draft({ sourceUri: 'git://repo/commit/004', title: 'Fourth v2' }),
    draft({ sourceUri: 'git://repo/commit/004', title: 'Fourth v3 final' }),
  ];

  function ingest(order: readonly EvidenceDraft[], repetitions: number): unknown {
    const fresh = openDatabase({ path: IN_MEMORY }).db;
    try {
      const s = new EvidenceStore(fresh, deterministicPlatform());
      for (let round = 0; round < repetitions; round++) {
        for (const d of order) s.emit(d);
      }
      for (const d of REVISIONS) s.emit(d);
      // And once more, out of order, after the revisions.
      for (const d of order) s.emit(d);
      return currentState(s);
    } finally {
      closeDatabase(fresh);
    }
  }

  const baseline = () => ingest(CORPUS, 1);

  it('reaches the same current state under 50 different ingestion orders', () => {
    const expected = baseline();
    const divergent: number[] = [];

    for (let seed = 1; seed <= 50; seed++) {
      const actual = ingest(shuffled(CORPUS, seed), 1);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) divergent.push(seed);
    }

    expect(divergent, 'ingestion orders that diverged (seeds)').toEqual([]);
  });

  it('reaches the same current state however many times ingestion repeats', () => {
    const expected = baseline();
    for (const repetitions of [1, 2, 3, 7]) {
      expect(ingest(CORPUS, repetitions), `${repetitions} repetitions`).toEqual(expected);
    }
  });

  it('reaches the same current state under shuffling and repetition together', () => {
    const expected = baseline();
    const divergent: string[] = [];

    for (let seed = 1; seed <= 20; seed++) {
      for (const repetitions of [1, 3]) {
        const actual = ingest(shuffled(CORPUS, seed), repetitions);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          divergent.push(`seed=${seed} reps=${repetitions}`);
        }
      }
    }

    expect(divergent, 'combinations that diverged').toEqual([]);
  });

  it('converges on the newest revision, not whichever arrived last', () => {
    const state = baseline() as { naturalKey: string; title: string }[];
    const fourth = state.find((row) => row.title.startsWith('Fourth'));
    expect(fourth?.title).toBe('Fourth v3 final');
  });

  it('stores one current record per logical artifact', () => {
    const state = baseline() as { naturalKey: string }[];
    const keys = state.map((row) => row.naturalKey);
    expect(new Set(keys).size, 'duplicate natural keys in current state').toBe(keys.length);
    // 5 git commits + 1 session artifact.
    expect(keys).toHaveLength(6);
  });

  it('keeps full history even though current state converged', () => {
    const fresh = openDatabase({ path: IN_MEMORY }).db;
    try {
      const s = new EvidenceStore(fresh, deterministicPlatform());
      for (const d of [...CORPUS, ...REVISIONS, ...CORPUS]) s.emit(d);
      const fourth = s.all().find((e) => e.title.startsWith('Fourth'))!;
      // v1, v2, v3 — nothing was overwritten on the way to convergence.
      expect(s.history(fourth.naturalKey)).toHaveLength(3);
    } finally {
      closeDatabase(fresh);
    }
  });
});

describe('convergence survives suppression', () => {
  it('a tombstoned record stays absent however often it is re-emitted', () => {
    const d = draft({ sourceUri: 'git://repo/commit/aaa' });
    const first = store.emit(d);
    store.tombstone(first.evidence.id, 'hidden');
    expect(store.count()).toBe(0);

    for (let i = 0; i < 10; i++) store.emit(d);
    expect(store.count(), 're-emission resurrected a suppressed record').toBe(0);
  });

  it('purging destroys content while the spine and history survive', () => {
    const d = draft({ sourceUri: 'git://repo/commit/aaa' });
    const first = store.emit(d);
    const naturalKey = first.evidence.naturalKey;

    store.tombstone(first.evidence.id, 'purged', 'contained a credential');

    // Content is gone; the record of what was collected is not (ADR-0015).
    const history = store.history(naturalKey);
    expect(history).toHaveLength(1);
    expect(history[0]!.excerpt).toBeNull();
    expect(history[0]!.contentHash).toBe(first.evidence.contentHash);
  });

  it('removes purged content from the search index', () => {
    const first = store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'Secret parser' }));
    expect(store.search('parser')).toHaveLength(1);
    store.tombstone(first.evidence.id, 'purged');
    expect(store.search('parser')).toHaveLength(0);
  });
});

describe('search', () => {
  it('finds evidence with no API key and no network', () => {
    store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'Intune compliance policies' }));
    store.emit(draft({ sourceUri: 'git://repo/commit/bbb', title: 'Unrelated refactor' }));
    const hits = store.search('Intune');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe('Intune compliance policies');
  });

  it('does not return superseded revisions', () => {
    store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'Original wording' }));
    store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'Replacement wording' }));
    expect(store.search('Original')).toHaveLength(0);
    expect(store.search('Replacement')).toHaveLength(1);
  });

  it('rebuilds the index from base tables', () => {
    store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'Findable' }));
    db.prepare(`DELETE FROM evidence_fts`).run();
    expect(store.search('Findable')).toHaveLength(0);
    expect(store.reindex()).toBe(1);
    expect(store.search('Findable')).toHaveLength(1);
  });
});

describe('reads never touch base tables directly', () => {
  it('a suppressed record is absent from every read path', () => {
    // Adding a read path means adding it here. This is the guard against a
    // tombstoned record eventually surfacing in an exported resume.
    const first = store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'Hide me' }));
    store.tombstone(first.evidence.id, 'hidden');

    expect(store.all()).toEqual([]);
    expect(store.byId(first.evidence.id)).toBeNull();
    expect(store.byNaturalKey(first.evidence.naturalKey)).toBeNull();
    expect(store.search('Hide')).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it('suppressing a correction makes the record it replaced current again', () => {
    // Otherwise removing a bad correction would orphan the good original,
    // leaving the user with nothing where they had something.
    const first = store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'Good original' }));
    const second = store.emit(draft({ sourceUri: 'git://repo/commit/aaa', title: 'Bad edit' }));
    expect(store.all()[0]!.title).toBe('Bad edit');

    store.tombstone(second.evidence.id, 'hidden');
    expect(store.all().map((e) => e.title)).toEqual(['Good original']);
    expect(store.byId(first.evidence.id as EvidenceId)?.title).toBe('Good original');
  });
});
