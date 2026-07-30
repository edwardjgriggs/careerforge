import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Digest } from '@careerforge/domain';
import type { ConsentLookup, Provider, ProviderPort } from '@careerforge/policy';

import { explainDifference, isReproducible, type ComparableRun } from './diff.js';
import { createRecordedProvider, type Cassette } from './recorded.js';
import {
  executeRun,
  fingerprintOf,
  inputHashOf,
  type EnrichmentInput,
  type RunRequest,
} from './run.js';
import { TEMPLATES } from './templates.js';

/**
 * The pipeline, end to end, with no network anywhere.
 *
 * Everything below runs the real policy engine, the real transport guard, the
 * real validator, and a provider that answers from a recording. Nothing here
 * is stubbed past the point where bytes would leave the machine.
 */

const digest: Digest = (input) => createHash('sha256').update(input, 'utf8').digest('hex');

const openai: Provider = { id: 'openai', locality: 'remote' };
const ollama: Provider = { id: 'ollama', locality: 'local' };

const granted: ConsentLookup = () => ({
  projectKey: 'acme',
  providerId: 'openai',
  maxSensitivity: 'restricted',
  revoked: false,
});
const ungranted: ConsentLookup = () => null;

const input = (id: string, text: string, contentHash = `h-${id}`): EnrichmentInput => ({
  id,
  contentHash,
  sensitivity: 'internal',
  projectKey: 'acme',
  text,
});

const INPUTS = [
  input('01EV1', 'Rewrote the JSONL reader to split on the newline byte'),
  input('01EV2', 'Added a fixture for a 40MB transcript'),
];

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  target: { kind: 'work_unit', id: '01WU1' },
  enrichmentType: 'skills',
  provider: openai,
  model: 'gpt-test',
  inputs: INPUTS,
  ...overrides,
});

/** Build a cassette that answers whatever payload the engine actually made. */
function cassetteFor(req: RunRequest, value: unknown): Cassette {
  const payload = [...req.inputs].map((item) => `[evidence ${item.id}]\n${item.text}`).join('\n\n');
  return {
    entries: [
      {
        name: 'skills for the parser work',
        match: { schemaName: 'skills', model: req.model, payload },
        response: {
          value,
          model: 'gpt-test-2026-02-01',
          usage: { inputTokens: 90, outputTokens: 30 },
        },
      },
    ],
  };
}

const ANSWER = {
  skills: [
    {
      name: 'bounded-memory stream parsing',
      category: 'engineering',
      rationale: 'split on the newline byte instead of buffering',
      evidence: ['01EV1'],
    },
  ],
};

describe('the fingerprint', () => {
  it('is stable across the order the store hands over evidence', () => {
    // Otherwise a query plan change would look like changed evidence and
    // invalidate every cache in the store.
    const forward = inputHashOf(INPUTS, digest);
    const backward = inputHashOf([...INPUTS].reverse(), digest);
    expect(forward).toBe(backward);
  });

  it('changes when the content beneath an id changes', () => {
    const corrected = [input('01EV1', 'x', 'h-corrected'), INPUTS[1]!];
    expect(inputHashOf(corrected, digest)).not.toBe(inputHashOf(INPUTS, digest));
  });

  it('separates the five dimensions instead of folding them into one hash', () => {
    const fingerprint = fingerprintOf(request(), TEMPLATES['skills@1']!, digest);
    expect(Object.keys(fingerprint).sort()).toEqual([
      'inputHash',
      'inputIds',
      'model',
      'paramsHash',
      'promptHash',
      'providerId',
      'templateId',
    ]);
  });
});

describe('running', () => {
  it('completes through policy, transport, and validation', async () => {
    const req = request();
    const provider = createRecordedProvider(cassetteFor(req, ANSWER));
    const outcome = await executeRun(req, { consent: granted, digest, provider });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error('unreachable');
    expect(outcome.validated.items).toHaveLength(1);
    expect(outcome.validated.items[0]!.evidence).toEqual(['01EV1']);
    expect(outcome.usage).toEqual({ inputTokens: 90, outputTokens: 30 });
  });

  it('records what actually answered, not what was asked for', async () => {
    const req = request();
    const provider = createRecordedProvider(cassetteFor(req, ANSWER));
    const outcome = await executeRun(req, { consent: granted, digest, provider });

    if (outcome.kind !== 'completed') throw new Error('unreachable');
    expect(outcome.fingerprint.model).toBe('gpt-test');
    expect(outcome.response.model).toBe('gpt-test-2026-02-01');
  });

  it('discards an item citing evidence that was never sent', async () => {
    const req = request();
    const provider = createRecordedProvider(
      cassetteFor(req, {
        skills: [
          { ...ANSWER.skills[0]!, evidence: ['01EV1'] },
          {
            name: 'Kubernetes autoscaling',
            category: 'operations',
            rationale: 'seems likely',
            evidence: ['01NEVER'],
          },
        ],
      }),
    );
    const outcome = await executeRun(req, { consent: granted, digest, provider });

    if (outcome.kind !== 'completed') throw new Error('unreachable');
    expect(outcome.validated.items).toHaveLength(1);
    expect(outcome.validated.rejections[0]!.reason).toBe('fabricated_citation');
    expect(outcome.validated.unknownCitations).toEqual(['01NEVER']);
  });
});

describe('nothing before the call can cost anything', () => {
  const spyProvider = () =>
    vi.fn<ProviderPort>(async () => ({
      value: ANSWER,
      model: 'gpt-test',
      usage: { inputTokens: 1, outputTokens: 1 },
      requestId: null,
    }));

  const calls = (provider: ReturnType<typeof spyProvider>): number => provider.mock.calls.length;

  it('makes exactly one call across ten runs with identical inputs', async () => {
    const req = request();
    const provider = spyProvider();
    const store = new Map<string, string>();

    for (let attempt = 0; attempt < 10; attempt++) {
      const outcome = await executeRun(req, {
        consent: granted,
        digest,
        provider,
        lookupCached: (fingerprint) => {
          const key = JSON.stringify(fingerprint);
          const runId = store.get(key);
          return runId === undefined ? null : { runId, fingerprint };
        },
      });
      if (outcome.kind === 'completed') store.set(JSON.stringify(outcome.fingerprint), 'run-1');
    }

    expect(calls(provider)).toBe(1);
  });

  it('calls again when an input is corrected', async () => {
    const provider = spyProvider();
    const seen = new Set<string>();
    const options = {
      consent: granted,
      digest,
      provider,
      lookupCached: (fingerprint: { inputHash: string }) =>
        seen.has(fingerprint.inputHash) ? { runId: 'r', fingerprint: fingerprint as never } : null,
    };

    const first = await executeRun(request(), options);
    if (first.kind === 'completed') seen.add(first.fingerprint.inputHash);

    const corrected = request({ inputs: [input('01EV1', 'corrected', 'h-new'), INPUTS[1]!] });
    const second = await executeRun(corrected, options);

    expect(second.kind).toBe('completed');
    expect(calls(provider)).toBe(2);
  });

  it('sends nothing when policy refuses', async () => {
    const provider = spyProvider();
    const outcome = await executeRun(request(), { consent: ungranted, digest, provider });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('unreachable');
    expect(outcome.refusals[0]!.rule).toBe('consent-required@1');
    expect(calls(provider)).toBe(0);
  });

  it('sends nothing on a dry run, and shows what would have gone', async () => {
    const provider = spyProvider();
    const outcome = await executeRun(request(), {
      consent: granted,
      digest,
      provider,
      dryRun: true,
    });

    expect(outcome.kind).toBe('dry_run');
    if (outcome.kind !== 'dry_run') throw new Error('unreachable');
    expect(outcome.payload).toContain('Rewrote the JSONL reader');
    expect(outcome.instructions).toContain('cite');
    expect(calls(provider)).toBe(0);
  });

  it('sends nothing when no template exists for the type', async () => {
    const provider = spyProvider();
    const outcome = await executeRun(request({ enrichmentType: 'leadership' }), {
      consent: granted,
      digest,
      provider,
    });

    expect(outcome.kind).toBe('unsupported');
    expect(calls(provider)).toBe(0);
  });

  it('reaches a local provider without a grant', async () => {
    const req = request({ provider: ollama });
    const provider = createRecordedProvider(cassetteFor(req, ANSWER));
    const outcome = await executeRun(req, { consent: ungranted, digest, provider });
    expect(outcome.kind).toBe('completed');
  });
});

describe('the recorded provider', () => {
  it('runs the transport guard like any other adapter', async () => {
    // A recording that skipped the guard would let the whole suite pass with
    // a broken choke point.
    const req = request();
    const provider = createRecordedProvider(cassetteFor(req, ANSWER));
    const outcome = await executeRun(req, { consent: ungranted, digest, provider });
    expect(outcome.kind).toBe('refused');
  });

  it('refuses rather than guessing when nothing matches', async () => {
    const req = request();
    const provider = createRecordedProvider(cassetteFor(request({ model: 'other' }), ANSWER));
    const outcome = await executeRun(req, { consent: granted, digest, provider });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('unreachable');
    expect(outcome.refusals[0]!.code).toBe('no_recording');
  });

  it('stops answering when the prompt it recorded has changed', async () => {
    const req = request();
    const stale = cassetteFor(req, ANSWER);
    const provider = createRecordedProvider(
      {
        entries: [
          { ...stale.entries[0]!, match: { ...stale.entries[0]!.match, promptHash: 'stale-hash' } },
        ],
      },
      { digest },
    );
    const outcome = await executeRun(req, { consent: granted, digest, provider });
    expect(outcome.kind).toBe('refused');
  });
});

describe('attributing a difference', () => {
  const base: ComparableRun = {
    templateId: 'skills@1',
    promptHash: 'p1',
    paramsHash: 'a1',
    inputHash: 'i1',
    inputIds: ['01EV1', '01EV2'],
    providerId: 'openai',
    model: 'gpt-5',
    resolvedModel: 'gpt-5-2026-01-01',
  };

  it('says nothing changed when nothing changed', () => {
    expect(explainDifference(base, base, false)).toEqual([]);
    expect(isReproducible(base, base)).toBe(true);
  });

  it('distinguishes corrected evidence from added evidence', () => {
    const corrected = explainDifference(base, { ...base, inputHash: 'i2' }, true)[0]!;
    expect(corrected.dimension).toBe('evidence');
    expect(corrected.explanation).toContain('corrected or superseded');

    const added = explainDifference(
      base,
      { ...base, inputHash: 'i2', inputIds: ['01EV1', '01EV2', '01EV3'] },
      true,
    )[0]!;
    expect(added.explanation).toContain('1 record(s) added');
  });

  it('names a prompt version change', () => {
    const [difference] = explainDifference(
      base,
      { ...base, templateId: 'skills@2', promptHash: 'p2' },
      true,
    );
    expect(difference!.dimension).toBe('prompt');
    expect(difference!.to).toBe('skills@2');
  });

  it('separates a model you asked for from a build you did not', () => {
    // The most common real cause of a changed answer, and invisible unless
    // the resolved model is recorded alongside the requested one.
    const asked = explainDifference(base, { ...base, model: 'gpt-6' }, true)[0]!;
    expect(asked.dimension).toBe('model');

    const moved = explainDifference(base, { ...base, resolvedModel: 'gpt-5-2026-06-01' }, true)[0]!;
    expect(moved.dimension).toBe('model_build');
    expect(moved.explanation).toContain('upgraded underneath you');
  });

  it('names the model itself when nothing else moved', () => {
    // The honest answer. Reporting "nothing changed" while showing two
    // different answers would teach a user to stop trusting the record.
    const [difference] = explainDifference(base, base, true);
    expect(difference!.dimension).toBe('model_nondeterminism');
    expect(difference!.explanation).toContain('not reproducible');
  });

  it('reports every dimension that moved, not the first', () => {
    const differences = explainDifference(
      base,
      { ...base, inputHash: 'i2', templateId: 'skills@2', promptHash: 'p2', providerId: 'ollama' },
      true,
    );
    expect(differences.map((d) => d.dimension)).toEqual(['evidence', 'prompt', 'provider']);
  });

  it('still reports a changed prompt that produced the same answer', () => {
    // Useful in its own right: it is how you learn a prompt change did
    // nothing.
    const differences = explainDifference(
      base,
      { ...base, templateId: 'skills@2', promptHash: 'p2' },
      false,
    );
    expect(differences).toHaveLength(1);
  });

  it('flags a published template edited in place, which the lockfile should prevent', () => {
    const [difference] = explainDifference(base, { ...base, promptHash: 'p2' }, true);
    expect(difference!.explanation).toContain('edited in place');
  });
});
