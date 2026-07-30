import type DatabaseConstructor from 'better-sqlite3';

export type Db = DatabaseConstructor.Database;

/**
 * A forward-only schema migration.
 *
 * There are no down-migrations. They are rarely correct, almost never tested
 * against real data, and the one time you need one is the one time you cannot
 * afford it to be wrong. Rolling back means restoring the automatic
 * pre-migration backup.
 */
export interface Migration {
  /** Matches `PRAGMA user_version` after this migration applies. */
  readonly version: number;
  /** Short slug, for logs and error messages. */
  readonly name: string;
  /**
   * Applied inside a transaction the runner owns. Throwing rolls back
   * everything, leaving the database byte-identical to before.
   */
  up(db: Db): void;
}
