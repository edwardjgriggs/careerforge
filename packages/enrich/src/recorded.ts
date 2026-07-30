import type { Digest } from '@careerforge/domain';
import { assertTransmittable, ProviderRefusedError, type ProviderPort } from '@careerforge/policy';

/**
 * A provider that answers from a recording.
 *
 * Two jobs, and the second is the one that shaped the design.
 *
 * The first is testing: the whole pipeline — policy, redaction, transport
 * guard, validation, caching, storage — runs end to end in CI with no network
 * and no key. A test suite that needs a credential is a test suite that is
 * skipped, and the skipped tests are always the ones covering the code that
 * spends money.
 *
 * The second is contribution. Somebody improving a prompt should not have to
 * fund an OpenAI account to see whether their change works. Requiring a key to
 * develop enrichment does not merely inconvenience contributors; it selects
 * which contributors exist. Cassettes are committed, so the fixture corpus is
 * a shared asset rather than a private one.
 *
 * ── It is a real provider, not a stub ────────────────────────────────────
 *
 * It calls `assertTransmittable` like any adapter. A recorded provider that
 * skipped the guard would let the whole suite pass while the guard was broken,
 * which is precisely the bug the guard exists to catch.
 */

export interface CassetteEntry {
  /** Short, human-written; appears in test output when a lookup misses. */
  readonly name: string;
  /**
   * Which call this answers.
   *
   * Keyed on what was asked and the payload the engine produced — not on the
   * work unit id, which changes every time a fixture store is rebuilt.
   *
   * `promptHash` is optional so a hand-written fixture stays hand-writable.
   * When present it is checked, which is what makes a generated cassette
   * precise about the prompt version it recorded: edit the prompt and the
   * recording stops answering instead of quietly answering for the wrong text.
   */
  readonly match: {
    readonly schemaName: string;
    readonly model: string;
    readonly payload: string;
    readonly promptHash?: string;
  };
  readonly response: {
    readonly value: unknown;
    readonly model: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  };
}

export interface Cassette {
  readonly entries: readonly CassetteEntry[];
}

export interface RecordedProviderOptions {
  /**
   * What to do when nothing matches.
   *
   * Refusing is the default and the right one for CI: a silent fallback would
   * let a test assert on an answer nobody recorded. Passing a real provider
   * here is the local workflow for recording new cassettes.
   */
  readonly onMiss?: 'refuse' | ProviderPort;
  /** Enables `promptHash` matching. Without it, that field is ignored. */
  readonly digest?: Digest;
}

export function createRecordedProvider(
  cassette: Cassette,
  options: RecordedProviderOptions = {},
): ProviderPort {
  return async (call) => {
    // The same guard every adapter runs. Skipping it here would let the suite
    // pass with a broken choke point.
    assertTransmittable(call);

    const promptHash = options.digest === undefined ? undefined : options.digest(call.instructions);

    const entry = cassette.entries.find(
      (candidate) =>
        candidate.match.schemaName === call.schemaName &&
        candidate.match.model === call.model &&
        candidate.match.payload === call.decision.payload &&
        (candidate.match.promptHash === undefined ||
          promptHash === undefined ||
          candidate.match.promptHash === promptHash),
    );

    if (entry === undefined) {
      const onMiss = options.onMiss ?? 'refuse';
      if (onMiss !== 'refuse') return onMiss(call);

      throw new ProviderRefusedError([
        {
          code: 'no_recording',
          rule: 'recorded-provider@1',
          reason: `No recorded answer for ${call.schemaName} on ${call.model} with this payload.`,
          remedy: {
            kind: 'not_possible',
            detail:
              'A recorded provider never guesses. Record this call against a real provider and commit the cassette, or check whether the payload changed.',
          },
        },
      ]);
    }

    return {
      value: entry.response.value,
      model: entry.response.model,
      usage: entry.response.usage,
      requestId: null,
    };
  };
}

/** Read a cassette out of parsed JSON, refusing anything malformed. */
export function parseCassette(raw: unknown): Cassette {
  const entries = (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) {
    throw new Error('A cassette needs an "entries" array.');
  }
  for (const [index, entry] of entries.entries()) {
    const candidate = entry as Partial<CassetteEntry>;
    if (
      typeof candidate.name !== 'string' ||
      typeof candidate.match?.schemaName !== 'string' ||
      typeof candidate.match?.model !== 'string' ||
      typeof candidate.match?.payload !== 'string' ||
      candidate.response === undefined
    ) {
      throw new Error(`Cassette entry ${index} is missing a required field.`);
    }
  }
  return { entries: entries as CassetteEntry[] };
}
