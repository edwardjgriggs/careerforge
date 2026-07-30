/**
 * Deterministic serialisation, so a hash means the same thing tomorrow.
 *
 * `JSON.stringify` preserves insertion order, which makes it useless as the
 * input to a content hash: two structurally identical templates written a year
 * apart would hash differently because somebody put `params` above `schema`.
 * Sorting keys makes the hash a property of the content rather than of the
 * typing.
 *
 * The store has its own canonical JSON for exports. This one is deliberately
 * separate: `enrich` must not depend on `store`, and a shared helper between
 * the two would be a dependency edge bought for twenty lines.
 */

export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // Undefined members are absent members. Serialising them as `null` would
    // make an optional parameter that was never set hash differently from one
    // that was explicitly cleared.
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalise(member)}`).join(',')}}`;
}
