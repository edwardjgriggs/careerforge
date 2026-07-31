import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import {
  explainRefusal,
  isSensitivity,
  toInstant,
  DEFAULT_GROUPING_CONFIG,
  SENSITIVITY_LEVELS,
  describeSignal,
  signalPolarity,
  summariseAssessment,
  type ClaimType,
  type EnrichmentType,
  type EvidenceAssessment,
  type EvidenceClass,
  type ExplanationNode,
  type GroupingConfig,
  type Instant,
  type ProvenanceClass,
  type Refusal,
  type Sensitivity,
} from '@careerforge/domain';
import {
  createOpenAIProvider,
  evaluate,
  preview,
  type PayloadItem,
  type Provider,
  type ProviderPort,
} from '@careerforge/policy';
import {
  canonicalise,
  createRecordedProvider,
  executeRun,
  explainDifference,
  parseCassette,
  ENRICHABLE_TYPES,
  type EnrichmentInput,
} from '@careerforge/enrich';
import {
  generateBullet,
  isPublishable,
  type CandidateRecord,
  type DroppedClaim,
  type ProposedClaim,
} from '@careerforge/generate';
import { formatReport, runCollection, type SourceRef } from '@careerforge/collect';
import { GitCollector } from '@careerforge/collector-git';
import { SessionCollector, defaultTranscriptRoot } from '@careerforge/collector-session';
import {
  AssetStore,
  closeDatabase,
  ConsentStore,
  CursorStore,
  EnrichmentStore,
  EvidenceStore,
  InterviewEngine,
  ProvenanceStore,
  WorkUnitStore,
  exportStore,
  nodePlatform,
  openDatabase,
  sha256,
  rebuildStore,
  type Db,
} from '@careerforge/store';

import { createExplorerServer } from '@careerforge/ui';

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
const PROVIDERS: Readonly<Record<string, Provider>> = {
  openai: { id: 'openai', locality: 'remote' },
  anthropic: { id: 'anthropic', locality: 'remote' },
  ollama: { id: 'ollama', locality: 'local' },
};

function resolveProvider(id: string): Provider {
  // An unknown provider is treated as remote. Guessing "local" for something
  // we cannot identify would fail open, and this is the one place in the
  // codebase where failing open is unacceptable.
  return PROVIDERS[id] ?? { id, locality: 'remote' };
}

function renderRefusals(refusals: readonly Refusal[]): string[] {
  const lines: string[] = [];
  for (const refusal of refusals) {
    const { why, next } = explainRefusal(refusal);
    lines.push(`  BLOCKED by ${refusal.rule}`, `    ${why}`, `    -> ${next}`, '');
  }
  return lines;
}

export interface ConsentOptions {
  readonly action: 'list' | 'grant' | 'revoke';
  readonly providerId?: string;
  readonly projectKey?: string;
  readonly level?: string;
  readonly reason?: string;
}

export function consent(env: NodeJS.ProcessEnv, options: ConsentOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const store = new ConsentStore(db, nodePlatform);

    if (options.action === 'list') {
      const grants = store.list();
      if (grants.length === 0) {
        return ok(
          [
            'No provider may receive anything.',
            '',
            'That is the default, and nothing changes it globally — consent is granted per',
            'project so client work can stay on this machine while personal work does not.',
            '',
            '  careerforge consent grant --provider openai --project my-repo --level confidential',
            '',
          ].join('\n'),
        );
      }

      const lines = ['What each provider may receive:', ''];
      for (const grant of grants) {
        lines.push(
          `  ${grant.revoked ? 'REVOKED' : 'allowed'}  ${grant.providerId.padEnd(12)} ` +
            `${(grant.projectKey ?? '(every project)').padEnd(24)} up to ${grant.maxSensitivity}`,
        );
      }
      lines.push('', 'Restricted work never leaves unless a grant says so for that project.', '');
      return ok(lines.join('\n'));
    }

    if (options.providerId === undefined) {
      return failure('Which provider?', 'Pass --provider <id>.');
    }
    const projectKey = options.projectKey ?? null;

    if (options.action === 'revoke') {
      store.revoke(projectKey, options.providerId, options.reason);
      return ok(
        [
          `${options.providerId} may no longer receive ${projectKey ?? 'anything'}.`,
          '',
          'The grant is not deleted — it is superseded, so what you allowed and when',
          'stays answerable.',
          '',
        ].join('\n'),
      );
    }

    const level = options.level ?? 'confidential';
    if (!isSensitivity(level)) {
      return failure(`Unknown level: ${level}.`, `Use one of ${SENSITIVITY_LEVELS.join(', ')}.`);
    }

    store.grant({
      projectKey,
      providerId: options.providerId,
      maxSensitivity: level,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });

    return ok(
      [
        `${options.providerId} may now receive ${projectKey ?? 'work from any project'} up to ${level}.`,
        '',
        level === 'restricted'
          ? 'That includes session transcripts, which routinely contain pasted credentials\nand files never committed. Use `careerforge preview` before enrichment lands.'
          : 'Anything more sensitive than that is still refused.',
        '',
      ].join('\n'),
    );
  });
}

/**
 * The evidence behind a work unit, in the shape both egress and enrichment
 * need.
 *
 * One reader for both so that what `preview` shows and what `enrich` sends
 * cannot drift. A preview that showed something other than what was sent would
 * be worse than no preview at all.
 *
 * `contentHash` travels with each record because it is what makes an
 * enrichment stale later: the ids can be unchanged while the facts beneath
 * them have been corrected.
 */
/**
 * One record, carrying what both egress and generation need.
 *
 * Structurally an `EnrichmentInput`, plus the fields a claim check needs and a
 * payload does not: which collector produced it, what kind it is, and the
 * attributes a scope figure might be corroborated against. Kept in one type so
 * the records the model reads and the records its claims are checked against
 * are provably the same records.
 */
interface UnitRecord extends EnrichmentInput {
  readonly collectorId: string;
  readonly kind: string;
  readonly evidenceClass: EvidenceClass;
  readonly attributes: Readonly<Record<string, unknown>>;
}

function unitInputs(db: Db, units: WorkUnitStore, unitId: string): UnitRecord[] {
  const inputs: UnitRecord[] = [];
  for (const evidenceId of units.memberIds(unitId)) {
    const row = db
      .prepare(
        `SELECT e.sensitivity, e.project_key, e.content_hash, e.collector_id, e.kind,
                e.evidence_class,
                COALESCE(c.title,'') AS title, COALESCE(c.excerpt,'') AS excerpt,
                COALESCE(c.attributes,'{}') AS attributes
         FROM evidence_current e LEFT JOIN evidence_content c ON c.evidence_id = e.id
         WHERE e.id = ?`,
      )
      .get(evidenceId) as
      | {
          sensitivity: string;
          project_key: string | null;
          content_hash: string;
          collector_id: string;
          kind: string;
          evidence_class: string;
          title: string;
          excerpt: string;
          attributes: string;
        }
      | undefined;
    if (row === undefined) continue;
    inputs.push({
      id: evidenceId,
      contentHash: row.content_hash,
      sensitivity: row.sensitivity as Sensitivity,
      projectKey: row.project_key,
      text: recordText(row.title, row.excerpt),
      collectorId: row.collector_id,
      kind: row.kind,
      evidenceClass: row.evidence_class as EvidenceClass,
      attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    });
  }
  return inputs;
}

/**
 * One record, as text, without saying the same thing twice.
 *
 * A session collector derives its title *from* the first prompt, so the naive
 * `title + excerpt` sends the same sentence twice. Caught on the first run
 * against a real store. It costs tokens on every call, and worse, repetition
 * reads as emphasis to a model — the duplicated sentence would be weighted
 * more heavily than the work it describes.
 */
function recordText(title: string, excerpt: string): string {
  if (excerpt === '') return title;
  if (title === '' || excerpt.startsWith(title)) return excerpt;
  return `${title}\n${excerpt}`;
}

/**
 * Exactly what a provider would be shown for this work unit.
 *
 * Exported so the guided tour can record an answer against the real payload
 * rather than a hand-written approximation of it. A tour whose fixture drifted
 * from what generation actually sends would teach the wrong thing and pass its
 * own tests while doing it.
 */
export function payloadForUnit(env: NodeJS.ProcessEnv, workUnitId: string): string | null {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) return null;

  return withStore(paths, ({ db }) => {
    const units = new WorkUnitStore(db, nodePlatform);
    if (units.byId(workUnitId) === null) return null;
    const items = unitInputs(db, units, workUnitId).map(toPayloadItem);
    return preview({ provider: resolveProvider('ollama'), purpose: 'preview', items }).payload;
  });
}

const toPayloadItem = (input: EnrichmentInput): PayloadItem => ({
  kind: 'evidence',
  id: input.id,
  sensitivity: input.sensitivity,
  projectKey: input.projectKey,
  text: input.text,
});

export interface PreviewOptions {
  readonly workUnitId: string;
  readonly providerId: string;
  readonly full: boolean;
}

/**
 * Show exactly what would be transmitted.
 *
 * Mandatory rather than advisory (ADR-0009). Pattern redaction cannot catch a
 * client's name in a sentence or a frank opinion about a colleague; a person
 * reading the actual bytes is the only real mitigation for that class. So this
 * works even when the request would be refused — seeing what *would* leave is
 * how somebody decides whether to allow it.
 */
export function previewEgress(env: NodeJS.ProcessEnv, options: PreviewOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const units = new WorkUnitStore(db, nodePlatform);
    const consentStore = new ConsentStore(db, nodePlatform);

    const unit = units.currentUnits().find((candidate) => candidate.id === options.workUnitId);
    if (unit === undefined) {
      return failure(
        `No work unit ${options.workUnitId}.`,
        'Run `careerforge units` to list them.',
      );
    }

    const inputs = unitInputs(db, units, unit.id);
    const items: PayloadItem[] = inputs.map(toPayloadItem);

    const provider = resolveProvider(options.providerId);
    const request = { provider, purpose: 'preview', items };
    const shown = preview(request);
    const decision = evaluate(request, {
      consent: (projectKey, providerId) => consentStore.lookup(projectKey, providerId),
      digest: sha256,
    });
    consentStore.recordDecision(decision);

    const lines = [
      `Work unit: ${unit.title}`,
      `Provider:  ${provider.id} (${provider.locality})`,
      `Contains:  ${items.length} record(s), most sensitive is ${decision.maxSensitivity}`,
      '',
    ];

    if (decision.allowed) {
      lines.push('ALLOWED — this is exactly what would be transmitted:', '');
    } else {
      lines.push(
        'REFUSED — nothing would be transmitted.',
        '',
        ...renderRefusals(decision.refusals),
        'Shown anyway, because seeing what would leave is how you decide whether to allow it:',
        '',
      );
    }

    const body = options.full ? shown.payload : shown.payload.slice(0, 2_000);
    lines.push(
      body === '' ? '  (nothing to send)' : body,
      body.length < shown.payload.length
        ? `\n  ... ${shown.payload.length - body.length} more characters (--full to see all)`
        : '',
      '',
      shown.redaction.totalRedactions === 0
        ? 'Redaction removed nothing. That is not a promise there is nothing sensitive here —'
        : `Redaction removed ${shown.redaction.totalRedactions} item(s) using ${shown.redaction.profile}:`,
    );

    for (const finding of shown.redaction.findings) {
      lines.push(`  ${finding.count} x ${finding.ruleId}`);
    }

    lines.push(
      '',
      'Patterns catch keys, tokens, and connection strings. They do not catch a client',
      'name in a sentence or an opinion about a colleague. Read the text above before',
      'you allow anything — that is what this command is for.',
      '',
    );

    return ok(lines.join('\n'));
  });
}

// ── Enrichment ────────────────────────────────────────────────────────────

/**
 * Which model each provider is asked for by default.
 *
 * The requested name, which is not necessarily what answers. The run record
 * keeps both, because an alias quietly advancing to a newer snapshot is the
 * most common real reason last year's interpretation reads differently from
 * this year's.
 */
const DEFAULT_MODELS: Readonly<Record<string, string>> = {
  openai: 'gpt-5',
  anthropic: 'claude-sonnet-5',
  ollama: 'llama3.1',
};

/**
 * Which provider actually answers.
 *
 * `CAREERFORGE_CASSETTE` points at a recorded conversation and swaps in the
 * recorded provider. That exists so somebody improving a prompt does not need
 * to fund an OpenAI account to see whether their change works — requiring a
 * credential to develop enrichment does not merely inconvenience contributors,
 * it selects which contributors exist.
 *
 * A recorded run is labelled everywhere it appears. Recorded output that looked
 * like a live answer would be a lie in the audit trail.
 */
function resolveProviderPort(env: NodeJS.ProcessEnv): {
  port: ProviderPort;
  recorded: boolean;
} {
  const cassettePath = env['CAREERFORGE_CASSETTE'];
  if (cassettePath !== undefined && cassettePath !== '') {
    const cassette = parseCassette(JSON.parse(readFileSync(cassettePath, 'utf8')));
    return { port: createRecordedProvider(cassette, { digest: sha256 }), recorded: true };
  }
  // Constructed here rather than at module load, so a missing key is a refusal
  // at the moment of use — with a remedy — and never something that stops the
  // rest of the CLI from working.
  return { port: createOpenAIProvider({ apiKey: env['OPENAI_API_KEY'] }), recorded: false };
}

export interface EnrichOptions {
  readonly workUnitId: string;
  readonly enrichmentType?: string;
  readonly providerId: string;
  readonly model?: string;
  readonly dryRun: boolean;
  readonly force: boolean;
}

function renderRun(
  label: string,
  fingerprint: { templateId: string; promptHash: string; inputHash: string },
  extra: readonly string[] = [],
): string[] {
  return [
    label,
    `    prompt   ${fingerprint.templateId} (${fingerprint.promptHash.slice(0, 12)})`,
    `    evidence ${fingerprint.inputHash.slice(0, 12)}`,
    ...extra,
  ];
}

/**
 * Interpret a work unit, through the gate and into a reviewable record.
 *
 * The command is deliberately unexciting about its own output. It prints what
 * the model said, and beside it the four things that decide whether to believe
 * any of it: which prompt version ran, which model actually answered, which
 * records each statement cites, and what was thrown away for citing something
 * that was never sent.
 *
 * That framing is the product. A tool that prints resume bullets is
 * commonplace; one where every generated sentence remains attributable,
 * inspectable, and challengeable is not.
 */
export async function enrich(
  env: NodeJS.ProcessEnv,
  options: EnrichOptions,
): Promise<CommandResult> {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  const requested = options.enrichmentType ?? 'skills';
  if (!ENRICHABLE_TYPES.includes(requested as EnrichmentType)) {
    return failure(
      `CareerForge has no published prompt for "${requested}".`,
      `Available: ${ENRICHABLE_TYPES.join(', ')}.`,
    );
  }
  const enrichmentType = requested as EnrichmentType;

  const { db } = openDatabase({ path: paths.database });
  try {
    const units = new WorkUnitStore(db, nodePlatform);
    const consentStore = new ConsentStore(db, nodePlatform);
    const enrichmentStore = new EnrichmentStore(db, nodePlatform);

    const unit = units.byId(options.workUnitId);
    if (unit === null) {
      return failure(
        `No work unit ${options.workUnitId}.`,
        'Run `careerforge units` to list them.',
      );
    }

    const inputs = unitInputs(db, units, unit.id);
    if (inputs.length === 0) {
      return failure(
        'That work unit has no evidence to interpret.',
        'Run `careerforge collect` and `careerforge group` first.',
      );
    }

    const provider = resolveProvider(options.providerId);
    const model = options.model ?? DEFAULT_MODELS[provider.id] ?? 'gpt-5';
    const startedAt = toInstant(new Date().toISOString());
    const { port, recorded } = resolveProviderPort(env);

    const outcome = await executeRun(
      { target: { kind: 'work_unit', id: unit.id }, enrichmentType, provider, model, inputs },
      {
        consent: (projectKey, providerId) => consentStore.lookup(projectKey, providerId),
        digest: sha256,
        provider: port,
        lookupCached: (fingerprint) => enrichmentStore.findCached(fingerprint),
        dryRun: options.dryRun,
        force: options.force,
      },
    );

    const header = [
      `Work unit: ${unit.title}`,
      `Reading:   ${inputs.length} record(s)`,
      `Asking:    ${provider.id} (${provider.locality}) for ${enrichmentType}`,
      ...(recorded ? ['', 'RECORDED — answering from a cassette, not from a live provider.'] : []),
      '',
    ];

    switch (outcome.kind) {
      case 'unsupported':
        return failure(outcome.refusal.reason, explainRefusal(outcome.refusal).next);

      case 'refused': {
        // Recorded even though nothing was sent. A trail containing only the
        // permitted calls answers "what left?" and not "what was attempted?",
        // and the second is the question asked after a scare.
        consentStore.recordDecision(outcome.decision);
        return {
          stdout: [
            ...header,
            'REFUSED — nothing was sent and nothing was recorded.',
            '',
            ...renderRefusals(outcome.refusals),
          ].join('\n'),
          stderr: '',
          exitCode: 1,
        };
      }

      case 'cached': {
        const run = enrichmentStore.runById(outcome.cached.runId);
        return ok(
          [
            ...header,
            'Already interpreted. No call was made and nothing was spent.',
            '',
            ...renderRun('  This answer came from an earlier run:', outcome.fingerprint, [
              `    model    ${run?.resolvedModel ?? outcome.fingerprint.model}`,
              `    run      ${outcome.cached.runId}`,
            ]),
            '',
            'The evidence, prompt, model, and parameters are all unchanged, so the answer',
            'would be the same answer. Use --force to ask anyway.',
            '',
          ].join('\n'),
        );
      }

      case 'dry_run':
        return ok(
          [
            ...header,
            'DRY RUN — nothing was sent.',
            '',
            ...renderRun('  This is what would run:', outcome.fingerprint),
            '',
            '  ── Instructions (static, versioned, evidence-free) ──',
            outcome.instructions.replace(/^/gm, '  '),
            '',
            '  ── Payload (your evidence, redacted) ──',
            outcome.payload.replace(/^/gm, '  '),
            '',
          ].join('\n'),
        );

      case 'completed': {
        const decisionId =
          provider.locality === 'remote' ? consentStore.recordDecision(outcome.decision) : null;

        const usable = outcome.validated.items.length > 0;
        const previousRuns = enrichmentStore.runsFor(unit.id, enrichmentType);

        const runId = enrichmentStore.recordRun({
          fingerprint: outcome.fingerprint,
          target: { kind: 'work_unit', id: unit.id },
          enrichmentType,
          resolvedModel: outcome.response.model,
          policyDecisionId: decisionId,
          redactionProfile: outcome.decision.redaction.profile,
          // An unusable run is recorded and never cached, so a bad answer does
          // not become permanent while the fact that it happened still does.
          status: usable ? 'completed' : 'unusable',
          usage: outcome.usage,
          validated: outcome.validated,
          startedAt,
        });

        const lines = [
          ...header,
          usable
            ? `${outcome.validated.items.length} interpretation(s), each citing what it read:`
            : 'Nothing usable came back.',
          '',
        ];

        for (const item of outcome.validated.items) {
          const value = item.value as Record<string, unknown>;
          const label = String(value['name'] ?? value['situation'] ?? '(unnamed)');
          lines.push(`  ${label}`);
          for (const [key, member] of Object.entries(value)) {
            if (key === 'name' || key === 'situation') continue;
            lines.push(`    ${key.padEnd(12)} ${String(member)}`);
          }
          lines.push(`    ${'cites'.padEnd(12)} ${item.evidence.join(', ')}`, '');
        }

        if (outcome.validated.rejections.length > 0) {
          lines.push(
            `Discarded ${outcome.validated.rejections.length} item(s):`,
            ...outcome.validated.rejections.map((r) => `  ${r.reason.padEnd(20)} ${r.summary}`),
            '',
          );
        }

        if (outcome.validated.unknownCitations.length > 0) {
          lines.push(
            'The model cited records that were never sent to it:',
            ...outcome.validated.unknownCitations.map((id) => `  ${id}`),
            '',
            'Statements resting only on those were discarded. Nothing in your store',
            'stands behind them.',
            '',
          );
        }

        const previous = previousRuns[0];
        if (previous !== undefined) {
          const current = enrichmentStore.runById(runId)!;
          lines.push(
            'Different from the last run because:',
            ...explainDifference(previous, current, true).map(
              (difference) => `  ${difference.dimension.padEnd(22)} ${difference.explanation}`,
            ),
            '',
          );
        }

        lines.push(
          `Recorded as run ${runId}.`,
          `  prompt   ${outcome.fingerprint.templateId}`,
          `  asked    ${model}`,
          `  answered ${outcome.response.model}`,
          `  cost     ${outcome.usage.inputTokens} in, ${outcome.usage.outputTokens} out`,
          '',
          'None of this supports anything yet. An interpretation explains a record; it',
          'never stands behind a claim, and `careerforge explain` shows it on the',
          'interpretation side of the line rather than among the grounds.',
          '',
        );

        return ok(lines.join('\n'));
      }
    }
  } finally {
    closeDatabase(db);
  }
}

export interface EnrichmentsOptions {
  readonly workUnitId: string;
  readonly showRuns: boolean;
}

/**
 * What a model has said about a work unit, and whether to believe it.
 *
 * The review surface. Every interpretation is shown with the run that produced
 * it, the records it cites, whether the evidence beneath it has moved, and
 * whether a person has passed judgement on it yet. Unreviewed is the default
 * and stays visible: an AI output that quietly becomes authoritative by never
 * being questioned is the failure this whole design is arranged against.
 */
export function enrichments(env: NodeJS.ProcessEnv, options: EnrichmentsOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const units = new WorkUnitStore(db, nodePlatform);
    const store = new EnrichmentStore(db, nodePlatform);

    const unit = units.byId(options.workUnitId);
    if (unit === null) {
      return failure(
        `No work unit ${options.workUnitId}.`,
        'Run `careerforge units` to list them.',
      );
    }

    const byId = new Map(
      unitInputs(db, units, unit.id).map((input) => [input.id, input.contentHash]),
    );
    // The same hashing the run used, so staleness compares like with like. A
    // record that has left the unit hashes as absent, which is a change.
    const currentHash = (ids: readonly string[]): string =>
      sha256(canonicalise([...ids].sort().map((id) => [id, byId.get(id) ?? null])));

    const current = store.currentFor(unit.id, currentHash);
    if (current.length === 0) {
      return ok(
        [
          `Work unit: ${unit.title}`,
          '',
          'Nothing has been interpreted yet.',
          '',
          `  careerforge enrich --unit ${unit.id} --type skills`,
          '',
        ].join('\n'),
      );
    }

    const lines = [`Work unit: ${unit.title}`, ''];
    for (const item of current) {
      const value = item.value as Record<string, unknown>;
      const label = String(value['name'] ?? value['situation'] ?? '(unnamed)');
      lines.push(
        `  ${item.stale ? 'STALE   ' : '        '}${item.reviewState.padEnd(11)} ${label}`,
        `            cites  ${item.basis.join(', ')}`,
        `            run    ${item.runId}`,
        '',
      );
    }

    if (current.some((item) => item.stale)) {
      lines.push(
        'STALE means the evidence beneath the interpretation has been corrected or',
        'superseded since it was made. Re-run to interpret what is true now.',
        '',
      );
    }

    if (options.showRuns) {
      lines.push('Runs, newest first:', '');
      const runs = store.runsFor(unit.id);
      for (const [index, run] of runs.entries()) {
        lines.push(
          `  ${run.id}  ${run.enrichmentType}  ${run.status}`,
          `    prompt   ${run.templateId} (${run.promptHash.slice(0, 12)})`,
          `    asked    ${run.model}`,
          `    answered ${run.resolvedModel ?? '(not recorded)'}`,
          `    evidence ${run.inputHash.slice(0, 12)} over ${run.inputIds.length} record(s)`,
          `    cost     ${run.inputTokens} in, ${run.outputTokens} out`,
        );
        const older = runs[index + 1];
        if (older !== undefined && older.enrichmentType === run.enrichmentType) {
          for (const difference of explainDifference(older, run, true)) {
            lines.push(`    changed  ${difference.explanation}`);
          }
        }
        lines.push('');
      }
    }

    lines.push(
      'Every statement above is an interpretation, not a fact. None of them supports a',
      'claim, and none will unless you confirm it. Accepting or rejecting one writes a',
      'new record rather than editing this one, so what the model first said stays',
      'answerable.',
      '',
    );

    return ok(lines.join('\n'));
  });
}

// ── Generation and review ─────────────────────────────────────────────────

/**
 * Render an evidence assessment the way every surface should render it.
 *
 * The grade is one word and a bullet resting on one commit deserves more than
 * one word, so the signals carry the nuance. Strengths and limits are shown
 * together and in that order: a reader who sees only strengths has been sold
 * something.
 */
function renderAssessment(assessment: EvidenceAssessment, indent = ''): string[] {
  const strengths = assessment.signals.filter((s) => signalPolarity(s) === 'strength');
  const limits = assessment.signals.filter((s) => signalPolarity(s) === 'limit');

  const lines = [`${indent}Evidence: ${summariseAssessment(assessment)}`, ''];
  for (const signal of strengths) lines.push(`${indent}  + ${describeSignal(signal)}`);
  for (const signal of limits) lines.push(`${indent}  - ${describeSignal(signal)}`);

  if (assessment.droppedClaimTypes.length > 0) {
    lines.push(
      '',
      `${indent}  Left out for want of evidence: ${assessment.droppedClaimTypes.join(', ')}.`,
    );
  }
  return lines;
}

export interface GenerateOptions {
  readonly workUnitId: string;
  readonly providerId: string;
  readonly model?: string;
  readonly dryRun: boolean;
  readonly force: boolean;
}

/**
 * Turn a work unit into a résumé bullet, with the check in the middle.
 *
 * The model returns typed, cited assertions — never prose. Each one faces the
 * support predicate; whatever fails becomes a question rather than a softer
 * sentence; and the bullet is composed afterwards from what survived, so a
 * failed claim's words are never placed at all.
 *
 * The output leads with the sentence and then says what stands behind it,
 * because the second part is the reason to trust the first.
 */
export async function generate(
  env: NodeJS.ProcessEnv,
  options: GenerateOptions,
): Promise<CommandResult> {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  const { db } = openDatabase({ path: paths.database });
  try {
    const units = new WorkUnitStore(db, nodePlatform);
    const consentStore = new ConsentStore(db, nodePlatform);
    const enrichmentStore = new EnrichmentStore(db, nodePlatform);
    const provenance = new ProvenanceStore(db, nodePlatform);
    const assetStore = new AssetStore(db, nodePlatform);

    const unit = units.byId(options.workUnitId);
    if (unit === null) {
      return failure(
        `No work unit ${options.workUnitId}.`,
        'Run `careerforge units` to list them.',
      );
    }

    const inputs = unitInputs(db, units, unit.id);
    if (inputs.length === 0) {
      return failure(
        'That work unit has no evidence to write about.',
        'Run `careerforge collect` and `careerforge group` first.',
      );
    }

    const provider = resolveProvider(options.providerId);
    const model = options.model ?? DEFAULT_MODELS[provider.id] ?? 'gpt-5';
    const startedAt = toInstant(new Date().toISOString());
    const { port, recorded } = resolveProviderPort(env);

    const outcome = await executeRun(
      {
        target: { kind: 'work_unit', id: unit.id },
        enrichmentType: 'resume_bullet',
        provider,
        model,
        inputs,
      },
      {
        consent: (projectKey, providerId) => consentStore.lookup(projectKey, providerId),
        digest: sha256,
        provider: port,
        // Deliberately no cache lookup. A bullet's worth depends on evidence
        // that has moved, questions that have been answered, and records that
        // have been withdrawn — none of which change the run fingerprint. A
        // cached proposal would be re-checked against today's evidence, which
        // sounds fine until the proposal itself is a year out of date.
        dryRun: options.dryRun,
        force: options.force,
      },
    );

    const header = [
      `Work unit: ${unit.title}`,
      `Reading:   ${inputs.length} record(s)`,
      ...(recorded ? ['', 'RECORDED — answering from a cassette, not from a live provider.'] : []),
      '',
    ];

    if (outcome.kind === 'unsupported') {
      return failure(outcome.refusal.reason, explainRefusal(outcome.refusal).next);
    }

    if (outcome.kind === 'refused') {
      consentStore.recordDecision(outcome.decision);
      return {
        stdout: [
          ...header,
          'REFUSED — nothing was sent and nothing was written.',
          '',
          ...renderRefusals(outcome.refusals),
        ].join('\n'),
        stderr: '',
        exitCode: 1,
      };
    }

    if (outcome.kind === 'dry_run') {
      return ok(
        [
          ...header,
          'DRY RUN — nothing was sent.',
          '',
          `  prompt   ${outcome.fingerprint.templateId}`,
          '',
          '  ── Instructions ──',
          outcome.instructions.replace(/^/gm, '  '),
          '',
          '  ── Payload ──',
          outcome.payload.replace(/^/gm, '  '),
          '',
        ].join('\n'),
      );
    }

    if (outcome.kind === 'cached') {
      return failure('Unexpected cache hit.', 'Generation does not cache. This is a bug.');
    }

    const decisionId =
      provider.locality === 'remote' ? consentStore.recordDecision(outcome.decision) : null;

    const proposals: ProposedClaim[] = outcome.validated.items.map((item) => ({
      text: String((item.value as Record<string, unknown>)['text'] ?? ''),
      claimType: (item.value as Record<string, unknown>)['claimType'] as ClaimType,
      evidence: item.evidence,
    }));

    const runId = enrichmentStore.recordRun({
      fingerprint: outcome.fingerprint,
      target: { kind: 'work_unit', id: unit.id },
      enrichmentType: 'resume_bullet',
      resolvedModel: outcome.response.model,
      policyDecisionId: decisionId,
      redactionProfile: outcome.decision.redaction.profile,
      status: proposals.length > 0 ? 'completed' : 'unusable',
      usage: outcome.usage,
      // The run records that a proposal was made and what it cost. The
      // proposals themselves become claims or questions; storing them as
      // enrichments too would put an unchecked assertion in the store
      // alongside the checked ones.
      validated: {
        items: [],
        rejections: outcome.validated.rejections,
        unknownCitations: outcome.validated.unknownCitations,
      },
      startedAt,
    });

    const bullet = generateBullet(proposals, {
      workUnitId: unit.id,
      available: inputs.map(toCandidateRecord),
      openQuestionCount: provenance.openGaps(unit.id).length,
    });

    const lines = [...header];

    if (!isPublishable(bullet)) {
      const gapIds = assetStore.raiseQuestionsOnly(unit.id, bullet);
      return {
        stdout: [
          ...lines,
          'Nothing in the evidence supported any part of this. No bullet was written.',
          '',
          ...renderDropped(bullet.dropped),
          gapIds.length === 0
            ? 'Those questions were already open.'
            : `${gapIds.length} question(s) recorded. Answer them with \`careerforge interview --unit ${unit.id}\`.`,
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }

    const recordedAsset = assetStore.record({
      assetType: 'resume_bullet',
      workUnitId: unit.id,
      runId,
      bullet,
    });

    lines.push(bullet.text, '');

    lines.push('Every part of that, and what stands behind it:', '');
    for (const [index, claim] of bullet.claims.entries()) {
      lines.push(
        `  ${claim.claimType.padEnd(8)} ${claim.text}`,
        `           cites ${claim.evidence.join(', ')}`,
        `           claim ${recordedAsset.claimIds[index] ?? '(unrecorded)'}`,
        '',
      );
    }

    if (bullet.dropped.length > 0) {
      lines.push(...renderDropped(bullet.dropped));
    }

    lines.push(...renderAssessment(bullet.assessment), '');

    lines.push(
      `Recorded as ${recordedAsset.id}, in draft.`,
      '',
      'Nothing leaves CareerForge until you have read it:',
      `  careerforge review ${recordedAsset.id} --accept`,
      '',
    );

    return ok(lines.join('\n'));
  } finally {
    closeDatabase(db);
  }
}

/**
 * What was left out, and the question it raises.
 *
 * Shown every time, prominently. A generator that quietly drops what it cannot
 * support looks identical to one that had nothing to drop, and the difference
 * is the whole product.
 */
function renderDropped(dropped: readonly DroppedClaim[]): string[] {
  const lines = [
    `Left out — the evidence does not carry ${dropped.length === 1 ? 'it' : 'them'}:`,
    '',
  ];
  for (const claim of dropped) {
    lines.push(
      `  ${claim.claimType.padEnd(8)} "${claim.text}"`,
      `           ${claim.reason}`,
      `           -> ${claim.question}`,
      '',
    );
  }
  return lines;
}

const toCandidateRecord = (input: UnitRecord): CandidateRecord => ({
  id: input.id,
  collectorId: input.collectorId,
  kind: input.kind,
  evidenceClass: input.evidenceClass,
  attributes: input.attributes,
  text: input.text,
  suppressed: false,
});

export interface ReviewOptions {
  readonly assetId: string;
  readonly decision?: 'accept' | 'reject';
  readonly edit?: string;
}

/**
 * Read an asset and decide about it.
 *
 * With no decision this is a reading surface: the words, every claim and what
 * cites it, what was left out, and how strong the evidence is *now* rather
 * than when it was written. A person cannot approve what they have not been
 * shown, and the gate is worth nothing if approving is easier than reading.
 */
export function review(env: NodeJS.ProcessEnv, options: ReviewOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const assetStore = new AssetStore(db, nodePlatform);
    const provenance = new ProvenanceStore(db, nodePlatform);

    const assessed = assetStore.assess(options.assetId);
    if (assessed === null) {
      return failure(`No asset ${options.assetId}.`, 'Run `careerforge units` to find one.');
    }

    if (options.edit !== undefined) {
      const result = assetStore.applyEdit(assessed.id, options.edit);
      if (result.kind === 'factual') {
        return failure(
          'That edit changes what is being asserted, not how it is worded.',
          'CareerForge records wording changes as style examples. A change to the claims has to be evidenced — answer the relevant question with `careerforge interview` and regenerate.',
        );
      }
      return ok(
        [
          'Recorded your wording, and kept it as an example for future drafts.',
          '',
          `  ${options.edit}`,
          '',
          'The claims are unchanged, so the evidence behind them still holds.',
          '',
        ].join('\n'),
      );
    }

    if (options.decision !== undefined) {
      const newId = assetStore.review(
        assessed.id,
        options.decision === 'accept' ? 'reviewed' : 'rejected',
      );
      return ok(
        options.decision === 'accept'
          ? [
              'Accepted. This may now be exported.',
              '',
              `  ${assessed.text}`,
              '',
              `Recorded as ${newId}. The draft you read stays in the store beside it.`,
              '',
            ].join('\n')
          : [
              'Rejected. It will not be exported.',
              '',
              `Recorded as ${newId}. Nothing was deleted — what was generated stays queryable`,
              'beside your decision about it.',
              '',
            ].join('\n'),
      );
    }

    // Through the revision chain: a reviewed asset's claims live on the row
    // they were first recorded against.
    const claims = assetStore.claimsFor(assessed.id);
    const lines = [
      `Asset ${assessed.id} · ${assessed.assetType} · ${assessed.reviewState}`,
      '',
      assessed.text,
      '',
      'Every part of that, and what stands behind it:',
      '',
    ];

    for (const claim of claims) {
      const explanation = provenance.explain(claim.id);
      lines.push(
        `  ${claim.claimType.padEnd(8)} ${claim.text}`,
        `           ${explanation?.grounds.length ?? 0} grounding record(s), ${explanation?.interpretation.length ?? 0} interpretation(s)`,
        `           careerforge explain ${claim.id}`,
        '',
      );
    }

    lines.push(...renderAssessment(assessed.assessmentNow), '');

    if (assessed.assessmentDrifted) {
      // The reason the assessment is recomputed rather than only stored. A
      // judgement that cannot disagree with reality is not a judgement.
      lines.push(
        'The evidence has moved since this was written.',
        `  when written: ${summariseAssessment(assessed.assessmentAtGeneration)}`,
        `  now:          ${summariseAssessment(assessed.assessmentNow)}`,
        '',
        'Regenerate before relying on it.',
        '',
      );
    }

    if (assessed.reviewState === 'draft') {
      lines.push(
        'Nothing leaves CareerForge until you decide:',
        `  careerforge review ${assessed.id} --accept`,
        `  careerforge review ${assessed.id} --reject`,
        `  careerforge review ${assessed.id} --edit "your wording"`,
        '',
      );
    }

    return ok(lines.join('\n'));
  });
}

export interface AssetsOptions {
  readonly workUnitId?: string;
  readonly markdown: boolean;
}

/**
 * List assets, or export the reviewed ones as Markdown.
 *
 * The export gate lives in the store's `exportable()`, not here. A command
 * that filtered by review state itself would be a gate one caller wide, and
 * the next caller would forget.
 */
export function assets(env: NodeJS.ProcessEnv, options: AssetsOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const assetStore = new AssetStore(db, nodePlatform);
    const units = new WorkUnitStore(db, nodePlatform);

    if (options.markdown) {
      const exportable = assetStore.exportable(options.workUnitId);
      if (exportable.length === 0) {
        return failure(
          'Nothing has been reviewed yet, so there is nothing to export.',
          'Read a draft with `careerforge review <asset-id>` and accept it.',
        );
      }
      const lines = ['# Experience', ''];
      for (const asset of exportable) {
        const assessed = assetStore.assess(asset.id)!;
        lines.push(
          `- ${asset.text}`,
          `  <!-- evidence: ${summariseAssessment(assessed.assessmentNow)} -->`,
        );
      }
      lines.push('');
      return ok(lines.join('\n'));
    }

    const all =
      options.workUnitId === undefined
        ? units.currentUnits().flatMap((unit) => assetStore.forWorkUnit(unit.id))
        : assetStore.forWorkUnit(options.workUnitId);

    if (all.length === 0) {
      return ok(
        [
          'Nothing has been generated yet.',
          '',
          '  careerforge generate resume-bullet --unit <id>',
          '',
        ].join('\n'),
      );
    }

    const lines = ['Generated assets:', ''];
    for (const asset of all) {
      lines.push(
        `  ${asset.reviewState.padEnd(9)} ${asset.grade.padEnd(13)} ${asset.id}`,
        `            ${asset.text}`,
        '',
      );
    }
    lines.push(
      'A draft has not been read by anybody and cannot be exported.',
      'Read one with `careerforge review <asset-id>`.',
      '',
    );
    return ok(lines.join('\n'));
  });
}

// ── Evidence Explorer ─────────────────────────────────────────────────────

export interface UiOptions {
  readonly port: number;
  readonly open: boolean;
}

/**
 * Serve the Evidence Explorer to this machine's browser.
 *
 * Long-running, unlike every other command here: it returns when the server
 * stops. The store connection is held open for the life of the server and
 * closed on shutdown, which is the one place in the CLI where that is correct
 * — every request needs it, and reopening per request would be a lie about
 * consistency.
 */
export async function ui(env: NodeJS.ProcessEnv, options: UiOptions): Promise<CommandResult> {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  const { db } = openDatabase({ path: paths.database });
  let explorer: Awaited<ReturnType<typeof createExplorerServer>>;
  try {
    explorer = await createExplorerServer({ db, port: options.port });
  } catch (error) {
    closeDatabase(db);
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      `Could not start the Explorer: ${message}`,
      message.includes('EADDRINUSE')
        ? `Something is already listening on port ${options.port}. Try --port ${options.port + 1}.`
        : 'Check that nothing else is using the port.',
    );
  }

  process.stdout.write(
    [
      `Evidence Explorer is running at ${explorer.url}`,
      '',
      'It is bound to this machine only — 127.0.0.1, and not configurable. Nothing',
      'on the page has left your computer, and the Explorer holds no API key and no',
      'network client of its own.',
      '',
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );

  if (options.open) openInBrowser(explorer.url);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void explorer.close().then(() => {
        closeDatabase(db);
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return ok('Evidence Explorer stopped.\n');
}

/**
 * Open the user's browser, and shrug if it does not work.
 *
 * Best effort by design: a failure here means the user pastes a URL, a mild
 * inconvenience, whereas treating it as fatal would make the Explorer unusable
 * on any system whose opener is unusual.
 */
function openInBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(command, [url], { shell: process.platform === 'win32', detached: true, stdio: 'ignore' })
      .on('error', () => undefined)
      .unref();
  } catch {
    // The URL is already printed above.
  }
}
