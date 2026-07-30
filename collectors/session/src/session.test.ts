import { createWriteStream } from 'node:fs';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CursorStore,
  EvidenceStore,
  IN_MEMORY,
  closeDatabase,
  deterministicPlatform,
  exportStore,
  openDatabase,
} from '@careerforge/store';
import { describeConformance, runCollection, type CollectorEvent } from '@careerforge/collect';

import { SessionCollector, sessionScopeFor } from './index.js';
import {
  gitVerbs,
  isNewerVersion,
  messageText,
  relativiseToWorkspace,
  stripInjectedEnvelopes,
} from './claude-code.js';
import { readJsonLines } from './lines.js';

/**
 * The session collector, and the fixture corpus that defines its semantics.
 *
 * The corpus is the point. This source changed format 14 times in the 30 days
 * that were measured, so the parser will be wrong about it repeatedly. Every
 * case under `fixtures/cases/` is one shape that must keep working, and the
 * expected output is committed so that a refactor which changes what someone's
 * career history says is a reviewable diff rather than a surprise.
 *
 * See `fixtures/README.md` for the workflow: fixture first, then failing test,
 * then parser.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = join(HERE, '..', 'fixtures', 'cases');

/** Cases that produce evidence, used wherever a working scope is needed. */
const EMITTING = [
  'typical-session',
  'minimal-session',
  'string-content',
  'tool-results-are-not-prompts',
  'injected-envelopes',
  'unknown-record-types',
  'unknown-fields',
  'unknown-content-blocks',
  'future-version',
  'legacy-version',
  'truncated-final-line',
  'invalid-json-midfile',
  'blank-lines',
  'paths-outside-workspace',
  'session-id-mismatch',
  'crlf-line-endings',
  'compact-summary-is-not-a-prompt',
  'programmatic-session',
];

let temp: string;
/** Several fixtures in one directory: what a real project scope looks like. */
let project: string;

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'cf-session-'));
  project = join(temp, 'project');
  mkdirSync(project, { recursive: true });
  for (const name of EMITTING) {
    const dir = join(CASES, name);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      copyFileSync(join(dir, file), join(project, file));
    }
  }
});

afterAll(() => {
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly.
  }
});

async function drain(path: string, cursor: string | null = null): Promise<CollectorEvent[]> {
  const events: CollectorEvent[] = [];
  for await (const event of new SessionCollector().collect(sessionScopeFor(path), cursor)) {
    events.push(event);
  }
  return events;
}

type Observed = {
  drafts: unknown[];
  skipped: string[];
  drift: string[];
};

async function observed(path: string): Promise<Observed> {
  const events = await drain(path);
  return {
    drafts: events.filter((e) => e.kind === 'evidence').map((e) => e.draft),
    skipped: events.filter((e) => e.kind === 'skipped').map((e) => e.reason),
    drift: events.filter((e) => e.kind === 'drift').map((e) => e.signal),
  };
}

const caseNames = readdirSync(CASES)
  .filter((name) => statSync(join(CASES, name)).isDirectory())
  .sort();

describe('the fixture corpus', () => {
  it('found cases to run', () => {
    // Guards the guard: a broken path here would make every case below pass
    // by iterating nothing.
    expect(caseNames.length).toBeGreaterThan(15);
  });

  it.each(caseNames)('%s emits exactly what is recorded', async (name) => {
    const dir = join(CASES, name);
    const golden = join(dir, 'expected.json');
    const actual = await observed(dir);

    if (!existsSync(golden)) {
      writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
      throw new Error(
        `No expected.json for "${name}", so one was written from the current behaviour.\n` +
          'Read it before committing it: it is a claim about what someone did at work.\n' +
          'A golden file accepted without review records the bug rather than testing the behaviour.',
      );
    }

    expect(
      actual,
      `Collection semantics changed for "${name}". If that was intentional, review the diff and update expected.json.`,
    ).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
  });
});

describe('what gets extracted', () => {
  it('takes the title and excerpt from what the person actually typed', async () => {
    const [draft] = (await observed(join(CASES, 'typical-session'))).drafts as any[];
    expect(draft.title).toBe(
      'The invoice export drops line items when an order has more than fifty of them.',
    );
    expect(draft.excerpt).toContain('There is a customer waiting on the September run.');
  });

  it('does not import the model-written title, even though the source recorded it', async () => {
    // The fixture contains an `ai-title` record reading "Fixing invoice export
    // pagination", which would make a tidier title than the raw prompt. It is
    // model prose, and Evidence asserts fact (ADR-0017).
    const [draft] = (await observed(join(CASES, 'typical-session'))).drafts as any[];
    expect(JSON.stringify(draft)).not.toContain('Fixing invoice export pagination');
  });

  it('records tools, file types, and git verbs', async () => {
    const [draft] = (await observed(join(CASES, 'typical-session'))).drafts as any[];
    expect(draft.attributes.tools).toEqual(['Bash', 'Edit', 'Read', 'Write']);
    expect(draft.attributes.fileExtensions).toEqual(['ts']);
    expect(draft.attributes.gitOperations).toEqual(['add', 'commit', 'push']);
    expect(draft.attributes.skills).toEqual(['systematic-debugging']);
    expect(draft.attributes.plugins).toEqual(['superpowers']);
  });

  it('records file paths relative to the workspace, never absolutely', async () => {
    const [draft] = (await observed(join(CASES, 'typical-session'))).drafts as any[];
    expect(draft.attributes.workspacePaths).toEqual([
      'src/export/invoices.ts',
      'tests/export/invoices.test.ts',
    ]);
    for (const path of draft.attributes.workspacePaths) {
      expect(path.startsWith('/'), 'absolute paths must not reach a hashed attribute').toBe(false);
    }
  });

  it('counts files outside the workspace without naming them', async () => {
    const [draft] = (await observed(join(CASES, 'paths-outside-workspace'))).drafts as any[];
    expect(draft.attributes.pathsOutsideWorkspace).toBe(2);
    expect(JSON.stringify(draft)).not.toContain('/etc/hosts');
    expect(JSON.stringify(draft)).not.toContain('platform-shared');
  });

  it('never records shell command arguments', async () => {
    // `git remote add origin https://token@host/repo` is a routine command and
    // a credential. The verb is the evidence; the rest is a liability.
    const [draft] = (await observed(join(CASES, 'typical-session'))).drafts as any[];
    const serialised = JSON.stringify(draft);
    expect(serialised).not.toContain('npm test');
    expect(serialised).not.toContain('git push origin');
    expect(serialised).not.toContain('-m "Fix invoice pagination"');
    // The branch itself is legitimate context — it is where the work happened,
    // not an argument someone typed.
    expect(draft.context.stream).toBe('feature/invoice-export');
  });

  it('spans the session from first record to last', async () => {
    const [draft] = (await observed(join(CASES, 'typical-session'))).drafts as any[];
    expect(draft.occurredAt).toBe('2026-07-01T09:00:00.000Z');
    expect(draft.occurredEnd).toBe('2026-07-01T09:41:00.000Z');
    expect(draft.attributes.durationMinutes).toBe(41);
  });

  it('classifies every session as restricted', async () => {
    for (const draft of (await observed(project)).drafts as any[]) {
      expect(draft.sensitivity).toBe('restricted');
      expect(draft.evidenceClass).toBe('imported');
    }
  });

  it('keys evidence on the session, not on where the file sits', async () => {
    const original = (await observed(join(CASES, 'minimal-session'))).drafts as any[];
    const elsewhere = join(temp, 'moved');
    mkdirSync(elsewhere, { recursive: true });
    const name = readdirSync(join(CASES, 'minimal-session')).find((f) => f.endsWith('.jsonl'))!;
    copyFileSync(join(CASES, 'minimal-session', name), join(elsewhere, name));

    const moved = (await observed(elsewhere)).drafts as any[];
    expect(moved.map((d) => d.sourceUri)).toEqual(original.map((d) => d.sourceUri));
    // The stronger claim: identical *state*, so the two never supersede each
    // other. This is the bug the Git collector shipped with in M4.
    expect(moved.map((d) => d.attributes)).toEqual(original.map((d) => d.attributes));
  });

  it('takes the session id from the file name when records disagree', async () => {
    const result = await observed(join(CASES, 'session-id-mismatch'));
    const [draft] = result.drafts as any[];
    expect(draft.attributes.sessionId).toBe('1e4a2c00-0000-4000-8000-000000000018');
    expect(result.drift).toContain('session id in records differs from the file name');
  });

  it('hints at grouping without deciding it', async () => {
    for (const draft of (await observed(project)).drafts as any[]) {
      expect(draft.groupingHint).toMatch(/^.+:.+:\d{4}-W\d{2}$/);
    }
  });

  it('records the source format version as provenance', async () => {
    const [typical] = (await observed(join(CASES, 'typical-session'))).drafts as any[];
    // The newest version in the file, not the first — a session that spans a
    // release carries both.
    expect(typical.sourceFormatVersion).toBe('2.1.220');

    const [future] = (await observed(join(CASES, 'future-version'))).drafts as any[];
    expect(future.sourceFormatVersion).toBe('9.9.9-alpha.1');
  });
});

describe('what must never be treated as a prompt', () => {
  it('ignores tool output wrapped in a user record', async () => {
    const [draft] = (await observed(join(CASES, 'tool-results-are-not-prompts'))).drafts as any[];
    expect(draft.title).toBe('Document the deployment runbook for the billing service.');
    expect(draft.excerpt).not.toContain('rewrite the authentication module');
    // Meta records are not prompts either.
    expect(draft.excerpt).not.toContain('Session resumed');
    expect(draft.attributes.userPrompts).toBe(1);
  });

  it('strips harness-injected envelopes but keeps the prompt beside them', async () => {
    const [draft] = (await observed(join(CASES, 'injected-envelopes'))).drafts as any[];
    expect(draft.title).toBe('Split the reporting module into read and write paths.');
    expect(draft.excerpt).not.toContain('system-reminder');
    expect(draft.attributes.userPrompts).toBe(2);
  });

  it('ignores the model-written summary a resumed session opens with', async () => {
    // Found by running against a real corpus, not by imagining a case. A
    // resumed session's first record is a `user` record containing a model's
    // summary of the previous conversation, marked only by `isCompactSummary`.
    // Read as a prompt it becomes the title of the Evidence — and over 90% of
    // transcripts are resumes or forks.
    const [draft] = (await observed(join(CASES, 'compact-summary-is-not-a-prompt')))
      .drafts as any[];
    expect(draft.title).toBe('Continue where we left off: add the cache invalidation hook.');
    expect(draft.excerpt).not.toContain('This session is being continued');
    expect(draft.attributes.userPrompts).toBe(1);
  });

  it('does not quote a program and present it as a problem statement', async () => {
    // 93% of the measured corpus was driven by an automation harness rather
    // than typed. Those sessions did real work — files, tools, commits — so
    // they are collected. What they do not have is a human problem statement,
    // and the title says so instead of quoting the machine. See ADR-0017.
    const [draft] = (await observed(join(CASES, 'programmatic-session'))).drafts as any[];
    expect(draft.title).toBe('Programmatic session in acme-api');
    expect(draft.excerpt).toBeNull();
    expect(draft.attributes.promptAuthorship).toBe('programmatic');
    expect(draft.attributes.humanPrompts).toBe(0);
    expect(draft.attributes.programmaticPrompts).toBe(1);
    // The work itself is still on record.
    expect(draft.attributes.workspacePaths).toEqual(['migrations/004_add_index.sql']);
  });

  it('marks a typed session as human-authored', async () => {
    const [draft] = (await observed(join(CASES, 'typical-session'))).drafts as any[];
    expect(draft.attributes.promptAuthorship).toBe('human');
  });

  it('strips only balanced envelopes, leaving ordinary angle brackets alone', () => {
    expect(stripInjectedEnvelopes('<system-reminder>noise</system-reminder>real')).toBe('real');
    expect(stripInjectedEnvelopes('use Array<string> here')).toBe('use Array<string> here');
    expect(stripInjectedEnvelopes('<system-reminder>unclosed')).toBe('<system-reminder>unclosed');
  });
});

describe('tolerance', () => {
  it('reads a transcript that is still being written', async () => {
    const result = await observed(join(CASES, 'truncated-final-line'));
    expect(result.drafts).toHaveLength(1);
    expect(result.drift).toContain('lines that were not valid JSON');
  });

  it('skips one unreadable line without losing the rest', async () => {
    const [draft] = (await observed(join(CASES, 'invalid-json-midfile'))).drafts as any[];
    expect(draft.attributes.recordCount).toBe(2);
  });

  it('handles blank lines, an empty file, and a directory with nothing in it', async () => {
    expect((await observed(join(CASES, 'blank-lines'))).drafts).toHaveLength(1);
    expect((await observed(join(CASES, 'empty-file'))).drafts).toHaveLength(0);

    const bare = join(temp, 'bare');
    mkdirSync(bare, { recursive: true });
    const events = await drain(bare);
    expect(events.filter((e) => e.kind === 'skipped')).toHaveLength(1);
  });

  it('reports a path that does not exist rather than throwing', async () => {
    await expect(drain(join(temp, 'absent'))).resolves.toBeDefined();
  });

  it('says plainly when nothing was asked', async () => {
    const result = await observed(join(CASES, 'no-human-prompt'));
    expect(result.drafts).toHaveLength(0);
    expect(result.skipped).toEqual(['no prompt in transcript']);
  });

  it('says plainly when nothing can be placed on a timeline', async () => {
    expect((await observed(join(CASES, 'no-timestamps'))).skipped).toEqual([
      'no usable timestamp in transcript',
    ]);
  });

  it('accepts versions from before and after this collector was written', async () => {
    expect((await observed(join(CASES, 'legacy-version'))).drafts).toHaveLength(1);
    expect((await observed(join(CASES, 'future-version'))).drafts).toHaveLength(1);
  });

  it('parses CRLF transcripts identically to LF ones', async () => {
    const [draft] = (await observed(join(CASES, 'crlf-line-endings'))).drafts as any[];
    expect(draft.attributes.recordCount).toBe(2);
    expect(draft.title).toBe('Port the build script to PowerShell for the Windows agents.');
  });
});

describe('drift — tolerance that says what it tolerated', () => {
  it('reports unrecognised record types and still collects the session', async () => {
    const result = await observed(join(CASES, 'unknown-record-types'));
    expect(result.drafts).toHaveLength(1);
    expect(result.drift).toEqual(
      expect.arrayContaining([
        'unrecognised record type: telemetry-sample',
        'unrecognised record type: sandbox-event',
        'unrecognised record type: agent-handoff',
      ]),
    );
  });

  it('recognises a record type that appeared after the format survey', async () => {
    // `custom-title` did not exist when the findings were written. It does
    // now, which is the whole argument for this milestone's posture.
    const result = await observed(join(CASES, 'unknown-record-types'));
    expect(result.drift).not.toContain('unrecognised record type: custom-title');
  });

  it('reports unrecognised fields on the record types it extracts from', async () => {
    const result = await observed(join(CASES, 'unknown-fields'));
    expect(result.drafts).toHaveLength(1);
    expect(result.drift).toEqual(
      expect.arrayContaining([
        'unrecognised field on user: nudgeReason',
        'unrecognised field on assistant: costUsd',
      ]),
    );
  });

  it('reports unrecognised content blocks and keeps parsing the rest', async () => {
    const result = await observed(join(CASES, 'unknown-content-blocks'));
    expect(result.drift).toContain('unrecognised content block: code_execution_result');
    const [draft] = result.drafts as any[];
    expect(draft.attributes.tools).toEqual(['Read']);
  });

  it('counts drift once per transcript, not once per record', async () => {
    // Counting occurrences would make a field present on every line report
    // thousands of times and drown out a rare signal that matters more.
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const platform = deterministicPlatform();
      const report = await runCollection({
        collector: new SessionCollector(),
        scope: sessionScopeFor(project),
        store: new EvidenceStore(db, platform),
        cursors: new CursorStore(db, platform),
        backfill: true,
      });
      expect(report.drift['unrecognised field on user: nudgeReason']).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('does not count drift as work seen', async () => {
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const platform = deterministicPlatform();
      const report = await runCollection({
        collector: new SessionCollector(),
        scope: sessionScopeFor(join(CASES, 'unknown-record-types')),
        store: new EvidenceStore(db, platform),
        cursors: new CursorStore(db, platform),
        backfill: true,
      });
      // One transcript examined, whatever was noticed inside it (ADR-0016).
      expect(report.seen).toBe(1);
      expect(Object.keys(report.drift).length).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('privacy', () => {
  it('never writes transcript bytes into the store or the export', async () => {
    // The concrete version of "excerpt, never bulk-ship". A transcript
    // routinely contains pasted credentials; this asserts they cannot survive
    // collection even when they sit in tool output and command arguments.
    const secret = 'AKIAZZZ-EXAMPLE-CREDENTIAL-9f3b21';
    const sessionId = '1e4a2c00-0000-4000-8000-0000000000ff';
    const dir = join(temp, 'secrets');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          sessionId,
          cwd: '/home/dev/acme-api',
          timestamp: '2026-07-20T09:00:00.000Z',
          version: '2.1.220',
          message: { role: 'user', content: [{ type: 'text', text: 'Deploy the staging stack.' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          cwd: '/home/dev/acme-api',
          timestamp: '2026-07-20T09:01:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Bash',
                input: { command: `aws configure set aws_access_key_id ${secret}` },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: '2026-07-20T09:01:02.000Z',
          toolUseResult: { stdout: `credential ${secret} stored` },
          message: { role: 'user', content: `credential ${secret} stored` },
        }),
      ].join('\n'),
      'utf8',
    );

    const databasePath = join(temp, 'secrets.db');
    const exportDir = join(temp, 'secrets-export');
    const { db } = openDatabase({ path: databasePath });
    try {
      const platform = deterministicPlatform();
      const report = await runCollection({
        collector: new SessionCollector(),
        scope: sessionScopeFor(dir),
        store: new EvidenceStore(db, platform),
        cursors: new CursorStore(db, platform),
        backfill: true,
      });
      expect(report.emitted).toBe(1);
      exportStore(db, exportDir);
    } finally {
      closeDatabase(db);
    }

    expect(readFileSync(databasePath).includes(secret)).toBe(false);
    for (const file of readdirSync(exportDir, { recursive: true }) as string[]) {
      const full = join(exportDir, file);
      if (!statSync(full).isFile()) continue;
      expect(readFileSync(full, 'utf8'), `${file} leaked a credential`).not.toContain(secret);
    }
  });

  it('bounds the excerpt however long the prompt was', async () => {
    const sessionId = '1e4a2c00-0000-4000-8000-0000000000fe';
    const dir = join(temp, 'long-prompt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: '/home/dev/acme-api',
        timestamp: '2026-07-21T09:00:00.000Z',
        message: { role: 'user', content: `Rewrite this. ${'x'.repeat(50_000)}` },
      }),
      'utf8',
    );

    const [draft] = (await observed(dir)).drafts as any[];
    expect(draft.excerpt.length).toBeLessThanOrEqual(2_001);
    expect(draft.title.length).toBeLessThanOrEqual(121);
  });

  it('hashes what it read, so provenance outlives the source', async () => {
    // Claude Code deletes transcripts after 30 days by default. The hash is
    // what remains once the file the evidence points at no longer exists.
    const [draft] = (await observed(join(CASES, 'minimal-session'))).drafts as any[];
    expect(draft.attributes.transcriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.payloadRef).toBeNull();
  });
});

describe('streaming', () => {
  it('skips a line too long to hold and keeps reading the rest', async () => {
    const path = join(temp, 'overlong.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'user', a: 1 }),
        `{"type":"user","junk":"${'x'.repeat(200_000)}"}`,
        JSON.stringify({ type: 'user', a: 2 }),
      ].join('\n'),
      'utf8',
    );

    const lines = [];
    for await (const line of readJsonLines(path, { maxLineBytes: 4_096 })) lines.push(line);

    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ ok: false, reason: 'line too long' });
    expect(lines[2]).toMatchObject({ ok: true });
  });

  it('reads a 32 MB transcript without holding it', async () => {
    // The largest file in the measured corpus is 32 MB. `readFileSync` would
    // pass every test written against a small fixture and fail on the machine
    // of the user with the most career history to lose.
    const sessionId = '1e4a2c00-0000-4000-8000-0000000000fd';
    const dir = join(temp, 'large');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);

    const filler = 'y'.repeat(4_000);
    const stream = createWriteStream(path);
    await new Promise<void>((done, fail) => {
      stream.on('error', fail);
      stream.write(
        `${JSON.stringify({
          type: 'user',
          sessionId,
          cwd: '/home/dev/acme-api',
          timestamp: '2026-07-22T09:00:00.000Z',
          message: { role: 'user', content: 'Migrate the reporting warehouse.' },
        })}\n`,
      );
      for (let n = 0; n < 8_000; n++) {
        stream.write(
          `${JSON.stringify({
            type: 'assistant',
            sessionId,
            timestamp: '2026-07-22T09:00:01.000Z',
            message: {
              role: 'assistant',
              model: 'claude-opus-5',
              content: [{ type: 'text', text: filler }],
            },
          })}\n`,
        );
      }
      stream.end(() => {
        done();
      });
    });

    const bytes = statSync(path).size;
    expect(bytes).toBeGreaterThan(32 * 1024 * 1024);

    const baseline = process.memoryUsage().heapUsed;
    let peak = 0;
    let count = 0;
    for await (const line of readJsonLines(path)) {
      if (line.ok) count++;
      if (count % 500 === 0) {
        peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
      }
    }

    expect(count).toBe(8_001);
    // An empirical guard rather than a proof. Reading the file whole would
    // hold the buffer and the decoded string at once — several times this.
    expect(peak).toBeLessThan(bytes);

    const [draft] = (await observed(dir)).drafts as any[];
    expect(draft.attributes.recordCount).toBe(8_001);
    expect(draft.attributes.transcriptBytes).toBe(bytes);
  });
});

describe('parsing helpers', () => {
  it('reads message content in both shapes the source uses', () => {
    expect(messageText({ content: 'plain' })).toBe('plain');
    expect(
      messageText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a\nb');
    // The model's reasoning and a tool's output are not the person's words.
    expect(messageText({ content: [{ type: 'thinking', thinking: 'hmm' }] })).toBe('');
    expect(messageText({ content: [{ type: 'tool_result', content: 'out' }] })).toBe('');
    expect(messageText(null)).toBe('');
    expect(messageText({ content: 42 })).toBe('');
  });

  it('compares versions numerically, not as strings', () => {
    expect(isNewerVersion('2.1.10', '2.1.9')).toBe(true);
    expect(isNewerVersion('2.1.9', '2.1.10')).toBe(false);
    expect(isNewerVersion('2.1.198', null)).toBe(true);
    expect(isNewerVersion('nonsense', '2.1.198')).toBe(false);
  });

  it('takes git verbs and discards arguments', () => {
    expect(gitVerbs('git commit -m "x"')).toEqual(['commit']);
    expect(gitVerbs('npm test && git add -A && git push origin main')).toEqual(['add', 'push']);
    expect(gitVerbs('git -C /repo status')).toEqual(['status']);
    expect(gitVerbs('echo git-like-but-not')).toEqual([]);
    expect(gitVerbs('git remote add origin https://token@host/repo')).toEqual(['remote']);
  });

  it('relativises paths and counts what falls outside', () => {
    const result = relativiseToWorkspace(
      new Set(['/w/a.ts', '/w/nested/b.ts', '/elsewhere/c.ts', '/w']),
      '/w',
    );
    expect(result.inside).toEqual(['a.ts', 'nested/b.ts']);
    expect(result.outside).toBe(1);

    // Windows separators, same answer.
    expect(relativiseToWorkspace(new Set(['C:\\w\\a.ts']), 'C:\\w').inside).toEqual(['a.ts']);
    // No working directory means nothing can be proven relative.
    expect(relativiseToWorkspace(new Set(['/w/a.ts']), null)).toEqual({ inside: [], outside: 1 });
  });
});

describe('discovery and cursors', () => {
  it('discovers a project directory directly', async () => {
    const found = await new SessionCollector().discover(project);
    expect(found).toHaveLength(1);
    expect(found[0]!.scope.key).toContain('session:');
  });

  it('discovers every project under a root', async () => {
    // Every case, including the ones that emit nothing: an empty transcript is
    // still a transcript, and discovery does not get to decide what is worth
    // reading.
    const found = await new SessionCollector().discover(CASES);
    expect(found.length).toBe(caseNames.length);
  });

  it('returns nothing for a path that is not a directory', async () => {
    expect(await new SessionCollector().discover(join(temp, 'absent'))).toEqual([]);
  });

  it('collects nothing new when resumed from the newest transcript', async () => {
    const newest = Math.max(
      ...readdirSync(project).map((f) => Math.floor(statSync(join(project, f)).mtimeMs)),
    );
    const result = await observed(project);
    expect(result.drafts.length).toBeGreaterThan(0);

    const events = await drain(project, String(newest));
    expect(events.filter((e) => e.kind === 'evidence')).toHaveLength(0);
  });
});

describe('integration with the host', () => {
  it('collects a project full of transcripts into a real store', async () => {
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const platform = deterministicPlatform();
      const store = new EvidenceStore(db, platform);
      const report = await runCollection({
        collector: new SessionCollector(),
        scope: sessionScopeFor(project),
        store,
        cursors: new CursorStore(db, platform),
        backfill: true,
      });

      expect(report.emitted).toBe(EMITTING.length);
      expect(report.inserted).toBe(EMITTING.length);
      expect(report.skipped).toEqual({});
      expect(store.search('invoice').length).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });
});

describeConformance(
  {
    name: 'session',
    create: () => new SessionCollector(),
    scope: () => sessionScopeFor(project),
    malformedScopes: () => [
      {
        label: 'truncated transcript',
        scope: sessionScopeFor(join(CASES, 'truncated-final-line')),
      },
      {
        label: 'invalid JSON mid-file',
        scope: sessionScopeFor(join(CASES, 'invalid-json-midfile')),
      },
      { label: 'empty transcript', scope: sessionScopeFor(join(CASES, 'empty-file')) },
      { label: 'no prompt at all', scope: sessionScopeFor(join(CASES, 'no-human-prompt')) },
      { label: 'no timestamps', scope: sessionScopeFor(join(CASES, 'no-timestamps')) },
      { label: 'path that does not exist', scope: sessionScopeFor(join(temp, 'absent')) },
    ],
  },
  { describe, it },
);
