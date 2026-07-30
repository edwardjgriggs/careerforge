import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRecordedProvider,
  executeRun,
  fingerprintOf,
  TEMPLATES,
  type Cassette,
  type EnrichmentInput,
  type RunRequest,
} from '@careerforge/enrich';
import type { ConsentLookup, Provider } from '@careerforge/policy';

import { ConsentStore } from './consent-store.js';
import { closeDatabase, openDatabase, IN_MEMORY } from './database.js';
import { EnrichmentStore } from './enrichment-store.js';
import { EvidenceStore } from './evidence-store.js';
import type { Db } from './migrations/index.js';
import { deterministicPlatform, sha256 } from './platform.js';

/**
 * Enrichment against a real store.
 *
 * The unit tests in `enrich` prove the pipeline. These prove the things only a
 * database can: that a cache hit is a cache hit across process boundaries,
 * that a corrected input makes an interpretation stale, that nothing here
 * writes a fact, and that a run recorded today is still reconstructible when
 * the code that produced it is gone.
 */

const platform = deterministicPlatform();
const openai: Provider = { id: 'openai', locality: 'remote' };

const granted: ConsentLookup = () => ({
  projectKey: 'acme',
  providerId: 'openai',
  maxSensitivity: 'restricted',
  revoked: false,
});

const INPUTS: EnrichmentInput[] = [
  {
    id: '01EV1',
    contentHash: 'h1',
    sensitivity: 'internal',
    projectKey: 'acme',
    text: 'Rewrote the JSONL reader to split on the newline byte',
  },
  {
    id: '01EV2',
    contentHash: 'h2',
    sensitivity: 'internal',
    projectKey: 'acme',
    text: 'Added a fixture for a 40MB transcript',
  },
];

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  target: { kind: 'work_unit', id: '01WU1' },
  enrichmentType: 'skills',
  provider: openai,
  model: 'gpt-test',
  inputs: INPUTS,
  ...overrides,
});

const ANSWER = {
  skills: [
    {
      name: 'bounded-memory stream parsing',
      category: 'engineering',
      rationale: 'split on the newline byte instead of buffering',
      evidence: ['01EV1'],
    },
    {
      name: 'fixture-driven regression testing',
      category: 'engineering',
      rationale: 'added a fixture before changing the parser',
      evidence: ['01EV2'],
    },
  ],
};

function cassetteFor(req: RunRequest, value: unknown, model = 'gpt-test-2026-02-01'): Cassette {
  const payload = req.inputs.map((item) => `[evidence ${item.id}]\n${item.text}`).join('\n\n');
  return {
    entries: [
      {
        name: 'skills',
        match: { schemaName: 'skills', model: req.model, payload },
        response: { value, model, usage: { inputTokens: 120, outputTokens: 45 } },
      },
    ],
  };
}

let db: Db;
let store: EnrichmentStore;

beforeEach(() => {
  const opened = openDatabase({ path: IN_MEMORY });
  db = opened.db;
  store = new EnrichmentStore(db, platform);
});

/** Run the real pipeline and persist the outcome, as the CLI does. */
async function runAndRecord(
  req: RunRequest,
  value: unknown = ANSWER,
  options: { model?: string; consent?: ConsentLookup } = {},
): Promise<string> {
  const provider = createRecordedProvider(cassetteFor(req, value, options.model));
  const outcome = await executeRun(req, {
    consent: options.consent ?? granted,
    digest: sha256,
    provider,
    lookupCached: (fingerprint) => store.findCached(fingerprint),
  });

  if (outcome.kind === 'cached') return outcome.cached.runId;
  if (outcome.kind !== 'completed') throw new Error(`unexpected outcome: ${outcome.kind}`);

  const decisionId = new ConsentStore(db, platform).recordDecision(outcome.decision);
  return store.recordRun({
    fingerprint: outcome.fingerprint,
    target: req.target,
    enrichmentType: req.enrichmentType,
    resolvedModel: outcome.response.model,
    policyDecisionId: decisionId,
    redactionProfile: outcome.decision.redaction.profile,
    status: 'completed',
    usage: outcome.usage,
    validated: outcome.validated,
    startedAt: '2026-07-30T12:00:00.000Z' as never,
  });
}

const currentHash = (ids: readonly string[]): string =>
  sha256(JSON.stringify(ids.map((id) => [id, INPUTS.find((i) => i.id === id)?.contentHash])));

describe('recording a run', () => {
  it('stores every dimension that decided the output', async () => {
    const runId = await runAndRecord(request());
    const run = store.runById(runId)!;

    expect(run.templateId).toBe('skills@1');
    expect(run.providerId).toBe('openai');
    expect(run.model).toBe('gpt-test');
    expect(run.resolvedModel).toBe('gpt-test-2026-02-01');
    expect(run.promptHash).toHaveLength(64);
    expect(run.paramsHash).toHaveLength(64);
    expect(run.inputHash).toHaveLength(64);
    expect(run.inputIds).toEqual(['01EV1', '01EV2']);
  });

  it('reconstructs a run from what was stored, without the code that made it', async () => {
    // The whole point of the record. A year from now the template resolves
    // from its frozen id and the hashes still say whether anything moved.
    const runId = await runAndRecord(request());
    const run = store.runById(runId)!;

    const template = TEMPLATES[run.templateId]!;
    const rebuilt = fingerprintOf({ ...request(), model: run.model }, template, sha256);
    expect(rebuilt.promptHash).toBe(run.promptHash);
    expect(rebuilt.paramsHash).toBe(run.paramsHash);
    expect(rebuilt.inputHash).toBe(run.inputHash);
  });

  it('links the decision that permitted it', async () => {
    const runId = await runAndRecord(request());
    const run = store.runById(runId)!;
    expect(run.policyDecisionId).not.toBeNull();

    const decision = db
      .prepare(`SELECT allowed, purpose FROM policy_decisions WHERE id = ?`)
      .get(run.policyDecisionId) as { allowed: number; purpose: string };
    expect(decision.allowed).toBe(1);
    expect(decision.purpose).toBe('enrich:skills');
  });

  it('records what it cost', async () => {
    await runAndRecord(request());
    expect(store.usage()).toEqual({ runs: 1, inputTokens: 120, outputTokens: 45 });
  });

  it('records each interpretation with the inputs it cited', async () => {
    await runAndRecord(request());
    const current = store.currentFor('01WU1', currentHash);

    expect(current).toHaveLength(2);
    expect(current[0]!.basis).toEqual(['01EV1']);
    expect(current[1]!.basis).toEqual(['01EV2']);
  });

  it('starts every interpretation unreviewed', async () => {
    // Unreviewed is the honest default. An AI output that arrives already
    // accepted is an authority, which is the thing this design refuses to be.
    await runAndRecord(request());
    expect(
      store.currentFor('01WU1', currentHash).every((e) => e.reviewState === 'unreviewed'),
    ).toBe(true);
  });
});

describe('the cache', () => {
  it('makes one call across ten runs, and the tenth is still answerable', async () => {
    const first = await runAndRecord(request());
    for (let attempt = 0; attempt < 9; attempt++) {
      expect(await runAndRecord(request())).toBe(first);
    }
    expect(store.usage().runs).toBe(1);
  });

  it('does not reuse a run made with a different model', async () => {
    await runAndRecord(request());
    await runAndRecord(request({ model: 'gpt-other' }));
    expect(store.usage().runs).toBe(2);
  });

  it('does not reuse a run made with a different prompt version', async () => {
    const runId = await runAndRecord(request());
    const run = store.runById(runId)!;
    // A cache keyed loosely enough to hit here would return an answer produced
    // by a different instrument and call it the same answer.
    expect(
      store.findCached({ ...run, promptHash: 'a-different-prompt', inputIds: run.inputIds }),
    ).toBeNull();
  });

  it('does not cache a failure into permanence', async () => {
    const fingerprint = fingerprintOf(request(), TEMPLATES['skills@1']!, sha256);
    store.recordRun({
      fingerprint,
      target: { kind: 'work_unit', id: '01WU1' },
      enrichmentType: 'skills',
      resolvedModel: null,
      policyDecisionId: null,
      redactionProfile: 'default@1',
      status: 'unusable',
      usage: { inputTokens: 0, outputTokens: 0 },
      validated: {
        items: [],
        rejections: [{ reason: 'malformed', summary: 'x' }],
        unknownCitations: [],
      },
      startedAt: '2026-07-30T12:00:00.000Z' as never,
    });

    expect(store.findCached(fingerprint)).toBeNull();
  });
});

describe('staleness', () => {
  it('flags an interpretation whose evidence has since been corrected', async () => {
    await runAndRecord(request());
    expect(store.currentFor('01WU1', currentHash).every((e) => e.stale)).toBe(false);

    // The correction. Nothing about the enrichment row changed; what changed
    // is the fact underneath it.
    const corrected = (ids: readonly string[]): string =>
      sha256(JSON.stringify(ids.map((id) => [id, id === '01EV1' ? 'h1-corrected' : 'h2'])));

    expect(store.currentFor('01WU1', corrected).every((e) => e.stale)).toBe(true);
  });

  it('computes staleness at read time rather than storing a flag', async () => {
    // A flag written at run time is wrong the moment somebody corrects a
    // record, and silently wrong is worse than absent: a résumé built from a
    // stale interpretation reads exactly like one built from a fresh one.
    const runId = await runAndRecord(request());
    const columns = db.prepare(`SELECT * FROM enrichment_runs WHERE id = ?`).get(runId) as Record<
      string,
      unknown
    >;
    expect(Object.keys(columns)).not.toContain('stale');
  });

  it('keeps the superseded interpretation queryable after a re-run', async () => {
    await runAndRecord(request());
    const before = store.currentFor('01WU1', currentHash);

    await runAndRecord(request({ model: 'gpt-newer' }), {
      skills: [{ ...ANSWER.skills[0]!, name: 'streaming parse' }],
    });

    const runs = store.runsFor('01WU1', 'skills');
    expect(runs).toHaveLength(2);
    // "How did this read before I switched models?" stays answerable.
    expect(before[0]!.value).toHaveProperty('name', 'bounded-memory stream parsing');
    expect(store.runById(runs[1]!.id)!.model).toBe('gpt-test');
  });
});

describe('review', () => {
  it('records a judgement without erasing what the model said', async () => {
    await runAndRecord(request());
    const [first] = store.currentFor('01WU1', currentHash);
    store.review(first!.id, 'rejected');

    const after = store.currentFor('01WU1', currentHash);
    const same = after.find((e) => JSON.stringify(e.value) === JSON.stringify(first!.value));
    expect(after).toHaveLength(2);
    expect(same?.reviewState).toBe('rejected');
    // The original row is still there to review against.
    const original = db
      .prepare(`SELECT review_state FROM enrichments WHERE id = ?`)
      .get(first!.id) as { review_state: string };
    expect(original.review_state).toBe('unreviewed');
  });
});

describe('enrichment writes interpretation and nothing else', () => {
  it('leaves the evidence table untouched', async () => {
    const evidence = new EvidenceStore(db, platform);
    evidence.emit({
      collectorId: 'git',
      sourceUri: 'git://repo/abc',
      kind: 'git.commit',
      evidenceClass: 'imported',
      sensitivity: 'internal',
      occurredAt: '2026-05-01T09:00:00.000Z' as never,
      occurredEnd: null,
      context: { projectKey: 'acme', workspace: null, stream: 'main' },
      title: 'a commit',
      summary: null,
      excerpt: null,
      payloadRef: null,
      attributes: {},
      groupingHint: null,
      collectorVersion: '1.0.0',
      sourceFormatVersion: null,
    });

    const before = db.prepare(`SELECT COUNT(*) AS n FROM evidence`).get() as { n: number };
    await runAndRecord(request());
    const after = db.prepare(`SELECT COUNT(*) AS n FROM evidence`).get() as { n: number };

    expect(after.n).toBe(before.n);
  });

  it('creates no support edge, only interpretation', async () => {
    // The rule the whole architecture exists to keep. An enrichment may
    // accompany a claim and explain it; it may never be the reason to believe
    // it (ADR-0020).
    await runAndRecord(request());
    const edges = db
      .prepare(`SELECT relation, COUNT(*) AS n FROM provenance_edges GROUP BY relation`)
      .all() as { relation: string; n: number }[];

    expect(edges.map((e) => e.relation)).toEqual(['interprets']);
  });

  it('points each interpretation at the target and at what it read', async () => {
    await runAndRecord(request());
    const targets = db
      .prepare(`SELECT DISTINCT to_kind FROM provenance_edges WHERE from_kind = 'enrichment'`)
      .all() as { to_kind: string }[];
    expect(targets.map((t) => t.to_kind).sort()).toEqual(['evidence', 'work_unit']);
  });

  it('writes a run and its results together or not at all', () => {
    // A run row without its enrichments would be cached as a success and
    // answer forever with nothing, so the graph edges are inside the same
    // transaction as the run rather than best-effort afterwards.
    const fingerprint = fingerprintOf(request(), TEMPLATES['skills@1']!, sha256);
    expect(() =>
      store.recordRun({
        fingerprint,
        // An id the provenance graph will refuse, which makes the edge write
        // fail after the run row has already been inserted.
        target: { kind: 'work_unit', id: '' },
        enrichmentType: 'skills',
        resolvedModel: null,
        policyDecisionId: null,
        redactionProfile: 'default@1',
        status: 'completed',
        usage: { inputTokens: 0, outputTokens: 0 },
        validated: {
          items: [{ value: { name: 'x' }, evidence: ['01EV1'] }],
          rejections: [],
          unknownCitations: [],
        },
        startedAt: '2026-07-30T12:00:00.000Z' as never,
      }),
    ).toThrow();

    expect((db.prepare(`SELECT COUNT(*) AS n FROM enrichment_runs`).get() as { n: number }).n).toBe(
      0,
    );
    expect((db.prepare(`SELECT COUNT(*) AS n FROM enrichments`).get() as { n: number }).n).toBe(0);
  });
});

describe('the audit trail survives the run', () => {
  it('keeps a decision for every call, refused or not', async () => {
    await runAndRecord(request());
    expect(new ConsentStore(db, platform).decisionCount()).toBe(1);
  });

  it('records the redaction profile that was applied', async () => {
    const runId = await runAndRecord(request());
    const row = db
      .prepare(`SELECT redaction_profile FROM enrichment_runs WHERE id = ?`)
      .get(runId) as { redaction_profile: string };
    expect(row.redaction_profile).toBe('default@1');
  });
});

afterEach(() => {
  closeDatabase(db);
});
