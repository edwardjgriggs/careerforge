import { existsSync } from 'node:fs';

import {
  DEFAULT_GROUPING_CONFIG,
  type ExplanationNode,
  type GroupingConfig,
  type Instant,
  type ProvenanceClass,
} from '@careerforge/domain';
import { formatReport, runCollection, type SourceRef } from '@careerforge/collect';
import { GitCollector } from '@careerforge/collector-git';
import { SessionCollector, defaultTranscriptRoot } from '@careerforge/collector-session';
import {
  closeDatabase,
  CursorStore,
  EvidenceStore,
  InterviewEngine,
  ProvenanceStore,
  WorkUnitStore,
  exportStore,
  nodePlatform,
  openDatabase,
  rebuildStore,
} from '@careerforge/store';

import { failure, ok, parseBoundary, withStore, type CommandResult } from './command-runtime.js';
import { resolvePaths } from './paths.js';

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
  /** Emit one JSON object per line on stdout, for scripts. */
  readonly json: boolean;
}

export function units(env: NodeJS.ProcessEnv, options: UnitsOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store to read.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const store = new WorkUnitStore(db, nodePlatform);
    const found = store.currentUnits(options.project).slice(0, options.limit);

    if (options.json) {
      // One object per line (NDJSON), nothing else on stdout, so a pipe or
      // `jq -c` reads it cleanly. An empty result is an empty stream.
      const lines = found.map((unit) =>
        JSON.stringify({
          id: unit.id,
          title: unit.title,
          occurredAt: unit.occurredAt,
          occurredEnd: unit.occurredEnd,
          projectKey: unit.projectKey,
          stream: unit.stream,
          sensitivity: unit.sensitivity,
          pinned: unit.pinned,
          artifactCount: store.memberIds(unit.id).length,
          groupingStrategy: unit.groupingStrategy,
        }),
      );
      return ok(lines.length === 0 ? '' : `${lines.join('\n')}\n`);
    }

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

// ── Explanation and interview ─────────────────────────────────────────────

const CLASS_MARK: Record<ProvenanceClass, string> = {
  observed: 'observed  ',
  derived: 'derived   ',
  stated: 'you said  ',
  grouped: 'grouped   ',
  interpreted: 'AI reading',
};

function renderNodes(nodes: readonly ExplanationNode[], indent: string): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const mark = CLASS_MARK[node.provenanceClass];
    const label = node.label.length > 84 ? `${node.label.slice(0, 84)}…` : node.label;
    lines.push(`${indent}[${mark}] ${label}`);
    if (node.detail !== null) lines.push(`${indent}             ${node.detail}`);
    if (node.repeated) lines.push(`${indent}             (shown above)`);
    lines.push(...renderNodes(node.children, `${indent}  `));
  }
  return lines;
}

/**
 * Why is this claim true?
 *
 * The output is the product's central promise made inspectable: what stands
 * behind the sentence, what merely worded it, and what is still missing.
 */
export function explain(env: NodeJS.ProcessEnv, claimId: string): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store to explain from.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const proof = new ProvenanceStore(db, nodePlatform).explain(claimId);
    if (proof === null) {
      return failure(`No claim ${claimId}.`, 'Run `careerforge units` to see what is on record.');
    }

    const lines = [`"${proof.text}"`, `  a ${proof.claimType} claim`, ''];

    lines.push(
      proof.verdict.supported
        ? 'SUPPORTED — this is what stands behind it:'
        : `NOT SUPPORTED — ${proof.verdict.reason}`,
      '',
    );

    if (proof.grounds.length > 0) {
      lines.push(...renderNodes(proof.grounds, '  '), '');
    } else {
      lines.push('  Nothing in the evidence stands behind this.', '');
    }

    if (proof.interpretation.length > 0) {
      // Below the grounds and labelled, never mixed in with them. An AI
      // reading explains the wording; it is not a reason to believe it.
      lines.push(
        'Interpretation — this shaped the wording, and is not evidence:',
        ...renderNodes(proof.interpretation, '  '),
        '',
      );
    }

    if (proof.openGaps.length > 0) {
      lines.push('Open questions about this work:');
      for (const gap of proof.openGaps) lines.push(`  ${gap.id}  ${gap.question}`);
      lines.push('', 'Answer them with `careerforge interview`.', '');
    }

    if (proof.truncated) {
      lines.push('(The proof continues beyond the display depth.)', '');
    }

    return ok(lines.join('\n'));
  });
}

export interface InterviewOptions {
  readonly workUnitId?: string;
  readonly gapId?: string;
  readonly answer?: string;
  readonly decline: boolean;
  readonly limit: number;
}

/**
 * Answer the questions CareerForge will not guess.
 *
 * Works with no API key, no network, and no provider configured. Gaps are
 * raised by rule from a failed support predicate, never by a model.
 */
export function interview(env: NodeJS.ProcessEnv, options: InterviewOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store to interview against.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db, store }) => {
    const provenance = new ProvenanceStore(db, nodePlatform);
    const engine = new InterviewEngine(db, store, provenance, nodePlatform);

    if (options.gapId !== undefined) {
      try {
        if (options.decline) {
          engine.decline(options.gapId);
          return ok('Noted. That question will not be asked again.\n');
        }
        if (options.answer === undefined || options.answer.trim() === '') {
          return failure('An answer needs text.', 'Pass --answer "..." or --decline.');
        }
        const result = engine.answer(options.gapId, options.answer);
        return ok(
          [
            result.superseded
              ? 'Updated your earlier answer.'
              : 'Recorded. This is now evidence you confirmed.',
            '',
            `  evidence ${result.evidenceId}`,
            '',
            'It can support claims about this work from now on, including the ones',
            'CareerForge refuses to make without you — like whether you led it.',
            '',
          ].join('\n'),
        );
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    }

    const pending = engine.pending(options.workUnitId).slice(0, options.limit);
    if (pending.length === 0) {
      return ok(
        'No open questions. CareerForge asks only when a stronger claim would need something it cannot observe.\n',
      );
    }

    const lines = [`${pending.length} open question(s):`, ''];
    for (const gap of pending) {
      lines.push(`  ${gap.id}`, `    ${gap.question}`, `    why: ${gap.rationale}`, '');
    }
    lines.push(
      'Answer one:',
      '  careerforge interview --gap <id> --answer "..."',
      '  careerforge interview --gap <id> --decline',
      '',
      'Answers are stored as evidence you confirmed, and are reused by every future asset.',
      '',
    );
    return ok(lines.join('\n'));
  });
}

// ── Consent and egress preview ────────────────────────────────────────────

/**
 * Providers this build knows about.
 *
 * `local` means the model runs on this machine, so nothing leaves and no
 * grant is needed — which is what makes `restricted` workable rather than
 * merely restrictive. None of these can be called yet; the choke point ships
 * before any provider so there is no window in which egress is unenforced.
 */
