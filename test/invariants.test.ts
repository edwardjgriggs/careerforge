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
    // The storage-level enforcement (SQLite triggers) arrives in M2. What is
    // testable today is that the domain offers no mutation vocabulary at all:
    // corrections produce new records, and suppression is a separate record.
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

  it.todo('M2: SQLite triggers reject UPDATE and DELETE on every domain table');
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
  it.todo('M3: export -> rebuild -> export is byte-identical over 10,000 records');
});

describe('I6 — collectors emit records and never write', () => {
  it.todo('M4: CollectorPort exposes no store handle, enforced by type');
  it.todo('M4: the conformance suite asserts collector purity');
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
