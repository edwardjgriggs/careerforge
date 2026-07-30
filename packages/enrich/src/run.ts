import type { Digest, EnrichmentType, Refusal, Sensitivity } from '@careerforge/domain';
import {
  evaluate,
  preview,
  ProviderRefusedError,
  type ConsentLookup,
  type PayloadItem,
  type PolicyDecision,
  type Provider,
  type ProviderPort,
  type ProviderResponse,
  type TokenUsage,
} from '@careerforge/policy';

import { canonicalise } from './canonical.js';
import { validateResponse, type ValidatedResponse } from './response.js';
import { resolveTemplate, templateFor, templateHash, type PromptTemplate } from './templates.js';

/**
 * Running an enrichment, reproducibly.
 *
 * The unit of work here is not "call a model". It is "record what was asked,
 * of what, with which instrument, and what came back" — in enough detail that
 * somebody a year from now can ask why this year's answer is different and get
 * a real answer instead of a shrug.
 *
 * ── The fingerprint ──────────────────────────────────────────────────────
 *
 * Five independent dimensions decide an enrichment's output: the evidence, the
 * prompt, the provider, the model, and the sampling parameters. Each gets its
 * own hash or field, none is folded into another, and `explainDifference`
 * attributes a changed result to whichever of them actually moved.
 *
 * That decomposition is the whole reason for the ceremony. A single opaque
 * "run hash" would tell you two runs differ and nothing about why, which is
 * the question a person actually has.
 *
 * ── Nothing here talks to a provider directly ────────────────────────────
 *
 * A `ProviderPort` is injected, and every path to it goes through `evaluate`
 * first — the port takes a decision, not a payload, so there is no way to
 * express a call that skips the gate (invariant I3).
 */

export interface EnrichmentInput {
  readonly id: string;
  /**
   * The evidence's content hash.
   *
   * Identity, not text. Two runs over the same ids with different content
   * hashes are runs over different evidence, and that is exactly the
   * distinction staleness turns on.
   */
  readonly contentHash: string;
  readonly sensitivity: Sensitivity;
  readonly projectKey: string | null;
  readonly text: string;
}

export interface RunRequest {
  readonly target: { readonly kind: 'evidence' | 'work_unit'; readonly id: string };
  readonly enrichmentType: EnrichmentType;
  /** Pin an older template to reproduce a past run. Defaults to current. */
  readonly templateId?: string;
  readonly provider: Provider;
  readonly model: string;
  readonly inputs: readonly EnrichmentInput[];
}

/**
 * Everything that decides an output, decomposed.
 *
 * Stored on the run. A run recorded a year ago is reconstructible from this
 * alone: the template id resolves to frozen text, the hashes say whether
 * anything moved, and the model string says what actually answered.
 */
export interface RunFingerprint {
  readonly templateId: string;
  readonly promptHash: string;
  readonly paramsHash: string;
  readonly inputHash: string;
  readonly inputIds: readonly string[];
  readonly providerId: string;
  readonly model: string;
}

/**
 * Hash the inputs by identity and content, in a fixed order.
 *
 * Sorted by id so the same set of evidence produces the same hash regardless
 * of the order the store handed it over — otherwise a query plan change would
 * look like changed evidence and invalidate every cache in the store.
 */
export function inputHashOf(inputs: readonly EnrichmentInput[], digest: Digest): string {
  const ordered = [...inputs]
    .map((input) => [input.id, input.contentHash] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return digest(canonicalise(ordered));
}

export function fingerprintOf(
  request: RunRequest,
  template: PromptTemplate,
  digest: Digest,
): RunFingerprint {
  return {
    templateId: template.id,
    promptHash: templateHash(template, digest),
    paramsHash: digest(canonicalise(template.params)),
    inputHash: inputHashOf(request.inputs, digest),
    inputIds: [...request.inputs.map((input) => input.id)].sort(),
    providerId: request.provider.id,
    model: request.model,
  };
}

const toPayloadItem = (input: EnrichmentInput): PayloadItem => ({
  kind: 'evidence',
  id: input.id,
  sensitivity: input.sensitivity,
  projectKey: input.projectKey,
  text: input.text,
});

/** A run already in the store that would answer this request. */
export interface CachedRun {
  readonly runId: string;
  readonly fingerprint: RunFingerprint;
}

export interface ExecuteOptions {
  readonly consent: ConsentLookup;
  readonly digest: Digest;
  readonly provider: ProviderPort;
  /** A completed run with this exact fingerprint, if the store has one. */
  readonly lookupCached?: (fingerprint: RunFingerprint) => CachedRun | null;
  /** Show what would be sent and stop. Costs nothing and calls nothing. */
  readonly dryRun?: boolean;
  /** Ignore a cache hit and call anyway. For comparing models deliberately. */
  readonly force?: boolean;
}

export type RunOutcome =
  /** No template exists for this type. Not an error — M9 shipped three. */
  | { readonly kind: 'unsupported'; readonly refusal: Refusal }
  /** An earlier run answers this exactly. No call was made and none is needed. */
  | { readonly kind: 'cached'; readonly fingerprint: RunFingerprint; readonly cached: CachedRun }
  /** Policy said no, or the provider did. Nothing was sent. */
  | {
      readonly kind: 'refused';
      readonly fingerprint: RunFingerprint;
      readonly decision: PolicyDecision;
      readonly refusals: readonly Refusal[];
    }
  /** What would have been sent, and to whom. */
  | {
      readonly kind: 'dry_run';
      readonly fingerprint: RunFingerprint;
      readonly decision: PolicyDecision;
      readonly instructions: string;
      readonly payload: string;
    }
  | {
      readonly kind: 'completed';
      readonly fingerprint: RunFingerprint;
      readonly decision: PolicyDecision;
      readonly response: ProviderResponse;
      readonly validated: ValidatedResponse;
      readonly usage: TokenUsage;
    };

/**
 * Plan a run, gate it, and — only if all of that succeeds — make the call.
 *
 * Ordering is deliberate and load-bearing:
 *
 *   1. resolve the template   — no template, no run, no cost
 *   2. fingerprint            — cheap, and the cache key
 *   3. cache                  — a hit ends here, having sent nothing
 *   4. policy                 — a refusal ends here, having sent nothing
 *   5. dry run                — ends here by request, having sent nothing
 *   6. call                   — the only step that can spend money
 *
 * Every exit before step six is free. That is not an optimisation; it is what
 * makes it reasonable to run `enrich` over a whole store without fear.
 */
export async function executeRun(
  request: RunRequest,
  options: ExecuteOptions,
): Promise<RunOutcome> {
  const template =
    request.templateId === undefined
      ? templateFor(request.enrichmentType)
      : resolveTemplate(request.templateId);

  if (template === null) {
    return {
      kind: 'unsupported',
      refusal: {
        code: 'no_template',
        rule: 'template-published@1',
        reason:
          request.templateId === undefined
            ? `CareerForge has no published prompt for ${request.enrichmentType}.`
            : `There is no prompt template ${request.templateId}.`,
        remedy: {
          kind: 'not_possible',
          detail:
            'Prompts are versioned artifacts and only published ones can run. Nothing was sent and nothing was recorded.',
        },
      },
    };
  }

  const fingerprint = fingerprintOf(request, template, options.digest);

  if (options.force !== true && options.lookupCached !== undefined) {
    const hit = options.lookupCached(fingerprint);
    // Identical evidence, prompt, provider, model, and parameters. The answer
    // would be the same answer, so asking for it again is spending money to
    // learn nothing.
    if (hit !== null) return { kind: 'cached', fingerprint, cached: hit };
  }

  const egress = {
    provider: request.provider,
    purpose: `enrich:${request.enrichmentType}`,
    items: request.inputs.map(toPayloadItem),
  };

  const decision = evaluate(egress, { consent: options.consent, digest: options.digest });

  if (!decision.allowed) {
    return { kind: 'refused', fingerprint, decision, refusals: decision.refusals };
  }

  if (options.dryRun === true) {
    return {
      kind: 'dry_run',
      fingerprint,
      decision,
      instructions: template.instructions,
      // `preview` rather than `decision.payload` so a dry run of a *refused*
      // request still shows the bytes. Seeing what would leave is how somebody
      // decides whether to allow it.
      payload: preview(egress).payload,
    };
  }

  let response: ProviderResponse;
  try {
    response = await options.provider({
      decision,
      model: request.model,
      params: template.params,
      instructions: template.instructions,
      schema: template.schema,
      schemaName: template.schemaName,
    });
  } catch (error) {
    if (error instanceof ProviderRefusedError) {
      return { kind: 'refused', fingerprint, decision, refusals: error.refusals };
    }
    throw error;
  }

  return {
    kind: 'completed',
    fingerprint,
    decision,
    response,
    validated: validateResponse(response.value, template, fingerprint.inputIds),
    usage: response.usage,
  };
}
