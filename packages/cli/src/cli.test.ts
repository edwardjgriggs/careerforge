import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run } from './cli.js';
import { checkHome, checkNode, formatChecks, parseNodeVersion, runChecks } from './doctor.js';
import { careerforgeHome, resolvePaths } from './paths.js';

describe('argument handling', () => {
  it('prints usage with no arguments and exits 0', async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stderr).toBe('');
  });

  it.each(['--help', '-h', 'help'])('prints usage for %s', async (flag) => {
    expect((await run([flag])).exitCode).toBe(0);
    expect((await run([flag])).stdout).toContain('Commands:');
  });

  it.each(['--version', '-v', 'version'])('prints a semver-shaped version for %s', async (flag) => {
    const result = await run([flag]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects an unknown command with exit code 2 and a next step', async () => {
    const result = await run(['nope']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown command: nope');
    expect(result.stderr).toContain('--help');
  });

  it('rejects an unknown option with exit code 2', async () => {
    const result = await run(['--nope']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown option: --nope');
  });

  it('every documented command appears in usage with an example', async () => {
    const usage = (await run(['--help'])).stdout;
    expect(usage).toContain('doctor');
    expect(usage).toContain('Examples:');
  });

  it('doctor has its own help with an example', async () => {
    const help = (await run(['doctor', '--help'])).stdout;
    expect(help).toContain('careerforge doctor');
    expect(help).toContain('Example:');
  });
});

describe('doctor', () => {
  it('reports Node, platform, and home, and exits 0 on a healthy machine', async () => {
    const result = await run(['doctor'], { CAREERFORGE_HOME: tmpdir() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Node.js');
    expect(result.stdout).toContain('Platform');
    expect(result.stdout).toContain('CareerForge home');
  });

  it('never throws, whatever the environment', async () => {
    expect(() => runChecks({})).not.toThrow();
    expect(() => runChecks({ CAREERFORGE_HOME: '' })).not.toThrow();
  });

  it('flags a Node version below the minimum', async () => {
    const check = checkNode('v18.0.0');
    expect(check.status).toBe('fail');
    expect(check.fix).toBeDefined();
  });

  it('accepts the current runtime', async () => {
    expect(checkNode().status).toBe('ok');
  });

  it('flags an unparseable Node version rather than crashing', async () => {
    expect(checkNode('banana').status).toBe('fail');
    expect(parseNodeVersion('banana')).toBeNull();
  });

  it('warns when the home directory does not exist yet, and says what happens next', async () => {
    const missing = join(tmpdir(), `careerforge-absent-${process.pid}`);
    const check = checkHome({ CAREERFORGE_HOME: missing });
    expect(check.status).toBe('warn');
    expect(check.fix).toBeDefined();
  });

  it('reports ok when the home directory exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'careerforge-'));
    try {
      const check = checkHome({ CAREERFORGE_HOME: dir });
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('CAREERFORGE_HOME');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives every non-ok check an actionable next step', async () => {
    const checks = [checkNode('v18.0.0'), checkHome({ CAREERFORGE_HOME: '/nonexistent-cf-path' })];
    for (const check of checks.filter((c) => c.status !== 'ok')) {
      expect(check.fix, `${check.id} needs a fix hint`).toBeTruthy();
    }
  });

  it('formats a readable report', async () => {
    const output = formatChecks(runChecks({ CAREERFORGE_HOME: tmpdir() }));
    expect(output).toContain('CareerForge doctor');
    expect(output).toMatch(/All checks passed|need attention|failed/);
  });
});

describe('paths', () => {
  it('honours CAREERFORGE_HOME', async () => {
    expect(careerforgeHome({ CAREERFORGE_HOME: '/custom' })).toBe('/custom');
  });

  it('ignores a blank CAREERFORGE_HOME', async () => {
    expect(careerforgeHome({ CAREERFORGE_HOME: '   ' })).toContain('.careerforge');
  });

  it('keeps everything under a single home directory', async () => {
    // Compared with path.relative rather than string prefixes: on Windows,
    // join('/custom', 'blobs') yields '\custom\blobs', so a naive startsWith
    // check passes on POSIX and fails here.
    const home = '/custom';
    const paths = resolvePaths({ CAREERFORGE_HOME: home });
    for (const [key, value] of Object.entries(paths)) {
      if (key === 'home') continue;
      const rel = relative(home, value);
      expect(rel.startsWith('..'), `${key} escaped the home directory`).toBe(false);
      expect(isAbsolute(rel), `${key} should be relative to home`).toBe(false);
    }
  });
});
