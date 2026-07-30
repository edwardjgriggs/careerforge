/**
 * Resolving current state from an append-only log.
 *
 * A record is current when nothing supersedes it and no tombstone suppresses
 * it. Both facts are *derived*, never stored on the record itself — writing
 * "this row has been superseded" onto the row would be an `UPDATE`, which is
 * exactly what the append-only model forbids. See ADR-0013.
 *
 * Every read path in CareerForge resolves currency through these functions or
 * through the SQL views built on the same rule, so a suppressed record cannot
 * leak into an export by way of a read path that forgot to check.
 */

/** Any append-only record: identified, and possibly replacing an earlier one. */
export interface Lineaged {
  readonly id: string;
  readonly supersedes: string | null;
}

/**
 * Ids that some later record has replaced.
 *
 * Derived by looking forward: if any record says it supersedes `x`, then `x`
 * is no longer current. Only forward-pointing links exist, which is what lets
 * a record be written once and never touched again.
 */
export function supersededIds(records: readonly Lineaged[]): ReadonlySet<string> {
  const superseded = new Set<string>();
  for (const record of records) {
    if (record.supersedes !== null) superseded.add(record.supersedes);
  }
  return superseded;
}

export function isCurrent(
  id: string,
  superseded: ReadonlySet<string>,
  suppressed: ReadonlySet<string>,
): boolean {
  return !superseded.has(id) && !suppressed.has(id);
}

/**
 * The current records from an append-only set.
 *
 * The in-memory counterpart of the `*_current` views. Kept in the domain so
 * the rule has one definition that both SQL and code answer to, and so it can
 * be tested without a database.
 */
export function currentRecords<T extends Lineaged>(
  records: readonly T[],
  suppressed: ReadonlySet<string> = new Set(),
): readonly T[] {
  const superseded = supersededIds(records);
  return records.filter((record) => isCurrent(record.id, superseded, suppressed));
}

/**
 * Walk a supersession chain back to its origin.
 *
 * Answers "what did this look like before?" — the history a user is entitled
 * to see for their own career record.
 */
export function lineageOf<T extends Lineaged>(record: T, all: readonly T[]): readonly T[] {
  const byId = new Map(all.map((r) => [r.id, r]));
  const chain: T[] = [record];
  const seen = new Set<string>([record.id]);
  let cursor: T | undefined = record;
  while (cursor?.supersedes != null) {
    const previous: T | undefined = byId.get(cursor.supersedes);
    // A cycle should be impossible, but a corrupted or hand-edited store must
    // not send a UI path into an infinite loop.
    if (previous === undefined || seen.has(previous.id)) break;
    chain.push(previous);
    seen.add(previous.id);
    cursor = previous;
  }
  return chain;
}
