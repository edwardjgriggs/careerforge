import {
  createUlidFactory,
  instantFromEpochMillis,
  type Platform,
  type UlidFactory,
} from '@careerforge/domain';

import type { Db } from './migrations/index.js';

/**
 * Where each collector got to, per scope.
 *
 * Cursors are opaque to the core: only the collector that wrote one knows what
 * it means. That is deliberate — a git collector's cursor is a commit range, a
 * session collector's is a file offset, and the host has no business
 * interpreting either.
 */
export class CursorStore {
  private readonly nextId: UlidFactory;

  constructor(
    private readonly db: Db,
    private readonly platform: Platform,
  ) {
    this.nextId = createUlidFactory(platform.clock, platform.entropy);
  }

  read(collectorId: string, scopeKey: string): string | null {
    const row = this.db
      .prepare(
        `SELECT cursor FROM collector_cursors
         WHERE collector_id = ? AND scope_key = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(collectorId, scopeKey) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  /** Advance by inserting; the previous position stays on record. */
  advance(collectorId: string, scopeKey: string, cursor: string): void {
    const previous = this.db
      .prepare(
        `SELECT id FROM collector_cursors
         WHERE collector_id = ? AND scope_key = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(collectorId, scopeKey) as { id: string } | undefined;

    this.db
      .prepare(
        `INSERT INTO collector_cursors (id, collector_id, scope_key, cursor, recorded_at, supersedes)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        this.nextId(),
        collectorId,
        scopeKey,
        cursor,
        instantFromEpochMillis(this.platform.clock()),
        previous?.id ?? null,
      );
  }

  /** Every position this collector has held for this scope, oldest first. */
  history(
    collectorId: string,
    scopeKey: string,
  ): readonly { cursor: string; recordedAt: string }[] {
    return this.db
      .prepare(
        `SELECT cursor, recorded_at AS recordedAt FROM collector_cursors
         WHERE collector_id = ? AND scope_key = ?
         ORDER BY id ASC`,
      )
      .all(collectorId, scopeKey) as { cursor: string; recordedAt: string }[];
  }
}
