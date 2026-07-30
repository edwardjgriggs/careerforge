import { describe, expect, it, vi } from 'vitest';

import { isActionable } from '@careerforge/domain';

import { evaluate, type PayloadItem, type Provider } from './engine.js';
import {
  assertTransmittable,
  createOpenAIProvider,
  ProviderRefusedError,
  type FetchLike,
  type ProviderCall,
} from './transport.js';

/**
 * The wire.
 *
 * Two things are under test and only one of them is the HTTP client. The
 * other is the claim that a caller *cannot* send unapproved bytes — not that
 * it should not, but that there is no way to say it.
 */

const remote: Provider = { id: 'openai', locality: 'remote' };

const item = (text: string): PayloadItem => ({
  kind: 'evidence',
  id: 'ev-1',
  sensitivity: 'internal',
  projectKey: 'acme',
  text,
});

const allowed = (text = 'shipped the importer') =>
  evaluate(
    { provider: remote, purpose: 'enrich', items: [item(text)] },
    {
      consent: () => ({
        projectKey: 'acme',
        providerId: 'openai',
        maxSensitivity: 'restricted',
        revoked: false,
      }),
    },
  );

const refused = () =>
  evaluate({ provider: remote, purpose: 'enrich', items: [item('x')] }, { consent: () => null });

const callWith = (
  decision: ReturnType<typeof evaluate>,
  instructions = 'List the skills.',
): ProviderCall => ({
  decision,
  model: 'gpt-test',
  params: { temperature: 0, maxOutputTokens: 512 },
  instructions,
  schema: { type: 'object' },
  schemaName: 'test',
});

/** A provider that answers correctly, so failures are attributable to policy. */
function stubFetch(payload: unknown, overrides: Partial<{ status: number; body: string }> = {}) {
  return vi.fn<FetchLike>(async () => ({
    ok: (overrides.status ?? 200) < 400,
    status: overrides.status ?? 200,
    text: async () =>
      overrides.body ??
      JSON.stringify({
        model: 'gpt-test-2026-01-01',
        usage: { prompt_tokens: 40, completion_tokens: 12 },
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    headers: { get: () => 'req_123' },
  }));
}

describe('the guard at the wire', () => {
  it('refuses a call whose decision refused', () => {
    expect(() => assertTransmittable(callWith(refused()))).toThrow(ProviderRefusedError);
  });

  it('carries the engine refusals through unchanged, so the user reads one vocabulary', () => {
    try {
      assertTransmittable(callWith(refused()));
      expect.unreachable('should have refused');
    } catch (error) {
      const refusals = (error as ProviderRefusedError).refusals;
      expect(refusals[0]!.rule).toBe('consent-required@1');
      expect(isActionable(refusals[0]!.remedy)).toBe(true);
    }
  });

  it('refuses an empty payload rather than paying to interpret silence', () => {
    const empty = evaluate(
      { provider: { id: 'ollama', locality: 'local' }, purpose: 'enrich', items: [] },
      { consent: () => null },
    );
    expect(empty.allowed).toBe(true);
    expect(() => assertTransmittable(callWith(empty))).toThrow(/nothing here to interpret/i);
  });

  it('refuses instructions that contain a secret', () => {
    // Templates are static repo text. Reaching this means somebody built one
    // out of live data, which would put a credential in a system prompt.
    expect(() =>
      assertTransmittable(
        callWith(allowed(), 'Use api_key="sk-live-9d8f7a6b5c4d3e2f1a0b" to help.'),
      ),
    ).toThrow(/looks like a secret/i);
  });

  it('permits a clean, allowed call', () => {
    expect(() => assertTransmittable(callWith(allowed()))).not.toThrow();
  });
});

describe('the OpenAI adapter', () => {
  it('sends the decision payload and nothing else derived from evidence', async () => {
    const doFetch = stubFetch({ skills: [] });
    const provider = createOpenAIProvider({ apiKey: 'sk-test', fetchImpl: doFetch });
    const decision = allowed('rewrote the deduplication pass');

    await provider(callWith(decision));

    const body = JSON.parse(doFetch.mock.calls[0]![1].body) as {
      messages: { role: string; content: string }[];
    };
    // The user message is the engine's own output, byte for byte. There is no
    // parameter through which a caller could substitute anything else.
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1]!.content).toBe(decision.payload);
    expect(body.messages[1]!.content).toContain('rewrote the deduplication pass');
  });

  it('never calls out when the decision refused', async () => {
    const doFetch = stubFetch({});
    const provider = createOpenAIProvider({ apiKey: 'sk-test', fetchImpl: doFetch });

    await expect(provider(callWith(refused()))).rejects.toThrow(ProviderRefusedError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('asks the provider to conform its own output rather than parsing prose', async () => {
    const doFetch = stubFetch({ skills: [] });
    const provider = createOpenAIProvider({ apiKey: 'sk-test', fetchImpl: doFetch });
    await provider(callWith(allowed()));

    const body = JSON.parse(doFetch.mock.calls[0]![1].body) as {
      response_format: { type: string; json_schema: { strict: boolean } };
    };
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('returns parsed output, the model that actually ran, and what it cost', async () => {
    const provider = createOpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: stubFetch({ skills: ['TypeScript'] }),
    });
    const response = await provider(callWith(allowed()));

    expect(response.value).toEqual({ skills: ['TypeScript'] });
    // What the provider says it ran, which is routinely more specific than
    // what was asked for. Recording the request would make a run record lie.
    expect(response.model).toBe('gpt-test-2026-01-01');
    expect(response.usage).toEqual({ inputTokens: 40, outputTokens: 12 });
    expect(response.requestId).toBe('req_123');
  });
});

describe('when the provider will not play', () => {
  const run = async (overrides: Partial<{ status: number; body: string }>, apiKey = 'sk-test') => {
    const provider = createOpenAIProvider({ apiKey, fetchImpl: stubFetch({}, overrides) });
    try {
      await provider(callWith(allowed()));
      expect.unreachable('should have refused');
    } catch (error) {
      return (error as ProviderRefusedError).refusals[0]!;
    }
  };

  it('says what to set when there is no key, and that nothing else is affected', async () => {
    const refusal = await run({}, '');
    expect(refusal.code).toBe('no_api_key');
    expect(refusal.remedy).toMatchObject({ kind: 'configure', setting: 'OPENAI_API_KEY' });
    expect(refusal.remedy).toHaveProperty('detail', expect.stringContaining('works without one'));
  });

  it('distinguishes a rejected key from a missing one', async () => {
    const refusal = await run({ status: 401, body: '{}' });
    expect(refusal.code).toBe('provider_rejected_key');
    expect(refusal.remedy.kind).toBe('configure');
  });

  it('treats rate limiting as a spend problem, not a configuration one', async () => {
    const refusal = await run({ status: 429, body: '{}' });
    expect(refusal.code).toBe('provider_rate_limited');
    expect(refusal.reason).toMatch(/quota|rate/i);
  });

  it('does not echo an unbounded error body into the message', async () => {
    const refusal = await run({ status: 500, body: 'x'.repeat(10_000) });
    expect(refusal.code).toBe('provider_error');
    // An error body can echo the request, and an unbounded echo puts payload
    // text into a log.
    const detail = refusal.remedy.kind === 'not_possible' ? refusal.remedy.detail : '';
    expect(detail.length).toBeLessThan(300);
  });

  it('keeps a model refusal as a refusal instead of flattening it to an error', async () => {
    const refusal = await run({
      body: JSON.stringify({ choices: [{ message: { refusal: 'I cannot help with that.' } }] }),
    });
    expect(refusal.code).toBe('model_declined');
    expect(refusal.reason).toContain('I cannot help with that.');
  });

  it('refuses prose where structure was required', async () => {
    const refusal = await run({
      body: JSON.stringify({ choices: [{ message: { content: 'Sure! Here are your skills:' } }] }),
    });
    expect(refusal.code).toBe('provider_not_structured');
  });

  it('says plainly that a failed call recorded nothing', async () => {
    for (const overrides of [
      { status: 500, body: '{}' },
      { status: 429, body: '{}' },
    ]) {
      const refusal = await run(overrides);
      const detail = refusal.remedy.kind === 'not_possible' ? refusal.remedy.detail : '';
      expect(detail).toMatch(/nothing was recorded/i);
    }
  });
});
