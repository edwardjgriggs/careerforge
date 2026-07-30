import type { Brand } from './primitives.js';

/**
 * An instant in time, as an ISO-8601 string in UTC with millisecond precision.
 *
 * A string rather than a `Date` because evidence is append-only and a `Date`
 * is mutable. Always UTC because a career spans timezones and the alternative
 * is comparing instants that look ordered and are not.
 */
export type Instant = Brand<string, 'Instant'>;

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isInstant(value: string): value is Instant {
  if (!INSTANT_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  // Rejects values that match the shape but are not real dates, such as
  // 2026-02-30, which Date.parse would otherwise roll forward.
  return new Date(parsed).toISOString() === value;
}

export function toInstant(value: string): Instant {
  if (!isInstant(value)) {
    throw new Error(
      `Not an instant: ${JSON.stringify(value)} (expected ISO-8601 UTC, e.g. 2026-07-30T14:02:11.000Z)`,
    );
  }
  return value;
}

/** Convert epoch milliseconds to an `Instant`. */
export function instantFromEpochMillis(millis: number): Instant {
  if (!Number.isFinite(millis)) {
    throw new Error(`Cannot build an instant from a non-finite value: ${millis}`);
  }
  return new Date(millis).toISOString() as Instant;
}

export function epochMillisOf(instant: Instant): number {
  return Date.parse(instant);
}

/** Chronological comparator. Negative when `a` precedes `b`. */
export function compareInstants(a: Instant, b: Instant): number {
  // ISO-8601 UTC with fixed precision sorts correctly as a string, so this is
  // both cheaper and immune to parse differences across platforms.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A closed interval of time.
 *
 * `end` is null for instantaneous evidence — a commit happens at a point, a
 * meeting occupies a span, and work units almost always span.
 */
export interface TimeSpan {
  readonly start: Instant;
  readonly end: Instant | null;
}

export function isOrderedSpan(span: TimeSpan): boolean {
  return span.end === null || compareInstants(span.start, span.end) <= 0;
}

/** Smallest span covering every input. Returns null for an empty list. */
export function coveringSpan(spans: readonly TimeSpan[]): TimeSpan | null {
  if (spans.length === 0) return null;
  let start = spans[0]!.start;
  let end: Instant | null = spans[0]!.end ?? spans[0]!.start;
  for (const span of spans.slice(1)) {
    if (compareInstants(span.start, start) < 0) start = span.start;
    const candidate = span.end ?? span.start;
    if (end === null || compareInstants(candidate, end) > 0) end = candidate;
  }
  return { start, end };
}
