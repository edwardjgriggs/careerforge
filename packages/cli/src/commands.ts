import { existsSync } from 'node:fs';

import {
  toInstant,
  DEFAULT_GROUPING_CONFIG,
  type GroupingConfig,
  type Instant,
} from '@careerforge/domain';
import { formatReport, runCollection, type SourceRef } from '@careerforge/collect';
import { GitCollector } from '@careerforge/collector-git';
import { SessionCollector, defaultTranscriptRoot } from '@careerforge/collector-session';
import {
  closeDatabase,
  CursorStore,
  EvidenceStore,
  WorkUnitStore,
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

/**
 * The collectors this build ships with.
 *
 * A registry now that there are two to choose between, and no earlier: with
 * one implementation it would have been designed against a guess. Each entry
 * knows only where to look by default and what to call the things it finds —
 * everything else is the collector's own business.
 */
const COLLECTORS = {
  git: {
    create: () => new GitCollector(),
    describes: 'repositories',
    defaultPath: () => process.cwd(),
    hint: 'Point --path at a repository, or at a directory containing some.',
  },
  session: {
    create: () => new SessionCollector(),
    describes: 'AI coding session projects',
    defaultPath: defaultTranscriptRoot,
    hint: 'Sessions are read from ~/.claude/projects. Pass --path to look elsewhere.',
  },
} as const;

export type CollectorName = keyof typeof COLLECTORS;

export const COLLECTOR_NAMES = Object.keys(COLLECTORS) as readonly CollectorName[];

export function isCollectorName(value: string): value is CollectorName {
  return Object.prototype.hasOwnProperty.call(COLLECTORS, value);
}

export interface CollectOptions {
  /** Which collectors to run. Defaults to all of them. */
  readonly collectors?: readonly CollectorName[];
  /**
   * Where to collect from. Overrides every selected collector's default, so it
   * is only useful with a single `--collector`.
   */
  readonly path?: string;
  /** Ignore the stored cursor and replay everything. */
  readonly backfill: boolean;
  readonly limit?: number;
}

/**
 * Collect evidence from local sources.
 *
 * Runs every collector by default. Git proves the outcome and sessions prove
 * the reasoning, and a user who has to know to ask for the second one will not
 * ask for it.
 */
export async function collect(
  env: NodeJS.ProcessEnv,
  options: CollectOptions,
): Promise<CommandResult> {
  const paths = resolvePaths(env);
  const selected = options.collectors ?? COLLECTOR_NAMES;

  const found: { name: CollectorName; source: SourceRef }[] = [];
  for (const name of selected) {
    const entry = COLLECTORS[name];
    const location = options.path ?? entry.defaultPath();
    for (const source of await entry.create().discover(location)) {
      found.push({ name, source });
    }
  }

  if (found.length === 0) {
    const where = options.path ?? 'the default locations';
    return failure(
      `Nothing to collect from ${where}.`,
      selected.map((name) => COLLECTORS[name].hint).join(' '),
    );
  }

  const { db } = openDatabase({ path: paths.database });
  try {
    const store = new EvidenceStore(db, nodePlatform);
    const cursors = new CursorStore(db, nodePlatform);
    const reports: string[] = [];
    let totalNew = 0;

    for (const { name, source } of found) {
      const report = await runCollection({
        collector: COLLECTORS[name].create(),
        scope: source.scope,
        store,
        cursors,
        backfill: options.backfill,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      totalNew += report.inserted;
      reports.push(`${source.label}\n${indent(formatReport(report))}`);
    }

    const summary =
      totalNew === 0
        ? 'Nothing new. Everything found was already on record.'
        : `${totalNew} new record(s) collected.`;

    return ok(
      [
        `Collected from ${found.length} source(s):`,
        '',
        ...reports,
        '',
        summary,
        `Store now holds ${store.count()} current record(s). Try \`careerforge timeline\`.`,
        '',
      ].join('\n'),
    );
  } finally {
    closeDatabase(db);
  }
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

export function reindex(env: NodeJS.ProcessEnv): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store to reindex.', 'Run `careerforge init` first.');
  }
  return withStore(paths, ({ store }) => ok(`Reindexed ${store.reindex()} record(s).\n`));
}

// ── Work units ────────────────────────────────────────────────────────────

export interface GroupCommandOptions {
  readonly dryRun: boolean;
  /** Override the idle gap, in minutes. Thresholds are configuration. */
  readonly idleGap?: number;
  readonly minActiveMinutes?: number;
}

/**
 * Turn collected evidence into units of work.
 *
 * Safe to run repeatedly: unchanged evidence writes nothing, and a unit the
 * user has edited is never touched.
 */
export function group(env: NodeJS.ProcessEnv, options: GroupCommandOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store to group.', 'Run `careerforge init` and `careerforge collect` first.');
  }

  const config: GroupingConfig = {
    ...DEFAULT_GROUPING_CONFIG,
    ...(options.idleGap === undefined ? {} : { idleGapMinutes: options.idleGap }),
    threshold: {
      ...DEFAULT_GROUPING_CONFIG.threshold,
      ...(options.minActiveMinutes === undefined
        ? {}
        : { minActiveMinutes: options.minActiveMinutes }),
    },
  };

  return withStore(paths, ({ db }) => {
    const units = new WorkUnitStore(db, nodePlatform);
    const report = units.group({ config, dryRun: options.dryRun });

    const lines = [
      options.dryRun ? 'Dry run — nothing was written.' : `Grouped with ${report.strategy}.`,
      '',
      `  ${report.proposed} candidate(s), ${report.admitted} substantial enough to keep`,
      `  ${report.created} new, ${report.updated} regrouped, ${report.unchanged} unchanged`,
    ];
    if (report.pinnedSkipped > 0) {
      lines.push(`  ${report.pinnedSkipped} left alone because you edited them`);
    }
    if (report.evidenceBelowThreshold > 0) {
      lines.push(
        `  ${report.evidenceBelowThreshold} record(s) below the threshold, kept but not grouped`,
      );
    }

    if (options.dryRun) {
      lines.push('', 'Would keep:');
      for (const candidate of report.units.filter((unit) => unit.admitted).slice(0, 20)) {
        lines.push(
          `  ${candidate.occurredAt.slice(0, 10)}  ${candidate.members.length.toString().padStart(3)} artifact(s)  ${candidate.title}`,
        );
      }
    }

    lines.push('', `Store now holds ${units.count()} work unit(s). Try \`careerforge units\`.`, '');
    return ok(lines.join('\n'));
  });
}

export interface UnitsOptions {
  readonly project?: string;
  readonly limit: number;
}

export function units(env: NodeJS.ProcessEnv, options: UnitsOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store to read.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const store = new WorkUnitStore(db, nodePlatform);
    const found = store.currentUnits(options.project).slice(0, options.limit);

    if (found.length === 0) {
      return ok('No work units yet. Run `careerforge group` after collecting.\n');
    }

    const lines: string[] = [];
    for (const unit of found) {
      const span =
        unit.occurredEnd === null || unit.occurredEnd.slice(0, 10) === unit.occurredAt.slice(0, 10)
          ? unit.occurredAt.slice(0, 10)
          : `${unit.occurredAt.slice(0, 10)} → ${unit.occurredEnd.slice(0, 10)}`;
      lines.push(
        `${unit.pinned ? '*' : ' '} ${span.padEnd(23)} ${store.memberIds(unit.id).length.toString().padStart(3)} artifact(s)  ${unit.title}`,
      );
      lines.push(
        `    ${unit.id}  ${unit.projectKey ?? '(no project)'}${unit.stream === null ? '' : ` · ${unit.stream}`} · ${unit.sensitivity}`,
      );
    }

    return ok(
      `${lines.join('\n')}\n\n${found.length} work unit(s).${
        found.some((unit) => unit.pinned) ? ' * = edited by you, never regrouped.' : ''
      }\n`,
    );
  });
}
