import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toInstant, type EvidenceDraft, type Instant } from '@careerforge/domain';

import { BlobStore } from './blobs.js';
import { closeDatabase, openDatabase } from './database.js';
import { EvidenceStore } from './evidence-store.js';
import {
  canonicalJson,
  digestTree,
  EXPORT_FORMAT_VERSION,
  ExportFormatTooNewError,
  exportStore,
  rebuildStore,
} from './export.js';
import { deterministicPlatform } from './platform.js';

/**
 * Export and rebuild — invariant I5.
 *
 * `export -> rebuild -> export` producing byte-identical output is what turns
 * SQLite from a jail into an index (ADR-0004). If the database is corrupted,
 * superseded, or abandoned, no career history is lost. Without this test the
 * guarantee is a sentence in a document.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-export-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle; the OS reclaims the temp directory.
  }
});

const T = (iso: string): Instant => toInstant(iso);

function draft(n: number, overrides: Partial<EvidenceDraft> = {}): EvidenceDraft {
  const month = String((n % 12) + 1).padStart(2, '0');
  return {
    collectorId: 'git',
    sourceUri: `git://repo/commit/${n}`,
    kind: 'git.commit',
    evidenceClass: 'imported',
    sensitivity: 'confidential',
    occurredAt: T(`2026-${month}-18T14:02:11.000Z`),
    occurredEnd: null,
    context: { projectKey: 'careerforge', workspace: null, stream: 'main' },
    title: `Commit ${n}`,
    summary: n % 3 === 0 ? `Body for ${n}` : null,
    excerpt: n % 5 === 0 ? null : `diff excerpt ${n}`,
    payloadRef: null,
    attributes: { repo: 'careerforge', insertions: n, tags: ['b', 'a'] },
    groupingHint: 'careerforge:main:2026-W30',
    collectorVersion: '1.0.0',
    sourceFormatVersion: null,
    ...overrides,
  };
}

interface Harness {
  readonly store: EvidenceStore;
  readonly close: () => void;
  readonly db: ReturnType<typeof openDatabase>['db'];
}

function open(name: string): Harness {
  const { db } = openDatabase({ path: join(dir, `${name}.db`) });
  return {
    db,
    store: new EvidenceStore(db, deterministicPlatform()),
    close: () => closeDatabase(db),
  };
}

/** Every file in an export tree, keyed by relative path. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = prefix === '' ? entry : `${prefix}/${entry}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.set(rel, readFileSync(full, 'utf8'));
    }
  };
  walk(root, '');
  return files;
}

function expectIdentical(a: Map<string, string>, b: Map<string, string>): void {
  expect([...b.keys()].sort(), 'file lists differ').toEqual([...a.keys()].sort());
  const differing = [...a.keys()].filter((key) => a.get(key) !== b.get(key));
  expect(differing, 'files whose bytes differ').toEqual([]);
}

describe('canonical serialisation', () => {
  it('sorts keys at every level', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a.indexOf('"a"')).toBeLessThan(a.indexOf('"b"'));
  });

  it('preserves array order — arrays are data, objects are records', () => {
    expect(canonicalJson({ xs: [3, 1, 2] })).toContain('3');
    expect(JSON.parse(canonicalJson({ xs: [3, 1, 2] }))).toEqual({ xs: [3, 1, 2] });
  });

  it('ends with a newline, so files are POSIX-clean and diff well', () => {
    expect(canonicalJson({ a: 1 }).endsWith('\n')).toBe(true);
  });
});

describe('export', () => {
  it('writes the whole log, not just current state', () => {
    const h = open('a');
    try {
      h.store.emit(draft(1, { title: 'v1' }));
      h.store.emit(draft(1, { title: 'v2' }));
      const report = exportStore(h.db, join(dir, 'export'));
      // Rebuilding current state requires the history that produced it.
      expect(report.counts.evidence).toBe(2);
      expect(h.store.count()).toBe(1);
    } finally {
      h.close();
    }
  });

  it('partitions by the month the work happened', () => {
    const h = open('a');
    try {
      h.store.emit(draft(0, { occurredAt: T('2024-03-01T00:00:00.000Z') }));
      exportStore(h.db, join(dir, 'export'));
      const files = [...snapshot(join(dir, 'export')).keys()];
      expect(files.some((f) => f.startsWith('evidence/2024/03/'))).toBe(true);
    } finally {
      h.close();
    }
  });

  it('is idempotent — re-exporting unchanged data writes nothing', () => {
    const h = open('a');
    try {
      for (let n = 0; n < 20; n++) h.store.emit(draft(n));
      const root = join(dir, 'export');
      const first = exportStore(h.db, root);
      expect(first.written).toBeGreaterThan(0);

      const second = exportStore(h.db, root);
      expect(second.written, 'a no-op export rewrote files').toBe(0);
      expect(second.digest).toBe(first.digest);
    } finally {
      h.close();
    }
  });

  it('contains no generation timestamp', () => {
    // A timestamp would make two exports of identical data differ, defeating
    // both determinism and the round-trip invariant, and would make every
    // sync push a change.
    const h = open('a');
    try {
      h.store.emit(draft(1));
      exportStore(h.db, join(dir, 'export'));
      const manifest = readFileSync(join(dir, 'export', 'manifest.json'), 'utf8');
      expect(manifest).not.toMatch(/exportedAt|generatedAt|timestamp/i);
    } finally {
      h.close();
    }
  });

  it('records a purged body as absent rather than dropping the record', () => {
    const h = open('a');
    try {
      const emitted = h.store.emit(draft(1));
      h.store.tombstone(emitted.evidence.id, 'purged', 'held a credential');
      exportStore(h.db, join(dir, 'export'));

      const files = snapshot(join(dir, 'export'));
      const evidenceFile = [...files.entries()].find(([k]) => k.startsWith('evidence/'))![1];
      const parsed = JSON.parse(evidenceFile) as { content: unknown; contentHash: string };
      expect(parsed.content).toBeNull();
      // The spine survives, so the record still explains itself (ADR-0015).
      expect(parsed.contentHash).toBe(emitted.evidence.contentHash);
    } finally {
      h.close();
    }
  });
});

describe('rebuild', () => {
  it('reconstructs the store from the export alone', () => {
    const source = open('source');
    const root = join(dir, 'export');
    try {
      for (let n = 0; n < 25; n++) source.store.emit(draft(n));
      source.store.emit(draft(3, { title: 'Commit 3 corrected' }));
      const emitted = source.store.emit(draft(99));
      source.store.tombstone(emitted.evidence.id, 'hidden', 'not career relevant');
      exportStore(source.db, root);
    } finally {
      source.close();
    }

    const target = open('target');
    try {
      const report = rebuildStore(target.db, root);
      expect(report.counts.evidence).toBe(27);
      // Current state is derived, and derives identically.
      expect(target.store.count()).toBe(25);
      expect(target.store.search('corrected')).toHaveLength(1);
    } finally {
      target.close();
    }
  });

  it('refuses to rebuild into a store that already holds evidence', () => {
    const source = open('source');
    const root = join(dir, 'export');
    try {
      source.store.emit(draft(1));
      exportStore(source.db, root);
    } finally {
      source.close();
    }

    const target = open('target');
    try {
      target.store.emit(draft(50));
      expect(() => rebuildStore(target.db, root)).toThrow(/already holds/);
      expect(() => rebuildStore(target.db, root)).toThrow(/sync, not rebuild/);
    } finally {
      target.close();
    }
  });

  it('refuses an export whose files no longer match its manifest', () => {
    const source = open('source');
    const root = join(dir, 'export');
    try {
      source.store.emit(draft(1));
      exportStore(source.db, root);
    } finally {
      source.close();
    }

    const files = [...snapshot(root).keys()].filter((f) => f.startsWith('evidence/'));
    const tampered = join(root, ...files[0]!.split('/'));
    const document = JSON.parse(readFileSync(tampered, 'utf8')) as Record<string, unknown>;
    document['title'] = 'tampered';
    writeFileSync(tampered, canonicalJson(document));

    const target = open('target');
    try {
      expect(() => rebuildStore(target.db, root)).toThrow(/inconsistent with its manifest/);
    } finally {
      target.close();
    }
  });

  it('refuses an export written in a newer format', () => {
    const source = open('source');
    const root = join(dir, 'export');
    try {
      source.store.emit(draft(1));
      exportStore(source.db, root);
    } finally {
      source.close();
    }

    const manifestPath = join(root, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['exportFormatVersion'] = EXPORT_FORMAT_VERSION + 1;
    writeFileSync(manifestPath, canonicalJson(manifest));

    const target = open('target');
    try {
      expect(() => rebuildStore(target.db, root)).toThrow(ExportFormatTooNewError);
    } finally {
      target.close();
    }
  });

  it('explains itself when pointed at a directory that is not an export', () => {
    const target = open('target');
    try {
      expect(() => rebuildStore(target.db, join(dir, 'nowhere'))).toThrow(/export manifest/);
    } finally {
      target.close();
    }
  });
});

describe('I5 — round-trip fidelity at scale', () => {
  it('export -> rebuild -> export is byte-identical over 10,000 records', () => {
    const RECORDS = 10_000;
    const first = join(dir, 'export-1');
    const second = join(dir, 'export-2');

    const source = open('source');
    try {
      const seed = source.db.transaction(() => {
        for (let n = 0; n < RECORDS; n++) source.store.emit(draft(n));
      });
      seed();
      // A realistic log, not a uniform one: corrections, suppression, and a
      // purge, so the round trip covers every record shape that can exist.
      for (let n = 0; n < 200; n++) source.store.emit(draft(n, { title: `Commit ${n} revised` }));
      const hidden = source.store.emit(draft(20_001));
      source.store.tombstone(hidden.evidence.id, 'hidden');
      const purged = source.store.emit(draft(20_002));
      source.store.tombstone(purged.evidence.id, 'purged');

      exportStore(source.db, first);
    } finally {
      source.close();
    }

    const target = open('target');
    try {
      rebuildStore(target.db, first);
      exportStore(target.db, second);
    } finally {
      target.close();
    }

    expectIdentical(snapshot(first), snapshot(second));
    expect(digestTree(second)).toBe(digestTree(first));
  }, 120_000);
});

describe('end-to-end: collect, export, rebuild, re-collect, export', () => {
  /**
   * The scenario that validates rebuild, canonicalisation, idempotency, and
   * append-only behaviour together.
   *
   * It is the shape of a real recovery: a user loses a machine, rebuilds from
   * their synced export, and runs collection again over the same repositories.
   * Nothing about their history should change.
   */
  it('re-collecting identical evidence after a rebuild changes nothing', () => {
    const CORPUS = Array.from({ length: 300 }, (_, n) => draft(n));
    const firstExport = join(dir, 'export-1');
    const secondExport = join(dir, 'export-2');

    // 1. Collect, 2. Export.
    const original = open('original');
    try {
      for (const d of CORPUS) original.store.emit(d);
      original.store.emit(draft(7, { title: 'Commit 7 corrected' }));
      const gone = original.store.emit(draft(9_001));
      original.store.tombstone(gone.evidence.id, 'hidden');
      exportStore(original.db, firstExport);
    } finally {
      original.close();
    }

    // 3. Rebuild into a fresh store.
    const rebuilt = open('rebuilt');
    try {
      rebuildStore(rebuilt.db, firstExport);
      const countAfterRebuild = rebuilt.store.count();

      // 4. Collect the exact same evidence again — in a different order, and
      //    twice, because a real re-run controls neither.
      const shuffled = [...CORPUS].reverse();
      for (const d of shuffled) rebuilt.store.emit(d);
      for (const d of CORPUS) rebuilt.store.emit(d);

      expect(rebuilt.store.count(), 're-collection changed the current record count').toBe(
        countAfterRebuild,
      );

      // 5. Export again.
      exportStore(rebuilt.db, secondExport);
    } finally {
      rebuilt.close();
    }

    // 6. Byte-identical.
    expectIdentical(snapshot(firstExport), snapshot(secondExport));
    expect(digestTree(secondExport)).toBe(digestTree(firstExport));
  }, 120_000);

  it('a suppressed record stays suppressed across rebuild and re-collection', () => {
    const root = join(dir, 'export');
    const d = draft(1);

    const original = open('original');
    let suppressedId: string;
    try {
      const emitted = original.store.emit(d);
      suppressedId = emitted.evidence.id;
      original.store.tombstone(emitted.evidence.id, 'hidden', 'private');
      exportStore(original.db, root);
    } finally {
      original.close();
    }

    const rebuilt = open('rebuilt');
    try {
      rebuildStore(rebuilt.db, root);
      expect(rebuilt.store.count()).toBe(0);
      for (let i = 0; i < 5; i++) rebuilt.store.emit(d);
      expect(rebuilt.store.count(), 're-collection resurrected a suppressed record').toBe(0);
      expect(rebuilt.store.byId(suppressedId as never)).toBeNull();
    } finally {
      rebuilt.close();
    }
  });
});

describe('blob store', () => {
  it('addresses by content, so identical bytes are stored once', () => {
    const blobs = new BlobStore(join(dir, 'blobs'));
    const a = blobs.put('the same bytes');
    const b = blobs.put('the same bytes');
    expect(a).toBe(b);
  });

  it('round-trips content', () => {
    const blobs = new BlobStore(join(dir, 'blobs'));
    const ref = blobs.put('transcript excerpt');
    expect(blobs.get(ref)?.toString('utf8')).toBe('transcript excerpt');
    expect(blobs.has(ref)).toBe(true);
    expect(blobs.size(ref)).toBe(18);
  });

  it('distinguishes different content', () => {
    const blobs = new BlobStore(join(dir, 'blobs'));
    expect(blobs.put('a')).not.toBe(blobs.put('b'));
  });

  it('shards directories so no single one grows unbounded', () => {
    const blobs = new BlobStore(join(dir, 'blobs'));
    const ref = blobs.put('x');
    const hash = ref.replace('blob:sha256-', '');
    expect(existsSync(join(dir, 'blobs', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash))).toBe(
      true,
    );
  });

  it('prunes without breaking the reference', () => {
    // A pruned blob means "we no longer keep the bytes", not "the store is
    // corrupt". The reference stays a valid statement about what was collected.
    const blobs = new BlobStore(join(dir, 'blobs'));
    const ref = blobs.put('prunable');
    expect(blobs.prune(ref)).toBe(true);
    expect(blobs.has(ref)).toBe(false);
    expect(blobs.get(ref)).toBeNull();
    expect(blobs.prune(ref)).toBe(false);
  });

  it('rejects a malformed reference rather than guessing', () => {
    const blobs = new BlobStore(join(dir, 'blobs'));
    expect(() => blobs.get('not-a-ref')).toThrow(/Not a blob reference/);
  });

  it('is not included in the export by default', () => {
    // Blobs are where the sensitive bulk lives; exporting them is opt-in per
    // project (ADR-0004).
    const h = open('a');
    try {
      h.store.emit(draft(1));
      exportStore(h.db, join(dir, 'export'));
      expect([...snapshot(join(dir, 'export')).keys()].some((f) => f.includes('blob'))).toBe(false);
    } finally {
      h.close();
    }
  });
});
