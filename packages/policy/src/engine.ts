import {
  isPermittedAt,
  maxSensitivity,
  sensitivityRank,
  type Refusal,
  type Sensitivity,
} from '@careerforge/domain';

import { redact, REDACTION_PROFILE, type RedactionReport } from './redaction.js';

/**
 * The egress choke point.
 *
 * Nothing in CareerForge may put local evidence into an outbound payload
 * except through here, and this package is the only one permitted to hold an
 * HTTP client (invariant I3, enforced by lint). It ships before any provider
 * exists, so there is no window in which egress is possible without
 * enforcement.
 *
 * ── Every refusal names the rule and the remedy ──────────────────────────
 *
 * A user told only "blocked" learns nothing and disables the feature. A user
 * told *which rule*, *why*, and *the exact command that would change it* is
 * being taught something true about their own data. Rules are named and
 * versioned so a decision recorded years ago can still be explained.
 *
 * The engine is pure. Consent is looked up through an injected function and
 * decisions are handed to a caller to persist, so the rules can be tested
 * exhaustively with no database and no network anywhere near them.
 */

export type ProviderLocality = 'local' | 'remote';

export interface Provider {
  readonly id: string;
  /**
   * Whether the provider runs on this machine.
   *
   * The distinction that makes `restricted` workable at all: a local model
   * sees the data without it leaving, so it needs no grant.
   */
  readonly locality: ProviderLocality;
}

/** One record being offered for egress. */
export interface PayloadItem {
  readonly kind: 'evidence' | 'work_unit';
  readonly id: string;
  readonly sensitivity: Sensitivity;
  readonly projectKey: string | null;
  readonly text: string;
}

export interface EgressRequest {
  readonly provider: Provider;
  readonly purpose: string;
  readonly items: readonly PayloadItem[];
  /**
   * Whether the caller holds the `egress` capability.
   *
   * Distinct from network access on purpose. A collector may legitimately need
   * to *fetch*; permitting it to *send* is how a collector quietly becomes an
   * exfiltration path (ADR-0009).
   */
  readonly hasEgressGrant?: boolean;
}

export interface ConsentGrant {
  readonly projectKey: string | null;
  readonly providerId: string;
  /** The highest sensitivity this grant permits. */
  readonly maxSensitivity: Sensitivity;
  readonly revoked: boolean;
}

/** How the engine asks what the user has allowed. */
export type ConsentLookup = (projectKey: string | null, providerId: string) => ConsentGrant | null;

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly providerId: string;
  readonly purpose: string;
  /** `max()` over every input. Never the average, never the minimum. */
  readonly maxSensitivity: Sensitivity;
  readonly projectKeys: readonly string[];
  readonly itemCount: number;
  /** Every rule that blocked, not merely the first. */
  readonly refusals: readonly Refusal[];
  /** The exact text that would be transmitted. Empty when refused. */
  readonly payload: string;
  readonly redaction: RedactionReport;
  /** Digest of the payload, so a decision is checkable without keeping it. */
  readonly payloadHash: string | null;
}

export const POLICY_RULES = [
  'egress-capability@1',
  'restricted-default@1',
  'consent-required@1',
  'consent-revoked@1',
  'sensitivity-ceiling@1',
] as const;

export type PolicyRuleId = (typeof POLICY_RULES)[number];

const grantCommand = (projectKey: string | null, providerId: string, level: string): string =>
  `careerforge consent grant --provider ${providerId} --project ${projectKey ?? '<project>'} --level ${level}`;

export interface EvaluateOptions {
  readonly consent: ConsentLookup;
  /** Injected so the engine stays pure; the store supplies SHA-256. */
  readonly digest?: (input: string) => string;
}

/**
 * Decide whether a request may leave, and say exactly why not.
 *
 * All rules are evaluated rather than stopping at the first failure. Reporting
 * one problem at a time turns a privacy decision into whack-a-mole, and a user
 * who fixes what they were told and is refused again learns to distrust the
 * explanation.
 */
export function evaluate(request: EgressRequest, options: EvaluateOptions): PolicyDecision {
  const sensitivities = request.items.map((item) => item.sensitivity);
  const maxLevel = maxSensitivity(sensitivities);
  const projectKeys = [
    ...new Set(
      request.items.map((item) => item.projectKey).filter((key): key is string => key !== null),
    ),
  ].sort();

  const joined = request.items
    .map((item) => `[${item.kind} ${item.id}]\n${item.text}`)
    .join('\n\n');
  const redacted = redact(joined);

  const refusals: Refusal[] = [];

  // A local provider sees the data without it leaving the machine, so no rule
  // below applies to it. This is what makes `restricted` workable rather than
  // merely restrictive.
  if (request.provider.locality === 'remote') {
    if (request.hasEgressGrant === false) {
      refusals.push({
        code: 'no_egress_capability',
        rule: 'egress-capability@1',
        reason:
          'This caller may reach the network but is not permitted to include your evidence in what it sends.',
        remedy: {
          kind: 'not_possible',
          detail:
            'Network access and permission to send your data are separate grants. This one holds only the first.',
        },
      });
    }

    for (const projectKey of projectKeys.length > 0 ? projectKeys : [null]) {
      const grant = options.consent(projectKey, request.provider.id);
      const relevant = request.items.filter((item) => item.projectKey === projectKey);
      const projectLevel = maxSensitivity(relevant.map((item) => item.sensitivity));

      if (grant === null) {
        refusals.push({
          code: 'no_consent',
          rule: 'consent-required@1',
          reason: `You have not allowed ${request.provider.id} to receive work from ${projectKey ?? 'this store'}.`,
          remedy: {
            kind: 'grant',
            projectKey,
            providerId: request.provider.id,
            level: projectLevel,
            command: grantCommand(projectKey, request.provider.id, projectLevel),
          },
        });
        continue;
      }

      if (grant.revoked) {
        refusals.push({
          code: 'consent_revoked',
          rule: 'consent-revoked@1',
          reason: `You revoked ${request.provider.id}'s access to ${projectKey ?? 'this store'}.`,
          remedy: {
            kind: 'grant',
            projectKey,
            providerId: request.provider.id,
            level: projectLevel,
            command: grantCommand(projectKey, request.provider.id, projectLevel),
          },
        });
        continue;
      }

      if (!isPermittedAt(projectLevel, grant.maxSensitivity)) {
        // Named separately from the general ceiling because this is the
        // product's loudest promise, and a user meeting it should be told
        // which promise is being kept rather than that a number was too big.
        const isRestricted = projectLevel === 'restricted';
        refusals.push({
          code: isRestricted ? 'restricted_by_default' : 'above_granted_sensitivity',
          rule: isRestricted ? 'restricted-default@1' : 'sensitivity-ceiling@1',
          reason: isRestricted
            ? `This includes ${projectKey ?? 'work'} classified restricted — session transcripts and the like — which never leaves your machine unless you say otherwise for this project.`
            : `You allowed ${request.provider.id} up to ${grant.maxSensitivity}, and this includes ${projectLevel} work.`,
          remedy:
            isRestricted && sensitivityRank(grant.maxSensitivity) < sensitivityRank('restricted')
              ? {
                  kind: 'use_local_provider',
                  detail: `Or raise the level for this project: ${grantCommand(projectKey, request.provider.id, projectLevel)}`,
                }
              : {
                  kind: 'grant',
                  projectKey,
                  providerId: request.provider.id,
                  level: projectLevel,
                  command: grantCommand(projectKey, request.provider.id, projectLevel),
                },
        });
      }
    }
  }

  const allowed = refusals.length === 0;

  return {
    allowed,
    providerId: request.provider.id,
    purpose: request.purpose,
    maxSensitivity: maxLevel,
    projectKeys,
    itemCount: request.items.length,
    refusals,
    // Nothing is produced for a refused request. A payload that exists only
    // to be discarded is a payload that can be logged by mistake.
    payload: allowed ? redacted.text : '',
    redaction: allowed
      ? redacted.report
      : { profile: REDACTION_PROFILE, findings: [], totalRedactions: 0, charactersRemoved: 0 },
    payloadHash: allowed && options.digest !== undefined ? options.digest(redacted.text) : null,
  };
}

/**
 * What would be sent, whether or not it may be.
 *
 * The preview is mandatory rather than advisory because pattern redaction
 * cannot catch a client's name in a sentence. The user reading the actual
 * bytes is the only real mitigation for that class, so this deliberately works
 * even when the request would be refused — seeing what *would* leave is how
 * somebody decides whether to allow it.
 */
export function preview(request: EgressRequest): {
  readonly payload: string;
  readonly redaction: RedactionReport;
} {
  const joined = request.items
    .map((item) => `[${item.kind} ${item.id}]\n${item.text}`)
    .join('\n\n');
  const redacted = redact(joined);
  return { payload: redacted.text, redaction: redacted.report };
}
