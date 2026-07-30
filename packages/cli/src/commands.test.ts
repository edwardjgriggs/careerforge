import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toInstant } from '@careerforge/domain';
import { closeDatabase, EvidenceStore, nodePlatform, openDatabase } from '@careerforge/store';

import { COMMAND_NAMES, run } from './cli.js';
import { resolvePaths } from './paths.js';

/**
 * The command surface, exercised against real stores in a temp directory.
 *
 * `run` returns its output rather than printing, so the whole surface is
 * testable without spawning a process.
 */

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cf-cli-'));
  env = { CAREERFORGE_HOME: home };
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly; the OS reclaims temp directories.
  }
});

function seed(count: number, titlePrefix = 'Commit'): void {
  const { db } = openDatabase({ path: resolvePaths(env).database });
  try {
    const store = new EvidenceStore(db, nodePlatform);
    for (let n = 0; n < count; n++) {
      store.emit({
        collectorId: 'git',
        sourceUri: `git://repo/commit/${n}`,
        kind: 'git.commit',
        evidenceClass: 'imported',
        sensitivity: 'confidential',
        occurredAt: toInstant(`2026-0${(n % 9) + 1}-15T12:00:00.000Z`),
        occurredEnd: null,
        context: { projectKey: 'careerforge', workspace: null, stream: 'main' },
        title: `${titlePrefix} ${n}`,
        summary: null,
        excerpt: null,
        payloadRef: null,
        attributes: {},
        groupingHint: null,
        collectorVersion: '1.0.0',
        sourceFormatVersion: null,
      });
    }
  } finally {
    closeDatabase(db);
  }
}

describe('help and discoverability', () => {
  it('lists every command in usage', () => {
    const usage = run(['--help'], env).stdout;
    for (const name of COMMAND_NAMES) {
      expect(usage, `${name} is missing from usage`).toContain(name);
    }
  });

  it('gives every command its own help with an example', () => {
    for (const name of COMMAND_NAMES) {
      const help = run([name, '--help'], env).stdout;
      expect(help, `${name} help`).toContain('Usage:');
      expect(help, `${name} example`).toContain('Example:');
    }
  });

  it('never surfaces a raw stack trace', () => {
    const result = run(['rebuild', '--from', join(home, 'nowhere')], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('    at ');
  });
});

describe('init', () => {
  it('creates the store', () => {
    const result = run(['init'], env);
    expect(result.exitCode).toBe(0);
    expect(existsSync(resolvePaths(env).database)).toBe(true);
  });

  it('is safe to run twice', () => {
    run(['init'], env);
    const second = run(['init'], env);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('already present');
  });
});

describe('commands refuse to work on a store that does not exist', () => {
  it.each(['export', 'search', 'timeline', 'reindex'])('%s explains what to do first', (name) => {
    const result = run(name === 'search' ? [name, 'anything'] : [name], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('careerforge init');
  });

  it('creates nothing as a side effect', () => {
    run(['timeline'], env);
    expect(existsSync(resolvePaths(env).database)).toBe(false);
  });
});

describe('timeline', () => {
  beforeEach(() => {
    run(['init'], env);
    seed(6);
  });

  it('groups by month', () => {
    const output = run(['timeline'], env).stdout;
    expect(output).toContain('2026-01');
    expect(output).toContain('record(s)');
  });

  it('filters by a plain date', () => {
    const output = run(['timeline', '--from', '2026-04-01'], env).stdout;
    expect(output).not.toContain('2026-01');
    expect(output).toContain('2026-04');
  });

  it('accepts a closing bound that includes the whole day', () => {
    const output = run(['timeline', '--from', '2026-03-15', '--to', '2026-03-15'], env).stdout;
    expect(output).toContain('2026-03');
  });

  it('explains a malformed date rather than failing obscurely', () => {
    const result = run(['timeline', '--from', 'last tuesday'], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('YYYY-MM-DD');
  });

  it('says so plainly when a window is empty', () => {
    expect(run(['timeline', '--from', '2030-01-01'], env).stdout).toContain('No evidence');
  });
});

describe('search', () => {
  beforeEach(() => {
    run(['init'], env);
    seed(4, 'Findable');
  });

  it('finds evidence with no API key and no network', () => {
    expect(run(['search', 'Findable'], env).stdout).toContain('match(es)');
  });

  it('reports no matches without failing', () => {
    const result = run(['search', 'nonexistentterm'], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No evidence matches');
  });

  it('needs something to search for', () => {
    const result = run(['search'], env);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('needs something');
  });

  it('accepts a multi-word query', () => {
    expect(run(['search', 'Findable', '1'], env).exitCode).toBe(0);
  });
});

describe('export and rebuild', () => {
  beforeEach(() => {
    run(['init'], env);
    seed(10);
  });

  it('exports to the default location', () => {
    const result = run(['export'], env);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(resolvePaths(env).exportDir, 'manifest.json'))).toBe(true);
  });

  it('reports doing nothing when nothing changed', () => {
    run(['export'], env);
    expect(run(['export'], env).stdout).toContain('Nothing changed');
  });

  it('honours an explicit destination', () => {
    const target = join(home, 'elsewhere');
    run(['export', '--out', target], env);
    expect(existsSync(join(target, 'manifest.json'))).toBe(true);
  });

  it('refuses to rebuild over an existing store, and says why', () => {
    run(['export'], env);
    const result = run(['rebuild'], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already holds');
  });

  it('recovers a lost database from the export alone', () => {
    // The scenario the whole design exists for: the machine is gone, and all
    // that survived is a directory of JSON on a sync provider.
    run(['export'], env);
    const paths = resolvePaths(env);
    rmSync(paths.database, { force: true });
    rmSync(`${paths.database}-wal`, { force: true });
    rmSync(`${paths.database}-shm`, { force: true });

    const rebuilt = run(['rebuild'], env);
    expect(rebuilt.exitCode).toBe(0);
    expect(rebuilt.stdout).toContain('Rebuilt');

    const timelineOutput = run(['timeline'], env).stdout;
    expect(timelineOutput).toContain('10 record(s)');
  });
});

describe('reindex', () => {
  it('rebuilds the search index', () => {
    run(['init'], env);
    seed(3);
    const result = run(['reindex'], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Reindexed 3');
  });
});
