import { existsSync } from 'node:fs';

import { toInstant, type Instant } from '@careerforge/domain';
import {
  closeDatabase,
  EvidenceStore,
  exportStore,
  nodePlatform,
  openDatabase,
  rebuildStore,
  type Db,
} from '@careerforge/store';

import { resolvePaths, type CareerforgePaths } from './paths.js';

/**
 * Command implementations.
 *
 * Each returns text rather than printing, so the whole surface is testable
 * without spawning a process, and so the future web UI can call the same code
 * paths the CLI does.
 */

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', exitCode: 0 });

const failure = (message: string, hint?: string): CommandResult => ({
  stdout: '',
  stderr: hint === undefined ? `${message}\n` : `${message}\n  -> ${hint}\n`,
  exitCode: 1,
});

/** Open the store, run something, always close. */
function withStore<T>(
  paths: CareerforgePaths,
  body: (context: { db: Db; store: EvidenceStore }) => T,
): T {
  const { db } = openDatabase({ path: paths.database });
  try {
    return body({ db, store: new EvidenceStore(db, nodePlatform) });
  } finally {
    closeDatabase(db);
  }
}

/** Accepts a full instant or a plain date, which is what people actually type. */
function parseBoundary(value: string, endOfDay: boolean): Instant {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return toInstant(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  return toInstant(value);
}

export function init(env: NodeJS.ProcessEnv): CommandResult {
  const paths = resolvePaths(env);
  const existed = existsSync(paths.database);
  const { db, migration } = openDatabase({ path: paths.database });
  const version = migration.to;
  closeDatabase(db);

  return ok(
    existed
      ? `Store already present at ${paths.database} (schema v${version}).\n`
      : `Created ${paths.database} (schema v${version}).\n\nNothing has been collected yet. Collectors arrive in the next milestone.\n`,
  );
}

export function exportCommand(env: NodeJS.ProcessEnv, target?: string): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store to export.', 'Run `careerforge init` first.');
  }
  const root = target ?? paths.exportDir;

  return withStore(paths, ({ db }) => {
    const report = exportStore(db, root);
    const total = Object.values(report.counts).reduce((sum, n) => sum + n, 0);
    const lines = [
      `Exported ${total} records to ${root}`,
      ...Object.entries(report.counts)
        .sort()
        .map(([kind, n]) => `  ${kind.padEnd(12)} ${n}`),
      '',
      report.written === 0
        ? 'Nothing changed since the last export.'
        : `${report.written} file(s) written.`,
      `Digest ${report.digest.slice(0, 16)}...`,
      '',
      'This tree is the durable copy of your store. Back it up, sync it, or read it —',
      'and `careerforge rebuild` can reconstruct the database from it alone.',
      '',
    ];
    return ok(lines.join('\n'));
  });
}

export function rebuild(env: NodeJS.ProcessEnv, source?: string): CommandResult {
  const paths = resolvePaths(env);
  const root = source ?? paths.exportDir;

  if (!existsSync(root)) {
    return failure(`No export directory at ${root}.`, 'Pass --from <dir> to point at one.');
  }

  try {
    return withStore(paths, ({ db }) => {
      const report = rebuildStore(db, root);
      const total = Object.values(report.counts).reduce((sum, n) => sum + n, 0);
      return ok(
        [
          `Rebuilt ${total} records from ${root}`,
          ...Object.entries(report.counts)
            .sort()
            .map(([kind, n]) => `  ${kind.padEnd(12)} ${n}`),
          '',
        ].join('\n'),
      );
    });
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : String(error),
      'Rebuild targets an empty store. Move the existing database aside and try again.',
    );
  }
}

export function search(env: NodeJS.ProcessEnv, query: string, limit: number): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store to search.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ store }) => {
    const hits = store.search(query, limit);
    if (hits.length === 0) return ok(`No evidence matches ${JSON.stringify(query)}.\n`);
    const lines = hits.map(
      (e) => `  ${e.occurredAt.slice(0, 10)}  ${e.kind.padEnd(18)} ${e.title}`,
    );
    return ok(`${hits.length} match(es):\n\n${lines.join('\n')}\n`);
  });
}

export function timeline(
  env: NodeJS.ProcessEnv,
  options: { from?: string; to?: string; limit: number },
): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  let from: Instant | undefined;
  let to: Instant | undefined;
  try {
    if (options.from !== undefined) from = parseBoundary(options.from, false);
    if (options.to !== undefined) to = parseBoundary(options.to, true);
  } catch {
    return failure('Could not read that date.', 'Use YYYY-MM-DD, for example --from 2026-01-01.');
  }

  return withStore(paths, ({ store }) => {
    const records = store.between({
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      limit: options.limit,
    });
    if (records.length === 0) {
      return ok('No evidence in that window.\n');
    }

    const lines: string[] = [];
    let currentMonth = '';
    for (const record of records) {
      const month = record.occurredAt.slice(0, 7);
      if (month !== currentMonth) {
        lines.push(currentMonth === '' ? month : `\n${month}`);
        currentMonth = month;
      }
      lines.push(`  ${record.occurredAt.slice(8, 10)}  ${record.kind.padEnd(18)} ${record.title}`);
    }
    return ok(`${lines.join('\n')}\n\n${records.length} record(s).\n`);
  });
}

export function reindex(env: NodeJS.ProcessEnv): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store to reindex.', 'Run `careerforge init` first.');
  }
  return withStore(paths, ({ store }) => ok(`Reindexed ${store.reindex()} record(s).\n`));
}
