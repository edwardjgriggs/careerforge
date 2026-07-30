import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateSupport,
  isExportable,
  isSupportingRelation,
  maxSensitivity,
  suppressedIds,
  type SupportNode,
} from '@careerforge/domain';
import type { EnrichmentId, EvidenceId } from '@careerforge/domain';
import {
  canonicalJson,
  closeDatabase,
  EXPORT_FORMAT_VERSION,
  IN_MEMORY,
  openDatabase,
} from '@careerforge/store';
import { COMMAND_NAMES } from '@careerforge/cli';
import { describeConformance } from '@careerforge/collect';
import { GitCollector } from '@careerforge/collector-git';

/**
 * The invariant ledger.
 *
 * Working principle: *every architectural invariant should eventually have an
 * executable test.* Architecture should increasingly be something the suite
 * enforces rather than something contributors are expected to remember.
 *
 * This file is the ledger of that effort. Each of the six invariants from
 * `Architecture.md` §1.2 appears exactly once, either enforced or explicitly
 * marked as awaiting the milestone that makes it enforceable. Nothing is
 * silently absent.
 *
 * When a milestone lands, its pending entries here become real tests. If this
 * file still says "pending" for something that shipped, that is a bug.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('I1 — the domain layer imports no adapter, no network, no AI', () => {
  it('is enforced by lint (see test/boundaries.test.ts)', () => {
    const config = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');
    expect(config).toContain('Invariant I1');
  });

  it('is enforced by the compiler — domain cannot see Node types at all', () => {
    // Stronger than the architecture asked for. TypeScript 6 stopped
    // auto-including ambient @types, so withholding them makes `import fs`
    // a compile error as well as a lint error.
    const tsconfig: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/domain/tsconfig.json'), 'utf8'),
    );
    const types = (tsconfig as { compilerOptions?: { types?: string[] } }).compilerOptions?.types;
    expect(types ?? []).toEqual([]);
  });

  it('is enforced by the manifest — domain declares no dependencies', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/domain/package.json'), 'utf8'),
    );
    expect((manifest as { dependencies?: object }).dependencies ?? {}).toEqual({});
  });
});

describe('I2 — no UPDATE or DELETE against domain tables', () => {
  it('is expressed in the domain as supersede-and-tombstone', () => {
    const suppressed = suppressedIds([
      {
        id: 'tomb-1' as never,
        targetKind: 'evidence',
        targetId: 'ev-1',
        reason: null,
        scope: 'hidden',
        recordedAt: '2026-07-30T00:00:00.000Z' as never,
      },
    ]);
    expect(suppressed.has('ev-1')).toBe(true);
  });

  it('is enforced by the database, not by convention', () => {
    // Raw SQL, bypassing every repository and every good intention.
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      db.prepare(
        `INSERT INTO evidence (id, schema_version, collector_id, source_uri, natural_key,
           content_hash, kind, evidence_class, sensitivity, occurred_at, recorded_at, collector_version)
         VALUES ('ev-1',1,'git','u','nk','ch','git.commit','imported','public',
                 '2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z','1.0.0')`,
      ).run();
      expect(() => db.prepare(`UPDATE evidence SET kind='x'`).run()).toThrow(/append-only/);
      expect(() => db.prepare(`DELETE FROM evidence`).run()).toThrow(/append-only/);
    } finally {
      closeDatabase(db);
    }
  });

  it('covers every domain table, with no exempt list to remember', () => {
    // ADR-0013 made append-only universal. The per-table coverage check lives
    // in packages/store/src/append-only.test.ts and fails if a table is added
    // without its guards.
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const tables = (
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      const triggers = new Set(
        (
          db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
      expect(tables.filter((t) => !triggers.has(`${t}_no_update`))).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  it('reads resolve current state through views, never base tables', () => {
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const views = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='view'`).all() as { name: string }[]
      ).map((r) => r.name);
      expect(views).toContain('evidence_current');
    } finally {
      closeDatabase(db);
    }
  });
});

describe('I3 — every outbound call passes through the Policy Engine', () => {
  it('is enforced by lint for module imports and the global fetch', () => {
    const config = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');
    expect(config).toContain('Invariant I3');
    expect(config).toContain('no-restricted-globals');
  });

  it('is enforced by CI running the whole suite with no provider credentials', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('no-api-key');
    expect(workflow).toContain('OPENAI_API_KEY');
  });

  it('has its comparison rule available as a pure function', () => {
    // The domain states which sensitivity may go where. It performs no
    // egress and knows nothing about providers.
    expect(maxSensitivity(['public', 'restricted'])).toBe('restricted');
  });

  it.todo('M8: a simulated egress without a matching grant is refused');
  it.todo('M8: every simulated egress writes a PolicyDecision');
});

describe('I4 — every claim resolves to at least one provenance edge', () => {
  it('refuses a claim with no support', () => {
    expect(evaluateSupport('action', []).supported).toBe(false);
  });

  it('refuses a claim supported only by AI interpretation', () => {
    const interpretationOnly: SupportNode[] = [{ kind: 'enrichment', id: 'en-1' as EnrichmentId }];
    expect(evaluateSupport('action', interpretationOnly).supported).toBe(false);
  });

  it('never infers a role claim', () => {
    const activity: SupportNode[] = [
      { kind: 'evidence', id: 'ev-1' as EvidenceId, evidenceClass: 'imported' },
    ];
    expect(evaluateSupport('role', activity).supported).toBe(false);
  });

  it('never accepts a model-generated metric', () => {
    const notComputed: SupportNode[] = [
      { kind: 'evidence', id: 'ev-1' as EvidenceId, evidenceClass: 'imported' },
    ];
    expect(evaluateSupport('metric', notComputed).supported).toBe(false);
  });

  it('keeps interpretation out of the supporting relation set', () => {
    expect(isSupportingRelation('supports')).toBe(true);
    expect(isSupportingRelation('interprets')).toBe(false);
  });

  it.todo('M10: generation refuses to persist a claim with zero supports edges');
});

describe('I5 — the database is reconstructible from the export', () => {
  it('has a rebuild path, and it is a first-class command', () => {
    // The full 10,000-record round trip, and the collect -> export -> rebuild
    // -> re-collect -> export scenario, live in
    // packages/store/src/export.test.ts where the fixtures are.
    expect(COMMAND_NAMES).toContain('export');
    expect(COMMAND_NAMES).toContain('rebuild');
  });

  it('exports deterministically — no timestamp, sorted keys', () => {
    // Determinism is the precondition for the round trip. A generation
    // timestamp would make two exports of identical data differ.
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('versions the export format separately from the schema', () => {
    // ADR-0004: the database may be refactored freely; the export is a
    // long-term contract with the user and changes far less often.
    expect(EXPORT_FORMAT_VERSION).toBeGreaterThan(0);
  });
});

describe('I6 — collectors emit records and never write', () => {
  it('gives collectors nowhere for a store to arrive', () => {
    // Held by the shape of the interface: collect(scope, cursor) takes no
    // database, and the host is the only thing that writes.
    const collector = new GitCollector();
    const surface = new Set(Object.keys(collector));
    for (const forbidden of ['db', 'store', 'database', 'connection']) {
      expect(surface.has(forbidden), `collector exposes ${forbidden}`).toBe(false);
    }
  });

  it('holds every collector to one shared conformance suite', () => {
    // The contract behind "a contributor should not need to understand the
    // whole codebase to write a collector". Exported for third parties to run
    // against their own collectors, in their own repositories.
    expect(typeof describeConformance).toBe('function');
  });

  it('requires backfill of every collector — it is the acquisition model', () => {
    expect(new GitCollector().describe().capabilities.backfill).toBe(true);
  });

  it('requires a declared narrow field set, for tolerant parsing', () => {
    // ADR-0010: depend on a few fields, ignore everything else, survive
    // upstream churn without a release.
    expect(new GitCollector().describe().requiredFields.length).toBeGreaterThan(0);
  });

  it('namespaces every emitted kind by the collector id', () => {
    const manifest = new GitCollector().describe();
    const misnamespaced = manifest.kinds.filter((k) => !k.startsWith(`${manifest.id}.`));
    expect(misnamespaced).toEqual([]);
  });
});

describe('cross-cutting promises', () => {
  it('nothing leaves without human review — the gate is in the export path', () => {
    expect(isExportable({ reviewState: 'draft' })).toBe(false);
    expect(isExportable({ reviewState: 'reviewed' })).toBe(true);
  });

  it('a work unit is as sensitive as its most sensitive member', () => {
    expect(maxSensitivity(['public', 'internal', 'restricted', 'confidential'])).toBe('restricted');
  });

  it('every ADR states the conditions that would overturn it', () => {
    // A decision without falsification conditions is a belief. The ledger
    // principle applies to reasoning as much as to code.
    const adrDir = join(ROOT, 'docs/adr');
    const adrs = readdirSync(adrDir).filter((f) => /^\d{4}-.*\.md$/.test(f));
    expect(adrs.length).toBeGreaterThanOrEqual(12);
    for (const file of adrs) {
      const body = readFileSync(join(adrDir, file), 'utf8');
      expect(body, `${file} is missing a "Revisit if" section`).toContain('Revisit if');
      expect(body, `${file} is missing "Alternatives considered"`).toContain(
        'Alternatives considered',
      );
    }
  });
});
