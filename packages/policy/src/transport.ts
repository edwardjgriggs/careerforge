import type { Refusal } from '@careerforge/domain';

import type { PolicyDecision } from './engine.js';
import { hasResidualSecrets } from './redaction.js';

/**
 * The wire.
 *
 * Everything above this file talks about evidence, work units, and claims.
 * This file talks about bytes leaving the machine, and it is the only one in
 * CareerForge permitted to (invariant I3, enforced by lint).
 *
 * ── Why the adapter lives here and not in `enrich` ────────────────────────
 *
 * The obvious home for an OpenAI client is the package that wants to call
 * OpenAI. That arrangement has one fatal property: the caller assembles the
 * request body, so the caller decides what goes on the wire, and the policy
 * engine becomes a thing you are expected to remember to consult.
 *
 * So the body is assembled here instead, and the only evidence-derived string
 * it can contain is `decision.payload` — the text the engine itself produced,
 * redacted, after deciding the request was permitted. `enrich` cannot hand a
 * provider arbitrary text because there is no parameter for it. Bypass is not
 * discouraged; it is unspellable.
 *
 * The consequence worth stating plainly: a `ProviderCall` carries a
 * `PolicyDecision`, not a payload. Getting a decision means having gone
 * through `evaluate`.
 */

/** What a call cost. Recorded on the run so spend is answerable, not guessed. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Sampling parameters, hashed into the run record.
 *
 * Present so that "why is this year's answer different?" can be attributed.
 * A temperature change is a real cause of a changed result and must not be
 * invisible.
 */
export interface ProviderParams {
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly seed?: number;
}

export interface ProviderCall {
  /**
   * The engine's decision, carrying the exact bytes it permitted.
   *
   * Not a payload. This is the whole design: there is no way to describe a
   * call that sends something the engine has not seen and approved.
   */
  readonly decision: PolicyDecision;
  readonly model: string;
  readonly params: ProviderParams;
  /**
   * The rendered prompt template.
   *
   * Repo-authored, versioned, and free of evidence by construction — the
   * template registry is a set of frozen constants and a test asserts none of
   * them interpolates anything (ADR-0023). Checked here anyway, because a
   * guard that trusts its caller is not a guard.
   */
  readonly instructions: string;
  /** JSON Schema the provider must conform its output to. */
  readonly schema: unknown;
  readonly schemaName: string;
}

export interface ProviderResponse {
  /** Parsed structured output. Shape is the caller's problem to validate. */
  readonly value: unknown;
  /** What the provider says it actually ran — often more specific than asked. */
  readonly model: string;
  readonly usage: TokenUsage;
  readonly requestId: string | null;
}

/**
 * A provider, reduced to the one thing CareerForge needs from it.
 *
 * Deliberately ignorant of evidence, work units, and careers. Swapping OpenAI
 * for a local model must not require the enrichment layer to know it happened.
 */
export type ProviderPort = (call: ProviderCall) => Promise<ProviderResponse>;

/**
 * A refusal raised at the wire rather than returned from the engine.
 *
 * Carries the same `Refusal` shape as everything else, so a caller renders it
 * with `explainRefusal` and the user reads the same kind of sentence whether
 * the block came from consent, configuration, or the provider itself.
 */
export class ProviderRefusedError extends Error {
  constructor(readonly refusals: readonly Refusal[]) {
    super(refusals.map((refusal) => refusal.reason).join(' '));
    this.name = 'ProviderRefusedError';
  }
}

/**
 * Refuse anything that would put unapproved bytes on the wire.
 *
 * Exported so it can be tested directly and reused by any future adapter. A
 * second provider that forgets to call it is a bug this function cannot
 * prevent — but every adapter in the package is one file away from this
 * comment, and the recorded provider calls it too, so the test suite exercises
 * the guard on every run.
 */
export function assertTransmittable(call: ProviderCall): void {
  const refusals: Refusal[] = [...call.decision.refusals];

  if (call.decision.allowed && call.decision.payload === '') {
    // Not pedantry. An empty payload means the caller assembled a request out
    // of nothing, and sending it would spend money to interpret silence.
    refusals.push({
      code: 'empty_payload',
      rule: 'payload-nonempty@1',
      reason: 'There is nothing here to interpret.',
      remedy: {
        kind: 'evidence',
        needs: 'imported',
        detail: 'Collect some evidence for this work unit first.',
      },
    });
  }

  if (hasResidualSecrets(call.instructions)) {
    // The template registry is frozen and evidence-free, so reaching this
    // means somebody built a template out of live data. Refusing is cheap;
    // the alternative is a credential in a system prompt.
    refusals.push({
      code: 'instructions_not_clean',
      rule: 'instructions-static@1',
      reason: 'The prompt template contains something that looks like a secret.',
      remedy: {
        kind: 'reduce_payload',
        detail:
          'Prompt templates are static text. Anything derived from your evidence belongs in the payload, where redaction and consent apply to it.',
      },
    });
  }

  if (refusals.length > 0) throw new ProviderRefusedError(refusals);
}

/** Injected so the suite can run the real adapter with no network anywhere. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}>;

export interface OpenAIConfig {
  /** Empty or absent produces an actionable refusal, never a thrown TypeError. */
  readonly apiKey: string | undefined;
  readonly baseUrl?: string;
  readonly timeoutMillis?: number;
  readonly fetchImpl?: FetchLike;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MILLIS = 60_000;

/**
 * The OpenAI adapter.
 *
 * Uses the chat completions endpoint with a JSON Schema response format, so
 * the provider is responsible for conforming its own output and CareerForge
 * never parses prose into structure. That matters more than it sounds: prose
 * parsing is where a résumé generator quietly starts inventing.
 */
export function createOpenAIProvider(config: OpenAIConfig): ProviderPort {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMillis = config.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS;
  const doFetch =
    config.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);

  return async (call) => {
    assertTransmittable(call);

    if (config.apiKey === undefined || config.apiKey === '') {
      throw new ProviderRefusedError([
        {
          code: 'no_api_key',
          rule: 'provider-configured@1',
          reason: 'CareerForge has no OpenAI key to call with.',
          remedy: {
            kind: 'configure',
            setting: 'OPENAI_API_KEY',
            detail:
              'Everything else — collecting, grouping, searching, explaining — works without one. Only enrichment needs a key.',
          },
        },
      ]);
    }

    const body = JSON.stringify({
      model: call.model,
      temperature: call.params.temperature,
      max_completion_tokens: call.params.maxOutputTokens,
      ...(call.params.seed === undefined ? {} : { seed: call.params.seed }),
      response_format: {
        type: 'json_schema',
        json_schema: { name: call.schemaName, strict: true, schema: call.schema },
      },
      messages: [
        { role: 'system', content: call.instructions },
        // The one and only evidence-derived string on the wire.
        { role: 'user', content: call.decision.payload },
      ],
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMillis);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new ProviderRefusedError([networkRefusal(cause)]);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) throw new ProviderRefusedError([httpRefusal(response.status, text)]);

    return parseCompletion(text, response.headers.get('x-request-id'));
  };
}

function networkRefusal(cause: unknown): Refusal {
  const aborted = cause instanceof Error && cause.name === 'AbortError';
  return {
    code: aborted ? 'provider_timeout' : 'provider_unreachable',
    rule: 'provider-reachable@1',
    reason: aborted
      ? 'The provider did not answer in time.'
      : `Could not reach the provider: ${cause instanceof Error ? cause.message : String(cause)}`,
    remedy: {
      kind: 'not_possible',
      detail:
        'Nothing was recorded, so running the same command again is safe and costs nothing extra.',
    },
  };
}

/**
 * Map an HTTP failure onto something a person can act on.
 *
 * A raw status code tells a user nothing about whether the problem is theirs.
 * 401 is a key problem, 429 is a spend problem, 5xx is nobody's fault — and
 * the three deserve three different sentences.
 */
function httpRefusal(status: number, body: string): Refusal {
  if (status === 401 || status === 403) {
    return {
      code: 'provider_rejected_key',
      rule: 'provider-configured@1',
      reason: 'The provider rejected the API key.',
      remedy: {
        kind: 'configure',
        setting: 'OPENAI_API_KEY',
        detail:
          'The key is set but not accepted. Check that it is current and has not been revoked.',
      },
    };
  }

  if (status === 429) {
    return {
      code: 'provider_rate_limited',
      rule: 'provider-available@1',
      reason: 'The provider is rate-limiting this account, or the quota is exhausted.',
      remedy: {
        kind: 'not_possible',
        detail:
          'Nothing was recorded. Wait and run it again, or check the billing on your account.',
      },
    };
  }

  return {
    code: 'provider_error',
    rule: 'provider-available@1',
    reason: `The provider returned ${status}.`,
    remedy: {
      kind: 'not_possible',
      // Truncated: an error body from a provider can be long and can echo the
      // request, which would put payload text into a log.
      detail: `Nothing was recorded. The provider said: ${body.slice(0, 200)}`,
    },
  };
}

interface CompletionShape {
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  choices?: { message?: { content?: unknown; refusal?: unknown } }[];
}

function parseCompletion(text: string, requestId: string | null): ProviderResponse {
  let parsed: CompletionShape;
  try {
    parsed = JSON.parse(text) as CompletionShape;
  } catch {
    throw new ProviderRefusedError([
      {
        code: 'provider_unparseable',
        rule: 'provider-available@1',
        reason: 'The provider returned something that is not JSON.',
        remedy: { kind: 'not_possible', detail: 'Nothing was recorded. Try again.' },
      },
    ]);
  }

  const choice = parsed.choices?.[0]?.message;

  // A model may decline. That is its refusal, not an error, and flattening it
  // into "provider error" would lose the only useful part.
  if (typeof choice?.refusal === 'string' && choice.refusal !== '') {
    throw new ProviderRefusedError([
      {
        code: 'model_declined',
        rule: 'provider-available@1',
        reason: `The model declined to answer: ${choice.refusal}`,
        remedy: {
          kind: 'reduce_payload',
          detail: 'This usually means the payload tripped a provider content filter.',
        },
      },
    ]);
  }

  if (typeof choice?.content !== 'string') {
    throw new ProviderRefusedError([
      {
        code: 'provider_empty',
        rule: 'provider-available@1',
        reason: 'The provider returned no content.',
        remedy: { kind: 'not_possible', detail: 'Nothing was recorded. Try again.' },
      },
    ]);
  }

  let value: unknown;
  try {
    value = JSON.parse(choice.content);
  } catch {
    throw new ProviderRefusedError([
      {
        code: 'provider_not_structured',
        rule: 'structured-output@1',
        reason: 'The provider returned prose where structured output was required.',
        remedy: {
          kind: 'not_possible',
          detail:
            'Nothing was recorded. CareerForge does not parse prose into structure — that is where a generator starts inventing.',
        },
      },
    ]);
  }

  const asNumber = (input: unknown): number => (typeof input === 'number' ? input : 0);

  return {
    value,
    model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
    usage: {
      inputTokens: asNumber(parsed.usage?.prompt_tokens),
      outputTokens: asNumber(parsed.usage?.completion_tokens),
    },
    requestId,
  };
}
