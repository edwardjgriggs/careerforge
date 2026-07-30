/**
 * `@careerforge/policy`
 *
 * Consent, sensitivity resolution, deterministic redaction, and the single
 * egress choke point.
 *
 * This is the only package permitted to hold an HTTP client (invariant I3,
 * enforced by lint). It ships before any provider exists, so there is never a
 * window in which egress is possible without enforcement.
 *
 * Every refusal names the rule that decided and the change that would permit
 * the action. A user told only "blocked" learns nothing and turns the feature
 * off; a user told which promise is being kept, and how to allow it for this
 * project, is being taught something true about their own data.
 */

export const PACKAGE_NAME = '@careerforge/policy' as const;

export {
  evaluate,
  preview,
  POLICY_RULES,
  type ConsentGrant,
  type ConsentLookup,
  type EgressRequest,
  type EvaluateOptions,
  type PayloadItem,
  type PolicyDecision,
  type PolicyRuleId,
  type Provider,
  type ProviderLocality,
} from './engine.js';

export {
  hasResidualSecrets,
  redact,
  DEFAULT_RULES,
  REDACTION_PROFILE,
  type Redacted,
  type RedactionFinding,
  type RedactionReport,
  type RedactionRule,
} from './redaction.js';
