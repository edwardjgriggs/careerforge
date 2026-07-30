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

beforeEach(async () => {
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
  it('lists every command in usage', async () => {
    const usage = (await run(['--help'], env)).stdout;
    for (const name of COMMAND_NAMES) {
      expect(usage, `${name} is missing from usage`).toContain(name);
    }
  });

  it('gives every command its own help with an example', async () => {
    for (const name of COMMAND_NAMES) {
      const help = (await run([name, '--help'], env)).stdout;
      expect(help, `${name} help`).toContain('Usage:');
      expect(help, `${name} example`).toContain('Example:');
    }
  });

  it('never surfaces a raw stack trace', async () => {
    const result = await run(['rebuild', '--from', join(home, 'nowhere')], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('    at ');
  });
});

describe('init', () => {
  it('creates the store', async () => {
    const result = await run(['init'], env);
    expect(result.exitCode).toBe(0);
    expect(existsSync(resolvePaths(env).database)).toBe(true);
  });

  it('is safe to run twice', async () => {
    await run(['init'], env);
    const second = await run(['init'], env);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('already present');
  });
});

describe('commands refuse to work on a store that does not exist', () => {
  it.each(['export', 'search', 'timeline', 'reindex'])(
    '%s explains what to do first',
    async (name) => {
      const result = await run(name === 'search' ? [name, 'anything'] : [name], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('careerforge init');
    },
  );

  it('creates nothing as a side effect', async () => {
    await run(['timeline'], env);
    expect(existsSync(resolvePaths(env).database)).toBe(false);
  });
});

describe('timeline', () => {
  beforeEach(async () => {
    await run(['init'], env);
    seed(6);
  });

  it('groups by month', async () => {
    const output = (await run(['timeline'], env)).stdout;
    expect(output).toContain('2026-01');
    expect(output).toContain('record(s)');
  });

  it('filters by a plain date', async () => {
    const output = (await run(['timeline', '--from', '2026-04-01'], env)).stdout;
    expect(output).not.toContain('2026-01');
    expect(output).toContain('2026-04');
  });

  it('accepts a closing bound that includes the whole day', async () => {
    const output = (await run(['timeline', '--from', '2026-03-15', '--to', '2026-03-15'], env))
      .stdout;
    expect(output).toContain('2026-03');
  });

  it('explains a malformed date rather than failing obscurely', async () => {
    const result = await run(['timeline', '--from', 'last tuesday'], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('YYYY-MM-DD');
  });

  it('says so plainly when a window is empty', async () => {
    expect((await run(['timeline', '--from', '2030-01-01'], env)).stdout).toContain('No evidence');
  });
});

describe('search', () => {
  beforeEach(async () => {
    await run(['init'], env);
    seed(4, 'Findable');
  });

  it('finds evidence with no API key and no network', async () => {
    expect((await run(['search', 'Findable'], env)).stdout).toContain('match(es)');
  });

  it('reports no matches without failing', async () => {
    const result = await run(['search', 'nonexistentterm'], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No evidence matches');
  });

  it('needs something to search for', async () => {
    const result = await run(['search'], env);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('needs something');
  });

  it('accepts a multi-word query', async () => {
    expect((await run(['search', 'Findable', '1'], env)).exitCode).toBe(0);
  });
});

describe('export and rebuild', () => {
  beforeEach(async () => {
    await run(['init'], env);
    seed(10);
  });

  it('exports to the default location', async () => {
    const result = await run(['export'], env);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(resolvePaths(env).exportDir, 'manifest.json'))).toBe(true);
  });

  it('reports doing nothing when nothing changed', async () => {
    await run(['export'], env);
    expect((await run(['export'], env)).stdout).toContain('Nothing changed');
  });

  it('honours an explicit destination', async () => {
    const target = join(home, 'elsewhere');
    await run(['export', '--out', target], env);
    expect(existsSync(join(target, 'manifest.json'))).toBe(true);
  });

  it('refuses to rebuild over an existing store, and says why', async () => {
    await run(['export'], env);
    const result = await run(['rebuild'], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already holds');
  });

  it('recovers a lost database from the export alone', async () => {
    // The scenario the whole design exists for: the machine is gone, and all
    // that survived is a directory of JSON on a sync provider.
    await run(['export'], env);
    const paths = resolvePaths(env);
    rmSync(paths.database, { force: true });
    rmSync(`${paths.database}-wal`, { force: true });
    rmSync(`${paths.database}-shm`, { force: true });

    const rebuilt = await run(['rebuild'], env);
    expect(rebuilt.exitCode).toBe(0);
    expect(rebuilt.stdout).toContain('Rebuilt');

    const timelineOutput = (await run(['timeline'], env)).stdout;
    expect(timelineOutput).toContain('10 record(s)');
  });
});

describe('reindex', () => {
  it('rebuilds the search index', async () => {
    await run(['init'], env);
    seed(3);
    const result = await run(['reindex'], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Reindexed 3');
  });
});

describe('group and units', () => {
  beforeEach(async () => {
    await run(['init'], env);
    seed(6, 'Session');
  });

  it('refuses to group a store that does not exist', async () => {
    const empty = { CAREERFORGE_HOME: join(home, 'nowhere') };
    const result = await run(['group'], empty);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('careerforge init');
  });

  it('groups evidence into units', async () => {
    const result = await run(['group'], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('context-temporal@1');
    expect(result.stdout).toMatch(/work unit\(s\)/);
  });

  it('writes nothing on a dry run', async () => {
    const dry = await run(['group', '--dry-run'], env);
    expect(dry.stdout).toContain('nothing was written');
    expect((await run(['units'], env)).stdout).toContain('No work units yet');
  });

  it('is safe to run twice', async () => {
    await run(['group'], env);
    const before = (await run(['units'], env)).stdout;
    const second = await run(['group'], env);
    expect(second.exitCode).toBe(0);
    expect((await run(['units'], env)).stdout).toBe(before);
  });

  it('lists units, and says so plainly when there are none', async () => {
    expect((await run(['units'], env)).stdout).toContain('No work units yet');
    await run(['group'], env);
    const listed = (await run(['units'], env)).stdout;
    expect(listed).toContain('artifact(s)');
    expect(listed).toContain('work unit(s)');
  });

  it('filters by project', async () => {
    await run(['group'], env);
    expect((await run(['units', '--project', 'careerforge'], env)).stdout).toContain('artifact(s)');
    expect((await run(['units', '--project', 'nothing-here'], env)).stdout).toContain(
      'No work units yet',
    );
  });

  it('accepts threshold overrides, because thresholds are configuration', async () => {
    // The seeded evidence is commits, and a commit is completed work however
    // brief — so raising the time threshold must not discard any of it. That
    // the flag is honoured is visible in the run; that commits survive it is
    // the rule worth asserting.
    const strict = await run(['group', '--dry-run', '--min-active', '100000'], env);
    expect(strict.exitCode).toBe(0);
    expect(strict.stdout).not.toContain('0 substantial enough to keep');
    expect(strict.stdout).toContain('nothing was written');
  });
});
