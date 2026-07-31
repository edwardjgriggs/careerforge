import { existsSync, statSync } from 'node:fs';
import { arch, platform, release } from 'node:os';

import {
  checkIntegrity,
  closeDatabase,
  LATEST_SCHEMA_VERSION,
  openDatabase,
  schemaVersion,
  type Db,
} from '@careerforge/store';

import { resolvePaths } from './paths.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  /** Short, stable identifier. Used in tests; do not reword casually. */
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What the user should do next. Required whenever status is not `ok`. */
  readonly fix?: string;
}

export const MINIMUM_NODE_MAJOR = 22;
export const MINIMUM_NODE_MINOR = 0;

/** Parse a `v22.23.1`-style version into numeric parts. Returns null if unparseable. */
export function parseNodeVersion(raw: string): { major: number; minor: number } | null {
  const match = /^v?(\d+)\.(\d+)\./.exec(raw);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

export function checkNode(version: string = process.version): Check {
  const parsed = parseNodeVersion(version);
  if (parsed === null) {
    return {
      id: 'node.version',
      label: 'Node.js',
      status: 'fail',
      detail: `Unrecognized version string: ${version}`,
      fix: `Install Node.js ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR} or newer.`,
    };
  }
  const tooOld =
    parsed.major < MINIMUM_NODE_MAJOR ||
    (parsed.major === MINIMUM_NODE_MAJOR && parsed.minor < MINIMUM_NODE_MINOR);
  if (tooOld) {
    return {
      id: 'node.version',
      label: 'Node.js',
      status: 'fail',
      detail: `${version} is older than the required ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR}`,
      fix: `Upgrade to Node.js ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR} or newer.`,
    };
  }
  return { id: 'node.version', label: 'Node.js', status: 'ok', detail: version };
}

export function checkPlatform(): Check {
  return {
    id: 'platform',
    label: 'Platform',
    status: 'ok',
    detail: `${platform()} ${release()} (${arch()})`,
  };
}

export function checkHome(env: NodeJS.ProcessEnv = process.env): Check {
  const paths = resolvePaths(env);
  const overridden = typeof env['CAREERFORGE_HOME'] === 'string' && env['CAREERFORGE_HOME'] !== '';
  const source = overridden ? ' (from CAREERFORGE_HOME)' : '';
  if (!existsSync(paths.home)) {
    return {
      id: 'home',
      label: 'CareerForge home',
      status: 'warn',
      detail: `${paths.home} does not exist yet${source}`,
      fix: 'It will be created the first time CareerForge stores anything.',
    };
  }
  return { id: 'home', label: 'CareerForge home', status: 'ok', detail: `${paths.home}${source}` };
}

/**
 * Inspect the store without creating one.
 *
 * `doctor` is a diagnostic, so it must never have side effects — running it on
 * a machine with no store should say "no store", not quietly create one.
 */
export function checkStore(env: NodeJS.ProcessEnv = process.env): Check[] {
  const paths = resolvePaths(env);

  if (!existsSync(paths.database)) {
    return [
      {
        id: 'store',
        label: 'Evidence store',
        status: 'warn',
        detail: `No database at ${paths.database}`,
        fix: 'It will be created the first time CareerForge collects anything.',
      },
    ];
  }

  let opened: { db: Db } | null = null;
  try {
    opened = openDatabase({ path: paths.database, migrate: false, mustExist: true });
    const version = schemaVersion(opened.db);
    const integrity = checkIntegrity(opened.db);
    const evidenceCount = (
      opened.db.prepare('SELECT COUNT(*) AS n FROM evidence_current').get() as { n: number }
    ).n;

    const checks: Check[] = [];

    if (version < LATEST_SCHEMA_VERSION) {
      checks.push({
        id: 'store.schema',
        label: 'Schema',
        status: 'warn',
        detail: `v${version}, this build expects v${LATEST_SCHEMA_VERSION}`,
        fix: 'Migrations run automatically on the next command. A backup is taken first.',
      });
    } else if (version > LATEST_SCHEMA_VERSION) {
      checks.push({
        id: 'store.schema',
        label: 'Schema',
        status: 'fail',
        detail: `v${version} was written by a newer CareerForge; this build supports v${LATEST_SCHEMA_VERSION}`,
        fix: 'Upgrade CareerForge. An older build must not write to a newer store.',
      });
    } else {
      checks.push({ id: 'store.schema', label: 'Schema', status: 'ok', detail: `v${version}` });
    }

    checks.push(
      integrity.ok
        ? { id: 'store.integrity', label: 'Integrity', status: 'ok', detail: 'no problems found' }
        : {
            id: 'store.integrity',
            label: 'Integrity',
            status: 'fail',
            detail: integrity.problems.slice(0, 3).join('; '),
            fix: 'Restore from a backup in the backups directory, or rebuild from your JSON export.',
          },
    );

    checks.push({
      id: 'store.evidence',
      label: 'Evidence',
      status: 'ok',
      detail: `${evidenceCount} current record${evidenceCount === 1 ? '' : 's'}`,
    });

    return checks;
  } catch (error) {
    return [
      {
        id: 'store',
        label: 'Evidence store',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
        fix: 'The database may be corrupt or locked by another process. Check the backups directory.',
      },
    ];
  } finally {
    if (opened !== null) closeDatabase(opened.db);
  }
}

/**
 * Whether enrichment can run.
 *
 * A warning, never a failure. AI is additive (ADR-0005) and everything except
 * generation works without a key — reporting a missing key as `fail` would
 * tell a user their installation is broken when it is complete and working,
 * which is exactly the impression this product cannot afford to give.
 */
export function checkProvider(env: NodeJS.ProcessEnv = process.env): Check {
  const key = env['OPENAI_API_KEY'];
  if (key === undefined || key.trim() === '') {
    return {
      id: 'provider.key',
      label: 'AI provider',
      status: 'warn',
      detail: 'no API key configured',
      fix: 'Set OPENAI_API_KEY to generate statements. Collecting, grouping, searching, explaining, and the interview all work without one.',
    };
  }
  return {
    id: 'provider.key',
    label: 'AI provider',
    status: 'ok',
    detail: 'OPENAI_API_KEY is set',
  };
}

/**
 * What the user has allowed to leave the machine.
 *
 * Never a failure either: no grants is the correct and intended starting
 * state. It is reported because a user debugging "why was that refused?"
 * should be able to see the answer here rather than deducing it.
 */
export function checkConsent(env: NodeJS.ProcessEnv = process.env): Check {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return { id: 'consent', label: 'Consent', status: 'ok', detail: 'no store yet' };
  }

  let opened: { db: Db } | null = null;
  try {
    opened = openDatabase({ path: paths.database });
    const row = opened.db
      .prepare(`SELECT COUNT(*) AS n FROM consent_grants_current WHERE revoked = 0`)
      .get() as { n: number };
    return {
      id: 'consent',
      label: 'Consent',
      status: 'ok',
      detail:
        row.n === 0
          ? 'nothing may leave this machine — the default'
          : `${row.n} provider grant(s) in place`,
    };
  } catch {
    return {
      id: 'consent',
      label: 'Consent',
      status: 'ok',
      detail: 'unreadable; see the store check',
    };
  } finally {
    if (opened !== null) closeDatabase(opened.db);
  }
}

/**
 * Whether any collector has ever run.
 *
 * The single most useful diagnosis for a new user, because an empty store and
 * a broken installation look identical from the outside and feel identical to
 * somebody who has just installed something.
 */
export function checkCollectors(env: NodeJS.ProcessEnv = process.env): Check {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return {
      id: 'collectors',
      label: 'Collectors',
      status: 'warn',
      detail: 'no store yet',
      fix: 'Run `careerforge init`, then `careerforge collect --backfill`.',
    };
  }

  let opened: { db: Db } | null = null;
  try {
    opened = openDatabase({ path: paths.database });
    const rows = opened.db
      .prepare(`SELECT collector_id, COUNT(*) AS n FROM evidence_current GROUP BY collector_id`)
      .all() as { collector_id: string; n: number }[];

    if (rows.length === 0) {
      return {
        id: 'collectors',
        label: 'Collectors',
        status: 'warn',
        detail: 'no collector has run yet',
        fix: 'Run `careerforge collect --backfill`, or `careerforge tour` to see what it would do first.',
      };
    }
    return {
      id: 'collectors',
      label: 'Collectors',
      status: 'ok',
      detail: rows.map((row) => `${row.collector_id} (${row.n})`).join(', '),
    };
  } catch {
    return {
      id: 'collectors',
      label: 'Collectors',
      status: 'warn',
      detail: 'unreadable; see the store check',
      fix: 'Run `careerforge doctor` again after resolving the store problem above.',
    };
  } finally {
    if (opened !== null) closeDatabase(opened.db);
  }
}

/**
 * Whether the durable JSON copy still matches the database.
 *
 * A stale export is the difference between having a backup and believing you
 * have one, and nothing else surfaces it.
 */
export function checkExport(env: NodeJS.ProcessEnv = process.env): Check {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return { id: 'export', label: 'Export', status: 'ok', detail: 'no store yet' };
  }
  if (!existsSync(paths.exportDir)) {
    return {
      id: 'export',
      label: 'Export',
      status: 'warn',
      detail: 'never exported',
      fix: 'Run `careerforge export`. The JSON tree is the durable copy — the database is a cache of it.',
    };
  }

  let opened: { db: Db } | null = null;
  try {
    opened = openDatabase({ path: paths.database });
    const latest = opened.db.prepare(`SELECT MAX(recorded_at) AS at FROM evidence`).get() as {
      at: string | null;
    };
    const exportedAt = statSync(paths.exportDir).mtime.toISOString();

    if (latest.at !== null && latest.at > exportedAt) {
      return {
        id: 'export',
        label: 'Export',
        status: 'warn',
        detail: `evidence recorded since the last export (${exportedAt.slice(0, 10)})`,
        fix: 'Run `careerforge export` to bring the durable copy up to date.',
      };
    }
    return {
      id: 'export',
      label: 'Export',
      status: 'ok',
      detail: `current as of ${exportedAt.slice(0, 10)}`,
    };
  } catch {
    return {
      id: 'export',
      label: 'Export',
      status: 'ok',
      detail: 'unreadable; see the store check',
    };
  } finally {
    if (opened !== null) closeDatabase(opened.db);
  }
}

/**
 * Doctor never throws. A diagnostic tool that crashes is worse than none, so
 * every check returns a result rather than raising.
 */
export function runChecks(env: NodeJS.ProcessEnv = process.env): Check[] {
  return [
    checkNode(),
    checkPlatform(),
    checkHome(env),
    ...checkStore(env),
    checkCollectors(env),
    checkConsent(env),
    checkProvider(env),
    checkExport(env),
  ];
}

const SYMBOL: Record<CheckStatus, string> = { ok: '+', warn: '!', fail: 'x' };

export function formatChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines = checks.map((check) => {
    const head = `  ${SYMBOL[check.status]} ${check.label.padEnd(width)}  ${check.detail}`;
    return check.fix === undefined ? head : `${head}\n      -> ${check.fix}`;
  });
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const summary =
    failed > 0
      ? `\n${failed} check(s) failed.`
      : warned > 0
        ? `\n${warned} check(s) need attention.`
        : '\nAll checks passed.';
  return `CareerForge doctor\n\n${lines.join('\n')}\n${summary}`;
}
