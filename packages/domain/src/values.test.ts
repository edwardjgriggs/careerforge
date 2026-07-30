import { describe, expect, it } from 'vitest';

import { validateAttributes, type AttributeMap, type AttributeSchema } from './attributes.js';
import {
  canonicalAttributes,
  canonicalContentInput,
  canonicalNaturalKeyInput,
  deriveContentHash,
  deriveNaturalKey,
  hasContentChanged,
  type ContentFingerprint,
} from './keys.js';
import type { Digest } from './primitives.js';
import {
  compareSensitivity,
  isPermittedAt,
  isSensitivity,
  maxSensitivity,
  SENSITIVITY_LEVELS,
  type Sensitivity,
} from './sensitivity.js';
import {
  compareInstants,
  coveringSpan,
  epochMillisOf,
  instantFromEpochMillis,
  isInstant,
  isOrderedSpan,
  toInstant,
  type Instant,
} from './time.js';

const at = (iso: string) => toInstant(iso);

// ─────────────────────────────────────────────────────────────────────────
describe('instants', () => {
  it('accepts ISO-8601 UTC with millisecond precision', () => {
    expect(isInstant('2026-07-30T14:02:11.000Z')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of [
      '2026-07-30T14:02:11Z', // no milliseconds
      '2026-07-30T14:02:11.000+01:00', // not UTC
      '2026-07-30 14:02:11.000Z', // no T
      '2026-13-01T00:00:00.000Z', // impossible month
      '2026-02-30T00:00:00.000Z', // impossible day; Date.parse would roll it forward
      'yesterday',
      '',
    ]) {
      expect(isInstant(bad), bad).toBe(false);
      expect(() => toInstant(bad)).toThrow();
    }
  });

  it('round-trips epoch milliseconds', () => {
    const millis = 1_785_426_070_018;
    expect(epochMillisOf(instantFromEpochMillis(millis))).toBe(millis);
  });

  it('sorts chronologically as strings', () => {
    const instants = [
      at('2026-07-30T14:02:11.000Z'),
      at('2024-01-01T00:00:00.000Z'),
      at('2026-07-30T14:02:11.001Z'),
    ];
    const sorted = [...instants].sort(compareInstants);
    expect(sorted.map(epochMillisOf)).toEqual([...sorted.map(epochMillisOf)].sort((a, b) => a - b));
  });

  it('rejects a non-finite epoch value', () => {
    expect(() => instantFromEpochMillis(Number.NaN)).toThrow(/non-finite/);
  });
});

describe('time spans', () => {
  it('treats a null end as instantaneous', () => {
    expect(isOrderedSpan({ start: at('2026-07-30T00:00:00.000Z'), end: null })).toBe(true);
  });

  it('rejects an end before its start', () => {
    expect(
      isOrderedSpan({
        start: at('2026-07-30T10:00:00.000Z'),
        end: at('2026-07-30T09:00:00.000Z'),
      }),
    ).toBe(false);
  });

  it('covers a set of spans', () => {
    const covering = coveringSpan([
      { start: at('2026-07-14T09:00:00.000Z'), end: at('2026-07-15T17:00:00.000Z') },
      { start: at('2026-07-12T08:00:00.000Z'), end: null },
      { start: at('2026-07-19T09:00:00.000Z'), end: at('2026-07-19T17:40:00.000Z') },
    ]);
    expect(covering?.start).toBe('2026-07-12T08:00:00.000Z');
    expect(covering?.end).toBe('2026-07-19T17:40:00.000Z');
  });

  it('returns null for no spans', () => {
    expect(coveringSpan([])).toBeNull();
  });

  it('uses the start when a lone span has no end', () => {
    const covering = coveringSpan([{ start: at('2026-07-12T08:00:00.000Z'), end: null }]);
    expect(covering?.end).toBe('2026-07-12T08:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('sensitivity', () => {
  it('orders levels from public to restricted', () => {
    const shuffled: Sensitivity[] = ['restricted', 'public', 'confidential', 'internal'];
    expect([...shuffled].sort(compareSensitivity)).toEqual([...SENSITIVITY_LEVELS]);
  });

  it('recognises valid levels only', () => {
    for (const level of SENSITIVITY_LEVELS) expect(isSensitivity(level)).toBe(true);
    for (const bad of ['secret', 'PUBLIC', '', 'toString']) expect(isSensitivity(bad)).toBe(false);
  });

  it('takes the maximum over a set, never the minimum', () => {
    expect(maxSensitivity(['public', 'restricted', 'internal'])).toBe('restricted');
    expect(maxSensitivity(['public', 'public'])).toBe('public');
  });

  it('treats an empty set as public — there is nothing to protect', () => {
    expect(maxSensitivity([])).toBe('public');
  });

  it('lets one restricted member dominate any group', () => {
    // The rule that stops a permissive member downgrading a work unit.
    for (const level of SENSITIVITY_LEVELS) {
      expect(maxSensitivity([level, 'restricted'])).toBe('restricted');
    }
  });

  it('permits egress only up to the granted level', () => {
    expect(isPermittedAt('internal', 'confidential')).toBe(true);
    expect(isPermittedAt('confidential', 'confidential')).toBe(true);
    expect(isPermittedAt('restricted', 'confidential')).toBe(false);
  });

  it('never permits restricted evidence below a restricted grant', () => {
    for (const granted of SENSITIVITY_LEVELS.filter((l) => l !== 'restricted')) {
      expect(isPermittedAt('restricted', granted), granted).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('attributes', () => {
  const schema: AttributeSchema = {
    repo: { type: 'string', description: 'Repository name', required: true },
    insertions: { type: 'number', description: 'Lines added' },
    isMerge: { type: 'boolean', description: 'Merge commit' },
    committedAt: { type: 'instant', description: 'Commit time' },
    coauthors: { type: 'string[]', description: 'Co-authors' },
  };

  it('accepts a well-formed bag', () => {
    const values: AttributeMap = {
      repo: 'careerforge',
      insertions: 412,
      isMerge: false,
      committedAt: at('2026-07-30T14:02:11.000Z'),
      coauthors: ['ada', 'grace'],
    };
    expect(validateAttributes(schema, values)).toEqual({ valid: true });
  });

  it('accepts a bag containing only the required attribute', () => {
    expect(validateAttributes(schema, { repo: 'careerforge' })).toEqual({ valid: true });
  });

  it('rejects a missing required attribute', () => {
    const result = validateAttributes(schema, { insertions: 1 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((i) => i.code)).toContain('missing_required');
  });

  it('rejects an undeclared attribute — a manifest must describe reality', () => {
    const result = validateAttributes(schema, { repo: 'x', sneaky: 'value' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((i) => i.code)).toContain('undeclared_attribute');
    }
  });

  it('rejects a nested object by name, not as a generic type error', () => {
    const result = validateAttributes(schema, {
      repo: 'x',
      insertions: { count: 3 } as unknown as number,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const issue = result.issues.find((i) => i.key === 'insertions');
      expect(issue?.code).toBe('nested_object');
      expect(issue?.message).toContain('flatten');
    }
  });

  it('rejects wrong scalar types', () => {
    const result = validateAttributes(schema, { repo: 42 as unknown as string });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.code).toBe('wrong_type');
  });

  it('rejects NaN and Infinity — they cannot be stored or compared', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateAttributes(schema, { repo: 'x', insertions: value });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.issues[0]?.code).toBe('non_finite_number');
    }
  });

  it('rejects a malformed instant', () => {
    const result = validateAttributes(schema, {
      repo: 'x',
      committedAt: '2026-07-30' as unknown as Instant,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.code).toBe('invalid_instant');
  });

  it('rejects a non-string array member', () => {
    const result = validateAttributes(schema, {
      repo: 'x',
      coauthors: ['ada', 7 as unknown as string],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.code).toBe('non_string_array_member');
  });

  it('reports every issue at once rather than stopping at the first', () => {
    const result = validateAttributes(schema, { insertions: Number.NaN, extra: 'x' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('is not fooled by inherited object properties', () => {
    expect(validateAttributes({}, { toString: 'x' } as AttributeMap).valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('identity derivation', () => {
  /** A fake digest. Injectable hashing is what makes this testable at all. */
  const fakeDigest: Digest = (input) => `h(${input.replace(/\0/g, '|')})`;

  it('derives a stable natural key from collector and source', () => {
    const a = canonicalNaturalKeyInput('git', 'git://repo/commit/abc');
    const b = canonicalNaturalKeyInput('git', 'git://repo/commit/abc');
    expect(a).toBe(b);
  });

  it('cannot collide across a separator boundary', () => {
    // A printable separator would let ("git", "a:b") and ("git:a", "b")
    // produce the same string. NUL cannot appear in either field.
    expect(canonicalNaturalKeyInput('git', 'a:b')).not.toBe(canonicalNaturalKeyInput('git:a', 'b'));
  });

  it('rejects empty inputs', () => {
    expect(() => canonicalNaturalKeyInput('', 'x')).toThrow();
    expect(() => canonicalNaturalKeyInput('x', '')).toThrow();
  });

  it('rejects a NUL inside a field', () => {
    expect(() => canonicalNaturalKeyInput('git x', 'y')).toThrow(/NUL/);
  });

  it('produces the same key on every call', () => {
    const key = deriveNaturalKey(fakeDigest, 'git', 'git://repo/commit/abc');
    for (let i = 0; i < 100; i++) {
      expect(deriveNaturalKey(fakeDigest, 'git', 'git://repo/commit/abc')).toBe(key);
    }
  });
});

describe('content fingerprinting', () => {
  const fakeDigest: Digest = (input) => `h:${input.length}:${input.replace(/\0/g, '|')}`;

  const base: ContentFingerprint = {
    title: 'Add tolerant JSONL parser',
    summary: null,
    excerpt: 'diff excerpt',
    attributes: { repo: 'careerforge', insertions: 412 },
  };

  it('is independent of attribute insertion order', () => {
    // JSON.stringify preserves insertion order, so hashing it directly would
    // make the fingerprint depend on how a collector happened to build its
    // object — a difference with no meaning that would supersede a record on
    // every single run.
    const reordered: ContentFingerprint = {
      ...base,
      attributes: { insertions: 412, repo: 'careerforge' },
    };
    expect(canonicalContentInput(reordered)).toBe(canonicalContentInput(base));
  });

  it('is independent of array member order', () => {
    const a: ContentFingerprint = { ...base, attributes: { coauthors: ['ada', 'grace'] } };
    const b: ContentFingerprint = { ...base, attributes: { coauthors: ['grace', 'ada'] } };
    expect(canonicalContentInput(a)).toBe(canonicalContentInput(b));
  });

  it('changes when content changes', () => {
    const changed: ContentFingerprint = { ...base, title: 'Add strict JSONL parser' };
    expect(canonicalContentInput(changed)).not.toBe(canonicalContentInput(base));
  });

  it('distinguishes a null summary from an empty one', () => {
    const empty: ContentFingerprint = { ...base, summary: '' };
    expect(canonicalContentInput(empty)).not.toBe(canonicalContentInput(base));
  });

  it('distinguishes a missing attribute from an empty-string one', () => {
    const a: ContentFingerprint = { ...base, attributes: {} };
    const b: ContentFingerprint = { ...base, attributes: { repo: '' } };
    expect(canonicalContentInput(a)).not.toBe(canonicalContentInput(b));
  });

  it('detects change through the hash', () => {
    const before = deriveContentHash(fakeDigest, base);
    const after = deriveContentHash(fakeDigest, { ...base, excerpt: 'different' });
    expect(hasContentChanged(before, after)).toBe(true);
    expect(hasContentChanged(before, before)).toBe(false);
  });

  it('is stable across many derivations — re-collection must be a no-op', () => {
    const hash = deriveContentHash(fakeDigest, base);
    for (let i = 0; i < 100; i++) {
      expect(deriveContentHash(fakeDigest, base)).toBe(hash);
    }
  });
});

describe('canonical attribute storage', () => {
  it('sorts keys so representation matches the hash', () => {
    // Without this, two objects that hash identically are *stored*
    // differently, and which one you get depends on which arrived first —
    // making stored state a function of ingestion order.
    const a = canonicalAttributes({ repo: 'cf', insertions: 1 });
    const b = canonicalAttributes({ insertions: 1, repo: 'cf' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a)).toEqual(['insertions', 'repo']);
  });

  it('sorts array members — declaring a string[] declares a set', () => {
    const a = canonicalAttributes({ coauthors: ['grace', 'ada'] });
    const b = canonicalAttributes({ coauthors: ['ada', 'grace'] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('leaves scalar values untouched', () => {
    const attributes = { n: 42, flag: true, name: 'x' };
    expect(canonicalAttributes(attributes)).toEqual(attributes);
  });

  it('does not mutate its input', () => {
    const original = { coauthors: ['grace', 'ada'] };
    canonicalAttributes(original);
    expect(original.coauthors).toEqual(['grace', 'ada']);
  });

  it('agrees with the content hash about what is equal', () => {
    // The property that ties the two together: if canonicalisation says two
    // attribute bags are the same, hashing must agree, and vice versa.
    const pairs: [AttributeMap, AttributeMap][] = [
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      [{ tags: ['x', 'y'] }, { tags: ['y', 'x'] }],
      [
        { a: 1, tags: ['p', 'q'] },
        { tags: ['q', 'p'], a: 1 },
      ],
    ];
    for (const [left, right] of pairs) {
      const sameStored =
        JSON.stringify(canonicalAttributes(left)) === JSON.stringify(canonicalAttributes(right));
      const sameHashed =
        canonicalContentInput({ title: 't', summary: null, excerpt: null, attributes: left }) ===
        canonicalContentInput({ title: 't', summary: null, excerpt: null, attributes: right });
      expect(sameStored, 'storage and hashing disagreed').toBe(sameHashed);
    }
  });
});
