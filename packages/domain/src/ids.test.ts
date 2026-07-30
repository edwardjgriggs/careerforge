import { describe, expect, it } from 'vitest';

import { createUlidFactory, isUlid, MAX_ULID_TIME, toUlid, ULID_LENGTH, ulidTime } from './ids.js';
import type { Clock, EntropySource } from './primitives.js';

/**
 * ULID generation, tested deterministically.
 *
 * Every case here pins the clock and the entropy source. That is only
 * possible because the domain receives both as parameters rather than
 * reaching for them (ADR-0012) — the practical payoff of that decision.
 */

const fixedClock =
  (millis: number): Clock =>
  () =>
    millis;

const steppingClock = (start: number, stepMillis: number): Clock => {
  let current = start - stepMillis;
  return () => (current += stepMillis);
};

/** Deterministic, distinguishable bytes. Never used for real identifiers. */
const countingEntropy = (seed = 0): EntropySource => {
  let n = seed;
  return (length) => Uint8Array.from({ length }, () => n++ % 256);
};

const constantEntropy =
  (byte: number): EntropySource =>
  (length) =>
    new Uint8Array(length).fill(byte);

describe('shape', () => {
  it('produces 26 Crockford base32 characters', () => {
    const next = createUlidFactory(fixedClock(1_785_000_000_000), countingEntropy());
    const id = next();
    expect(id).toHaveLength(ULID_LENGTH);
    expect(isUlid(id)).toBe(true);
  });

  it('excludes the characters humans misread', () => {
    const next = createUlidFactory(steppingClock(1_785_000_000_000, 1), countingEntropy());
    const generated = Array.from({ length: 200 }, () => next()).join('');
    for (const ambiguous of ['I', 'L', 'O', 'U']) {
      expect(generated.includes(ambiguous), `contains ${ambiguous}`).toBe(false);
    }
  });

  it('rejects strings that are not ULIDs', () => {
    for (const bad of ['', 'short', 'i'.repeat(26), 'X'.repeat(25), 'X'.repeat(27), 'ULID!']) {
      expect(isUlid(bad), bad).toBe(false);
      expect(() => toUlid(bad)).toThrow();
    }
  });

  it('brands a valid ULID string', () => {
    const next = createUlidFactory(fixedClock(1), countingEntropy());
    const id = next();
    expect(toUlid(id as string)).toBe(id);
  });
});

describe('ordering', () => {
  it('sorts lexicographically in creation order', () => {
    const next = createUlidFactory(steppingClock(1_785_000_000_000, 1), countingEntropy());
    const ids = Array.from({ length: 500 }, () => next());
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays monotonic within a single millisecond', () => {
    // The important case: a fast collector emitting many records per
    // millisecond. Without incrementing the random field their order would
    // be arbitrary, and "append-only log ordering" would mean nothing.
    const next = createUlidFactory(fixedClock(1_785_000_000_000), constantEntropy(0));
    const ids = Array.from({ length: 1000 }, () => next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(1000);
  });

  it('never sorts backwards when the clock jumps backwards', () => {
    // NTP correction, VM resume, or a user changing the system clock. IDs
    // must not sort before ones already written.
    let time = 1_785_000_000_000;
    const jumpyClock: Clock = () => time;
    const next = createUlidFactory(jumpyClock, countingEntropy());

    const before = Array.from({ length: 5 }, () => next());
    time -= 60_000; // clock moves back a minute
    const after = Array.from({ length: 5 }, () => next());

    const all = [...before, ...after];
    expect([...all].sort()).toEqual(all);
  });
});

describe('timestamps', () => {
  it('round-trips the creation time', () => {
    const when = 1_785_426_070_018;
    const next = createUlidFactory(fixedClock(when), countingEntropy());
    expect(ulidTime(next())).toBe(when);
  });

  it('handles the epoch', () => {
    const next = createUlidFactory(fixedClock(0), countingEntropy());
    expect(ulidTime(next())).toBe(0);
  });

  it('handles the maximum representable time', () => {
    const next = createUlidFactory(fixedClock(MAX_ULID_TIME), countingEntropy());
    expect(ulidTime(next())).toBe(MAX_ULID_TIME);
  });

  it('rejects a time beyond the 48-bit field', () => {
    const next = createUlidFactory(fixedClock(MAX_ULID_TIME + 1), countingEntropy());
    expect(() => next()).toThrow(/exceeds the maximum/);
  });

  it('truncates fractional milliseconds rather than corrupting the encoding', () => {
    const next = createUlidFactory(fixedClock(1_785_000_000_000.7), countingEntropy());
    expect(ulidTime(next())).toBe(1_785_000_000_000);
  });
});

describe('failure modes are loud', () => {
  it('rejects a non-finite clock', () => {
    const next = createUlidFactory(() => Number.NaN, countingEntropy());
    expect(() => next()).toThrow(/non-finite/);
  });

  it('rejects an entropy source that returns too few bytes', () => {
    const next = createUlidFactory(fixedClock(1), () => new Uint8Array(4));
    expect(() => next()).toThrow(/expected 16/);
  });

  it('throws rather than wrapping when the random field saturates', () => {
    // A wrapped counter would produce an ID sorting *before* its predecessor,
    // quietly breaking the ordering guarantee everything else relies on.
    const next = createUlidFactory(fixedClock(1), constantEntropy(31)); // all 'Z'
    expect(() => next()).not.toThrow();
    expect(() => next()).toThrow(/randomness exhausted/);
  });
});

describe('uniqueness', () => {
  it('produces distinct identifiers across many milliseconds', () => {
    const next = createUlidFactory(steppingClock(1_785_000_000_000, 3), countingEntropy(7));
    const ids = new Set(Array.from({ length: 5000 }, () => next()));
    expect(ids.size).toBe(5000);
  });
});
