import { existsSync } from 'node:fs';
import { arch, platform, release } from 'node:os';

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

export const MINIMUM_NODE_MAJOR = 20;
export const MINIMUM_NODE_MINOR = 11;

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
 * Doctor never throws. A diagnostic tool that crashes is worse than none, so
 * every check returns a result rather than raising.
 */
export function runChecks(env: NodeJS.ProcessEnv = process.env): Check[] {
  return [checkNode(), checkPlatform(), checkHome(env)];
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
