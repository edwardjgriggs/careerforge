import { existsSync } from 'node:fs';
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
 * Doctor never throws. A diagnostic tool that crashes is worse than none, so
 * every check returns a result rather than raising.
 */
export function runChecks(env: NodeJS.ProcessEnv = process.env): Check[] {
  return [checkNode(), checkPlatform(), checkHome(env), ...checkStore(env)];
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
