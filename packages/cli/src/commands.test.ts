import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toInstant } from '@careerforge/domain';
import {
  closeDatabase,
  ConsentStore,
  EvidenceStore,
  ProvenanceStore,
  QUESTION_TEMPLATES,
  WorkUnitStore,
  nodePlatform,
  openDatabase,
} from '@careerforge/store';

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

describe('explain and interview', () => {
  /** Seeds a store with a work unit, a claim, an interpretation, and a gap. */
  function seedProof(): { claimId: string; gapId: string; unitId: string } {
    const { db } = openDatabase({ path: resolvePaths(env).database });
    try {
      const store = new EvidenceStore(db, nodePlatform);
      const unitStore = new WorkUnitStore(db, nodePlatform);
      const provenance = new ProvenanceStore(db, nodePlatform);

      for (const n of [0, 1]) {
        store.emit({
          collectorId: 'git',
          sourceUri: `git://repo/commit/proof-${n}`,
          kind: 'git.commit',
          evidenceClass: 'imported',
          sensitivity: 'confidential',
          occurredAt: toInstant(`2026-05-04T${String(9 + n).padStart(2, '0')}:00:00.000Z`),
          occurredEnd: null,
          context: { projectKey: 'acme', workspace: null, stream: null },
          title: `Commit ${n}`,
          summary: null,
          excerpt: null,
          payloadRef: null,
          attributes: {},
          groupingHint: null,
          collectorVersion: '1.0.0',
          sourceFormatVersion: null,
        });
      }
      unitStore.group();
      const unitId = unitStore.currentUnits()[0]!.id;

      db.prepare(
        `INSERT INTO assets (id, asset_type, work_unit_id, content, review_state, recorded_at)
         VALUES ('a1','resume_bullet',?, 'Built the exporter.','draft','2026-05-04T09:00:00.000Z')`,
      ).run(unitId);
      const claim = provenance.recordClaim(
        { assetId: 'a1', text: 'Built the exporter.', span: [0, 19], claimType: 'action' },
        [{ kind: 'work_unit', id: unitId }],
      );

      db.prepare(
        `INSERT INTO enrichment_runs (id, provider_id, model, params_hash, prompt_template, prompt_hash, input_ids, input_hash, started_at)
         VALUES ('r1','openai','gpt-5','p','bullet@1','h','[]','ih','2026-05-04T09:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO enrichments (id, run_id, target_kind, target_id, enrichment_type, value, confidence, recorded_at)
         VALUES ('e1','r1','work_unit',?, 'impact','{}',0.8,'2026-05-04T09:00:00.000Z')`,
      ).run(unitId);
      provenance.attachInterpretation(claim.id, 'e1');

      const gapId = provenance.raiseGap({
        workUnitId: unitId,
        gapType: 'role',
        ...QUESTION_TEMPLATES['role']!('the exporter'),
      })!;

      return { claimId: claim.id, gapId, unitId };
    } finally {
      closeDatabase(db);
    }
  }

  beforeEach(async () => {
    await run(['init'], env);
  });

  it('refuses to explain without a claim id', async () => {
    const result = await run(['explain'], env);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('needs a claim id');
  });

  it('says plainly when a claim does not exist', async () => {
    const result = await run(['explain', 'nope'], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No claim');
  });

  it('shows grounds and interpretation in separate sections', async () => {
    const { claimId } = seedProof();
    const output = (await run(['explain', claimId], env)).stdout;

    expect(output).toContain('SUPPORTED');
    expect(output).toContain('[grouped   ]');
    expect(output).toContain('[observed  ]');

    // The AI reading appears, labelled, and below the grounds. A reader must
    // never have to work out which lines are evidence.
    const groundsAt = output.indexOf('[observed  ]');
    const interpretationAt = output.indexOf('Interpretation —');
    expect(interpretationAt).toBeGreaterThan(groundsAt);
    expect(output.slice(0, interpretationAt)).not.toContain('[AI reading]');
    expect(output).toContain('is not evidence');
  });

  it('offers the open questions about that work', async () => {
    const { claimId, gapId } = seedProof();
    const output = (await run(['explain', claimId], env)).stdout;
    expect(output).toContain('Open questions');
    expect(output).toContain(gapId);
  });

  it('lists pending questions with the reason for asking', async () => {
    seedProof();
    const output = (await run(['interview'], env)).stdout;
    expect(output).toContain('open question(s)');
    expect(output).toContain('What was your role');
    expect(output).toContain('why:');
  });

  it('says so plainly when there is nothing to ask', async () => {
    expect((await run(['interview'], env)).stdout).toContain('No open questions');
  });

  it('records an answer as evidence and closes the question', async () => {
    const { gapId } = seedProof();
    const answered = await run(['interview', '--gap', gapId, '--answer', 'I led it.'], env);
    expect(answered.exitCode).toBe(0);
    expect(answered.stdout).toContain('evidence you confirmed');

    expect((await run(['interview'], env)).stdout).toContain('No open questions');
  });

  it('never asks a declined question again', async () => {
    const { gapId } = seedProof();
    expect((await run(['interview', '--gap', gapId, '--decline'], env)).stdout).toContain(
      'not be asked again',
    );
    expect((await run(['interview'], env)).stdout).toContain('No open questions');
  });

  it('refuses an empty answer rather than recording one', async () => {
    const { gapId } = seedProof();
    const result = await run(['interview', '--gap', gapId, '--answer', '   '], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('needs text');
  });

  it('works with no API key and no network', async () => {
    // The interview is the path that must work for someone who never enables
    // AI at all. Questions come from templates and rules, never a provider.
    const { gapId } = seedProof();
    const bare = { CAREERFORGE_HOME: home };
    expect((await run(['interview'], bare)).stdout).toContain('What was your role');
    expect((await run(['interview', '--gap', gapId, '--answer', 'I led it.'], bare)).exitCode).toBe(
      0,
    );
  });
});

describe('consent and preview', () => {
  function seedUnit(sensitivity: 'confidential' | 'restricted', text = 'ordinary work'): string {
    const { db } = openDatabase({ path: resolvePaths(env).database });
    try {
      const store = new EvidenceStore(db, nodePlatform);
      const units = new WorkUnitStore(db, nodePlatform);
      for (const n of [0, 1]) {
        store.emit({
          collectorId: 'session',
          sourceUri: `session://policy-${sensitivity}-${n}`,
          kind: 'session.fragment',
          evidenceClass: 'imported',
          sensitivity,
          occurredAt: toInstant(`2026-05-04T${String(9 + n).padStart(2, '0')}:00:00.000Z`),
          occurredEnd: toInstant(`2026-05-04T${String(10 + n).padStart(2, '0')}:00:00.000Z`),
          context: { projectKey: 'acme', workspace: null, stream: 'feat/x' },
          title: `Work ${n}`,
          summary: null,
          excerpt: text,
          payloadRef: null,
          attributes: {},
          groupingHint: null,
          collectorVersion: '1.0.0',
          sourceFormatVersion: null,
        });
      }
      units.group();
      return units.currentUnits()[0]!.id;
    } finally {
      closeDatabase(db);
    }
  }

  beforeEach(async () => {
    await run(['init'], env);
  });

  it('permits nothing by default, and says there is no global switch', async () => {
    const output = (await run(['consent', 'list'], env)).stdout;
    expect(output).toContain('No provider may receive anything');
    expect(output).toContain('per');
  });

  it('grants, lists, and revokes per project', async () => {
    await run(['consent', 'grant', '--provider', 'openai', '--project', 'acme'], env);
    expect((await run(['consent', 'list'], env)).stdout).toContain('openai');
    expect((await run(['consent', 'list'], env)).stdout).toContain('acme');

    await run(['consent', 'revoke', '--provider', 'openai', '--project', 'acme'], env);
    expect((await run(['consent', 'list'], env)).stdout).toContain('REVOKED');
  });

  it('rejects an unknown sensitivity level rather than guessing', async () => {
    const result = await run(
      ['consent', 'grant', '--provider', 'openai', '--project', 'acme', '--level', 'sortof'],
      env,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown level');
  });

  it('rejects an unknown consent action', async () => {
    const result = await run(['consent', 'destroy'], env);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown consent action');
  });

  it('refuses egress with no grant, naming the rule and the exact command', async () => {
    const unitId = seedUnit('confidential');
    const output = (await run(['preview', '--unit', unitId, '--provider', 'openai'], env)).stdout;

    expect(output).toContain('REFUSED');
    expect(output).toContain('consent-required@1');
    expect(output).toContain('careerforge consent grant --provider openai --project acme');
  });

  it('refuses restricted work even after a confidential grant', async () => {
    const unitId = seedUnit('restricted');
    await run(
      ['consent', 'grant', '--provider', 'openai', '--project', 'acme', '--level', 'confidential'],
      env,
    );
    const output = (await run(['preview', '--unit', unitId, '--provider', 'openai'], env)).stdout;
    expect(output).toContain('restricted-default@1');
    expect(output).toContain('--level restricted');
  });

  it('needs no grant for a provider that runs on this machine', async () => {
    const unitId = seedUnit('restricted');
    const output = (await run(['preview', '--unit', unitId, '--provider', 'ollama'], env)).stdout;
    expect(output).toContain('ALLOWED');
  });

  it('treats an unknown provider as remote, never as local', async () => {
    // Guessing "local" for something we cannot identify would fail open, and
    // this is the one place where failing open is unacceptable.
    const unitId = seedUnit('confidential');
    const output = (await run(['preview', '--unit', unitId, '--provider', 'mystery'], env)).stdout;
    expect(output).toContain('(remote)');
    expect(output).toContain('REFUSED');
  });

  it('shows the payload even when refused, because that is how consent is decided', async () => {
    const unitId = seedUnit('restricted', 'the actual words that would be sent');
    const output = (await run(['preview', '--unit', unitId, '--provider', 'openai'], env)).stdout;
    expect(output).toContain('REFUSED');
    expect(output).toContain('the actual words that would be sent');
  });

  it('redacts credentials from what it shows', async () => {
    const unitId = seedUnit('confidential', 'rotated key AKIAQY7EXAMPLE4NPTZW today');
    const output = (await run(['preview', '--unit', unitId, '--provider', 'ollama'], env)).stdout;
    expect(output).not.toContain('AKIAQY7EXAMPLE4NPTZW');
    expect(output).toContain('aws-access-key-id');
  });

  it('states what redaction cannot catch rather than implying it caught everything', async () => {
    // Overstating redaction converts an informed user into a trusting one.
    const unitId = seedUnit('confidential');
    const output = (await run(['preview', '--unit', unitId, '--provider', 'ollama'], env)).stdout;
    expect(output).toContain('do not catch');
  });

  it('records a decision for every preview, permitted or not', async () => {
    const unitId = seedUnit('confidential');
    await run(['preview', '--unit', unitId, '--provider', 'openai'], env);
    await run(['preview', '--unit', unitId, '--provider', 'ollama'], env);

    const { db } = openDatabase({ path: resolvePaths(env).database });
    try {
      expect(new ConsentStore(db, nodePlatform).decisionCount()).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });

  it('needs both a unit and a provider', async () => {
    expect((await run(['preview', '--provider', 'openai'], env)).stderr).toContain('--unit');
    expect((await run(['preview', '--unit', 'x'], env)).stderr).toContain('--provider');
  });

  it('says plainly when the unit does not exist', async () => {
    const result = await run(['preview', '--unit', 'nope', '--provider', 'openai'], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No work unit');
  });
});

describe('enrich', () => {
  /** A work unit with two records, and the ids the payload will carry. */
  async function seedUnit(sensitivity: 'confidential' | 'restricted' = 'confidential'): Promise<{
    unitId: string;
    evidenceIds: string[];
  }> {
    await run(['init'], env);
    const { db } = openDatabase({ path: resolvePaths(env).database });
    try {
      const store = new EvidenceStore(db, nodePlatform);
      const units = new WorkUnitStore(db, nodePlatform);
      for (const n of [0, 1]) {
        store.emit({
          collectorId: 'session',
          sourceUri: `session://enrich-${n}`,
          kind: 'session.fragment',
          evidenceClass: 'imported',
          sensitivity,
          occurredAt: toInstant(`2026-05-04T${String(9 + n).padStart(2, '0')}:00:00.000Z`),
          occurredEnd: toInstant(`2026-05-04T${String(10 + n).padStart(2, '0')}:00:00.000Z`),
          context: { projectKey: 'acme', workspace: null, stream: 'feat/parser' },
          title: `Parser work ${n}`,
          summary: null,
          excerpt: `Rewrote the reader, pass ${n}`,
          payloadRef: null,
          attributes: {},
          groupingHint: null,
          collectorVersion: '1.0.0',
          sourceFormatVersion: null,
        });
      }
      units.group();
      const unit = units.currentUnits()[0]!;
      return { unitId: unit.id, evidenceIds: [...units.memberIds(unit.id)] };
    } finally {
      closeDatabase(db);
    }
  }

  /** A cassette answering the payload the engine will actually build. */
  function writeCassette(
    evidenceIds: string[],
    value: unknown,
    model = 'gpt-test-2026-02-01',
  ): string {
    const payload = evidenceIds
      .map((id, n) => `[evidence ${id}]\nParser work ${n}\nRewrote the reader, pass ${n}`)
      .join('\n\n');
    const path = join(home, 'cassette.json');
    writeFileSync(
      path,
      JSON.stringify({
        entries: [
          {
            name: 'skills',
            match: { schemaName: 'skills', model: 'gpt-5', payload },
            response: { value, model, usage: { inputTokens: 100, outputTokens: 40 } },
          },
        ],
      }),
    );
    return path;
  }

  const ANSWER = (ids: string[]) => ({
    skills: [
      {
        name: 'bounded-memory stream parsing',
        category: 'engineering',
        rationale: 'rewrote the reader without buffering',
        evidence: [ids[0]],
      },
    ],
  });

  it('refuses without a key, and says exactly what to set', async () => {
    const { unitId } = await seedUnit();
    await run(['consent', 'grant', '--provider', 'openai', '--project', 'acme'], env);

    const result = await run(['enrich', '--unit', unitId], env);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('provider-configured@1');
    expect(result.stdout).toContain('OPENAI_API_KEY');
    // The part that matters: the user is told the rest of the product is
    // unaffected, rather than being left to assume enrichment is the product.
    expect(result.stdout).toContain('works without one');
  });

  it('leaves every other command working with no key configured', async () => {
    // The acceptance criterion that keeps AI additive (ADR-0005). If a missing
    // key broke anything else, "AI is optional" would be a slogan.
    const { unitId } = await seedUnit();

    for (const argv of [
      ['doctor'],
      ['units'],
      ['timeline'],
      ['search', 'parser'],
      ['export'],
      ['consent', 'list'],
      ['preview', '--unit', unitId, '--provider', 'ollama'],
      ['interpretations', '--unit', unitId],
    ]) {
      const result = await run(argv, env);
      expect(result.exitCode, `${argv[0]} failed without a key`).toBe(0);
    }
  });

  it('refuses before it would need a key when consent is missing', async () => {
    // Ordering matters. Being told to set a key, setting one, and then being
    // told about consent would be two refusals for one attempt.
    const { unitId } = await seedUnit();
    const result = await run(['enrich', '--unit', unitId], env);
    expect(result.stdout).toContain('consent-required@1');
    expect(result.stdout).not.toContain('OPENAI_API_KEY');
  });

  it('shows the prompt and the payload on a dry run without needing a key', async () => {
    const { unitId } = await seedUnit();
    await run(['consent', 'grant', '--provider', 'openai', '--project', 'acme'], env);

    const result = await run(['enrich', '--unit', unitId, '--dry-run'], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('DRY RUN');
    expect(result.stdout).toContain('skills@1');
    expect(result.stdout).toContain('Rewrote the reader');
    expect(result.stdout).toContain('cite');
  });

  it('rejects an enrichment type with no published prompt', async () => {
    const { unitId } = await seedUnit();
    const result = await run(['enrich', '--unit', unitId, '--type', 'leadership'], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no published prompt');
    expect(result.stderr).toContain('skills');
  });

  it('records an interpretation and says what produced it', async () => {
    const { unitId, evidenceIds } = await seedUnit();
    await run(['consent', 'grant', '--provider', 'openai', '--project', 'acme'], env);
    const cassette = writeCassette(evidenceIds, ANSWER(evidenceIds));

    const result = await run(['enrich', '--unit', unitId], {
      ...env,
      CAREERFORGE_CASSETTE: cassette,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bounded-memory stream parsing');
    expect(result.stdout).toContain(`cites`);
    expect(result.stdout).toContain('skills@1');
    // Asked for one thing, answered by another. Recording only the request
    // would make the run record subtly untrue.
    expect(result.stdout).toContain('asked    gpt-5');
    expect(result.stdout).toContain('answered gpt-test-2026-02-01');
    expect(result.stdout).toContain('100 in, 40 out');
  });

  it('says plainly that an interpretation supports nothing', async () => {
    const { unitId, evidenceIds } = await seedUnit();
    await run(['consent', 'grant', '--provider', 'openai', '--project', 'acme'], env);
    const cassette = writeCassette(evidenceIds, ANSWER(evidenceIds));

    const result = await run(['enrich', '--unit', unitId], {
      ...env,
      CAREERFORGE_CASSETTE: cassette,
    });
    expect(result.stdout).toContain('never stands behind a claim');
  });

  it('labels a recorded answer as recorded', async () => {
    // Recorded output that looked like a live answer would be a lie in the
    // audit trail.
    const { unitId, evidenceIds } = await seedUnit();
    await run(['consent', 'grant', '--provider', 'openai', '--project', 'acme'], env);
    const cassette = writeCassette(evidenceIds, ANSWER(evidenceIds));

    const result = await run(['enrich', '--unit', unitId], {
      ...env,
      CAREERFORGE_CASSETTE: cassette,
    });
    expect(result.stdout).toContain('RECORDED');
  });

  it('reports what it discarded for citing something never sent', async () => {
    const { unitId, evidenceIds } = await seedUnit();
    await run(['consent', 'grant', '--provider', 'openai', '--project', 'acme'], env);
    const cassette = writeCassette(evidenceIds, {
      skills: [
        ...ANSWER(evidenceIds).skills,
        {
          name: 'Kubernetes autoscaling',
          category: 'operations',
          rationale: 'seems plausible',
          evidence: ['01NEVERSENT'],
        },
      ],
    });

    const result = await run(['enrich', '--unit', unitId], {
      ...env,
      CAREERFORGE_CASSETTE: cassette,
    });
    expect(result.stdout).toContain('Discarded 1 item');
    expect(result.stdout).toContain('fabricated_citation');
    expect(result.stdout).toContain('01NEVERSENT');
    expect(result.stdout).not.toContain('Kubernetes autoscaling\n    category');
  });

  it('answers a second identical run from the cache, without calling', async () => {
    const { unitId, evidenceIds } = await seedUnit();
    await run(['consent', 'grant', '--provider', 'openai', '--project', 'acme'], env);
    const cassette = writeCassette(evidenceIds, ANSWER(evidenceIds));
    const withCassette = { ...env, CAREERFORGE_CASSETTE: cassette };

    await run(['enrich', '--unit', unitId], withCassette);
    // No cassette this time and no key either. A cache hit that needed a
    // provider would not be a cache hit.
    const second = await run(['enrich', '--unit', unitId], env);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('No call was made and nothing was spent');
  });

  it('refuses restricted work even for enrichment, and records the attempt', async () => {
    const { unitId } = await seedUnit('restricted');
    await run(
      ['consent', 'grant', '--provider', 'openai', '--project', 'acme', '--level', 'confidential'],
      env,
    );

    const result = await run(['enrich', '--unit', unitId], env);
    expect(result.stdout).toContain('restricted-default@1');
    expect(result.stdout).toContain('nothing was sent');

    const { db } = openDatabase({ path: resolvePaths(env).database });
    try {
      expect(new ConsentStore(db, nodePlatform).decisionCount()).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('interpretations', () => {
  it('says nothing has been interpreted yet, and how to start', async () => {
    await run(['init'], env);
    seed(4);
    await run(['group'], env);
    const { db } = openDatabase({ path: resolvePaths(env).database });
    const unitId = new WorkUnitStore(db, nodePlatform).currentUnits()[0]!.id;
    closeDatabase(db);

    const result = await run(['interpretations', '--unit', unitId], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Nothing has been interpreted yet');
    expect(result.stdout).toContain('careerforge enrich --unit');
  });

  it('needs a unit', async () => {
    expect((await run(['interpretations'], env)).stderr).toContain('--unit');
  });
});
