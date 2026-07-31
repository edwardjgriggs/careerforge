import { describe, expect, it } from 'vitest';

import {
  CLAIM_TYPES,
  evaluateSupport,
  isInterpretationOnly,
  isSupported,
  resolveMetricSource,
  type ClaimType,
  type SupportNode,
} from './claims.js';
import type { EnrichmentId, EvidenceId, WorkUnitId } from './ids.js';

/**
 * The claim-support rule, tested exhaustively.
 *
 * This is the most important test in CareerForge. It is the executable form
 * of the promise the product is built on: the tool will not invent your
 * accomplishments. It runs long before any provider exists, because the rule
 * is a domain rule that constrains a generator — not a feature of one.
 *
 * The strategy is a cross-product over every meaningful support configuration,
 * checked against an oracle transcribed directly from `Architecture.md` §5.2
 * rather than derived from the implementation. If the implementation and the
 * specification ever disagree, this fails.
 */

const evidence = (
  evidenceClass: 'imported' | 'derived' | 'user_confirmed',
  corroborating: boolean,
  label: string,
): SupportNode => ({
  kind: 'evidence',
  id: label as EvidenceId,
  evidenceClass,
  ...(corroborating ? { corroborating: true } : {}),
});

const UNIVERSE: readonly { readonly label: string; readonly node: SupportNode }[] = [
  { label: 'imported', node: evidence('imported', false, 'e-imp') },
  { label: 'imported+corroborating', node: evidence('imported', true, 'e-imp-c') },
  { label: 'derived', node: evidence('derived', false, 'e-der') },
  { label: 'derived+corroborating', node: evidence('derived', true, 'e-der-c') },
  { label: 'user_confirmed', node: evidence('user_confirmed', false, 'e-con') },
  { label: 'user_confirmed+corroborating', node: evidence('user_confirmed', true, 'e-con-c') },
  { label: 'work_unit', node: { kind: 'work_unit', id: 'wu-1' as WorkUnitId } },
  { label: 'enrichment', node: { kind: 'enrichment', id: 'en-1' as EnrichmentId } },
];

/** Every subset of the universe: 2^8 = 256 support configurations. */
function allSubsets(): { label: string; support: SupportNode[] }[] {
  const out: { label: string; support: SupportNode[] }[] = [];
  for (let mask = 0; mask < 1 << UNIVERSE.length; mask++) {
    const chosen = UNIVERSE.filter((_, i) => (mask & (1 << i)) !== 0);
    out.push({
      label: chosen.length === 0 ? '(empty)' : chosen.map((c) => c.label).join(' + '),
      support: chosen.map((c) => c.node),
    });
  }
  return out;
}

/**
 * The specification, transcribed from `Architecture.md` §5.2.
 *
 * Written to mirror the table a human would read, deliberately not sharing
 * code with the implementation. Duplication is the point — an oracle that
 * imports the thing it checks proves nothing.
 *
 *   action   >=1 Evidence or Work Unit
 *   scope    >=1 Evidence with a matching attribute value
 *   role     >=1 user_confirmed Evidence   -- never inferred
 *   metric   derived or user_confirmed     -- never model-generated
 *   outcome  evidence that observed the result   -- never the work itself
 *
 * Two preconditions apply to every type: there must be support at all, and
 * AI interpretation alone is never support.
 */
function oracle(claimType: ClaimType, support: readonly SupportNode[]): boolean {
  if (support.length === 0) return false;
  if (support.every((n) => n.kind === 'enrichment')) return false;

  const ev = support.filter((n) => n.kind === 'evidence');
  const hasWorkUnit = support.some((n) => n.kind === 'work_unit');

  switch (claimType) {
    case 'action':
      return ev.length > 0 || hasWorkUnit;
    case 'scope':
      return ev.some((n) => n.corroborating === true);
    case 'role':
      return ev.some((n) => n.evidenceClass === 'user_confirmed');
    case 'metric':
      return ev.some((n) => n.evidenceClass === 'derived' || n.evidenceClass === 'user_confirmed');
    case 'outcome':
      return ev.some(
        (n) =>
          n.recordsOutcome === true ||
          n.evidenceClass === 'derived' ||
          n.evidenceClass === 'user_confirmed',
      );
  }
}

describe('evaluateSupport — exhaustive cross-product', () => {
  const subsets = allSubsets();

  it('covers 256 support configurations across 5 claim types', () => {
    expect(subsets).toHaveLength(256);
    expect(CLAIM_TYPES).toHaveLength(5);
  });

  for (const claimType of CLAIM_TYPES) {
    it(`matches the specification for every support set — ${claimType}`, () => {
      const disagreements: string[] = [];
      for (const { label, support } of subsets) {
        const actual = evaluateSupport(claimType, support).supported;
        const expected = oracle(claimType, support);
        if (actual !== expected) {
          disagreements.push(`${claimType} with [${label}]: got ${actual}, spec says ${expected}`);
        }
      }
      expect(disagreements).toEqual([]);
    });
  }
});

describe('the universal rule — AI interpretation alone is never support', () => {
  const enrichmentOnly: SupportNode[] = [
    { kind: 'enrichment', id: 'en-1' as EnrichmentId },
    { kind: 'enrichment', id: 'en-2' as EnrichmentId },
  ];

  for (const claimType of CLAIM_TYPES) {
    it(`rejects an enrichment-only ${claimType} claim`, () => {
      const verdict = evaluateSupport(claimType, enrichmentOnly);
      expect(verdict.supported).toBe(false);
      if (!verdict.supported) expect(verdict.code).toBe('interpretation_only');
    });
  }

  it('identifies interpretation-only support', () => {
    expect(isInterpretationOnly(enrichmentOnly)).toBe(true);
    expect(isInterpretationOnly([])).toBe(false);
    expect(isInterpretationOnly([...enrichmentOnly, evidence('imported', false, 'e')])).toBe(false);
  });

  it('allows an enrichment to accompany real support without being the support', () => {
    const support = [evidence('user_confirmed', true, 'e'), ...enrichmentOnly];
    for (const claimType of CLAIM_TYPES) {
      expect(evaluateSupport(claimType, support).supported, claimType).toBe(true);
    }
  });
});

describe('empty support', () => {
  for (const claimType of CLAIM_TYPES) {
    it(`rejects a ${claimType} claim with no support at all`, () => {
      const verdict = evaluateSupport(claimType, []);
      expect(verdict.supported).toBe(false);
      if (!verdict.supported) expect(verdict.code).toBe('no_support');
    });
  }
});

describe('role claims are never inferred', () => {
  it('rejects leadership supported only by observed activity', () => {
    // Three commits touching a shared config. A generator that concludes
    // "led a cross-functional initiative" from this has written resume fraud
    // on the user's behalf.
    const commits = [
      evidence('imported', false, 'c1'),
      evidence('imported', false, 'c2'),
      evidence('imported', false, 'c3'),
    ];
    const verdict = evaluateSupport('role', commits);
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) expect(verdict.code).toBe('role_requires_confirmation');
  });

  it('rejects leadership supported by a work unit', () => {
    expect(isSupported('role', [{ kind: 'work_unit', id: 'wu' as WorkUnitId }])).toBe(false);
  });

  it('rejects leadership supported by derived metrics', () => {
    expect(isSupported('role', [evidence('derived', true, 'd')])).toBe(false);
  });

  it('accepts leadership the user confirmed', () => {
    expect(isSupported('role', [evidence('user_confirmed', false, 'a')])).toBe(true);
  });
});

describe('metric claims are never model-generated', () => {
  it('rejects a number supported only by imported evidence', () => {
    const verdict = evaluateSupport('metric', [evidence('imported', true, 'i')]);
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) expect(verdict.code).toBe('metric_requires_derived_or_confirmed');
  });

  it('rejects a number supported only by a work unit', () => {
    expect(isSupported('metric', [{ kind: 'work_unit', id: 'wu' as WorkUnitId }])).toBe(false);
  });

  it('accepts a computed number', () => {
    expect(isSupported('metric', [evidence('derived', false, 'd')])).toBe(true);
  });

  it('accepts a number the user confirmed', () => {
    expect(isSupported('metric', [evidence('user_confirmed', false, 'c')])).toBe(true);
  });

  it('reports where a supported number came from', () => {
    expect(resolveMetricSource('metric', [evidence('derived', false, 'd')])).toBe('derived');
    expect(resolveMetricSource('metric', [evidence('user_confirmed', false, 'c')])).toBe(
      'user_confirmed',
    );
  });

  it('prefers derived over confirmed when both are present — computed is reproducible', () => {
    const support = [evidence('derived', false, 'd'), evidence('user_confirmed', false, 'c')];
    expect(resolveMetricSource('metric', support)).toBe('derived');
  });

  it('reports no source for an unsupported metric', () => {
    expect(resolveMetricSource('metric', [evidence('imported', false, 'i')])).toBeNull();
    expect(resolveMetricSource('metric', [])).toBeNull();
  });

  it('reports no source for claims that are not metrics', () => {
    for (const claimType of CLAIM_TYPES.filter((t) => t !== 'metric')) {
      expect(resolveMetricSource(claimType, [evidence('derived', true, 'd')])).toBeNull();
    }
  });
});

describe('scope claims need evidence that carries the value', () => {
  it('rejects a scope figure supported only by evidence that the work happened', () => {
    const verdict = evaluateSupport('scope', [evidence('user_confirmed', false, 'c')]);
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) expect(verdict.code).toBe('scope_requires_corroborating_evidence');
  });

  it('accepts corroborating evidence of any class', () => {
    for (const cls of ['imported', 'derived', 'user_confirmed'] as const) {
      expect(isSupported('scope', [evidence(cls, true, 'e')]), cls).toBe(true);
    }
  });
});

describe('outcome claims need evidence of the result, not of the work', () => {
  it('rejects an outcome supported only by a work unit', () => {
    const verdict = evaluateSupport('outcome', [{ kind: 'work_unit', id: 'wu' as WorkUnitId }]);
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) expect(verdict.code).toBe('outcome_requires_evidence');
  });

  it('rejects an outcome resting on the commit that caused it', () => {
    // This accepted any evidence at all until a generator existed to exploit
    // it. A commit shows the change and says nothing about whether the alerts
    // stopped; treating work as evidence of its own consequence is the
    // inference the product refuses everywhere else. See ADR-0027.
    expect(isSupported('outcome', [evidence('imported', false, 'e')])).toBe(false);
  });

  it('accepts a record that observed the result', () => {
    const observed = { ...evidence('imported', false, 'e'), recordsOutcome: true };
    expect(isSupported('outcome', [observed])).toBe(true);
  });

  it('accepts a computed or confirmed result', () => {
    for (const cls of ['derived', 'user_confirmed'] as const) {
      expect(isSupported('outcome', [evidence(cls, false, 'e')]), cls).toBe(true);
    }
  });

  it('asks what changed rather than telling the user to collect more', () => {
    const verdict = evaluateSupport('outcome', [evidence('imported', false, 'e')]);
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) expect(verdict.remedy.kind).toBe('confirm');
  });
});

describe('action claims are the most permissive', () => {
  it('accepts a work unit alone', () => {
    expect(isSupported('action', [{ kind: 'work_unit', id: 'wu' as WorkUnitId }])).toBe(true);
  });

  it('accepts imported evidence alone', () => {
    expect(isSupported('action', [evidence('imported', false, 'i')])).toBe(true);
  });

  it('is satisfied by any support that is neither empty nor interpretation-only', () => {
    // A property rather than a case: once the two universal preconditions
    // hold, at least one evidence or work-unit node must be present.
    for (const { support } of allSubsets()) {
      if (support.length === 0) continue;
      if (support.every((n) => n.kind === 'enrichment')) continue;
      expect(isSupported('action', support)).toBe(true);
    }
  });
});

describe('every failure carries a reason a user can act on', () => {
  it('never returns an empty explanation', () => {
    for (const claimType of CLAIM_TYPES) {
      for (const { support } of allSubsets()) {
        const verdict = evaluateSupport(claimType, support);
        if (!verdict.supported) {
          expect(verdict.reason.length, `${claimType} reason`).toBeGreaterThan(20);
          expect(verdict.code).toBeTruthy();
        }
      }
    }
  });
});
