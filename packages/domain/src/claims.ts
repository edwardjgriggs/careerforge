import type { EvidenceClass } from './evidence.js';
import type { Remedy } from './refusal.js';
import type { AssetId, ClaimId, EnrichmentId, EvidenceId, WorkUnitId } from './ids.js';

/**
 * Claims: the unit of accountability.
 *
 * An asset is not verified as a whole. Each assertion inside it carries its
 * own support, because a single sentence routinely mixes the well-evidenced
 * with the invented:
 *
 *   "Led implementation of Intune compliance policies for 50+ users,
 *    reducing support tickets by 30%."
 *
 *   implemented Intune policies  action  commits            solid
 *   led                          role    nothing            FABRICATION
 *   50+ users                    scope   user-confirmed     solid
 *   reduced tickets by 30%       metric  nothing            FABRICATION
 *
 * Asset-level provenance calls this bullet "supported by evidence 14, 22, 35"
 * and cannot see the two career-ending inventions inside it. Claim-level
 * provenance can. See ADR-0007.
 *
 * The rules below are pure functions with no notion of AI, prompts, or
 * providers. They are domain rules that happen to constrain a generator —
 * not a feature of one — and they are exhaustively tested long before any
 * provider exists.
 */

export const CLAIM_TYPES = ['action', 'scope', 'role', 'metric', 'outcome'] as const;

/**
 * What kind of assertion a claim makes.
 *
 * The taxonomy exists because failure modes differ by kind. `role` and
 * `metric` are the two that end careers when fabricated, and they carry
 * stricter requirements than the rest. Uniform rules would either block
 * harmless `action` claims or permit invented leadership.
 */
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const SUPPORT_STATES = ['supported', 'unsupported', 'contested'] as const;
export type SupportState = (typeof SUPPORT_STATES)[number];

/** Where a number in a claim came from. Never a model. */
export type MetricSource = 'derived' | 'user_confirmed';

/**
 * One node offered as support for a claim.
 *
 * A discriminated union rather than a bare id, because the rules turn on
 * *what kind* of thing is vouching for the claim. An enrichment and a
 * user-confirmed answer are both "linked records"; only one of them is a fact.
 */
export type SupportNode =
  | {
      readonly kind: 'evidence';
      readonly id: EvidenceId;
      readonly evidenceClass: EvidenceClass;
      /**
       * True when this evidence directly corroborates the claim's asserted
       * value — an attribute equal to the scope figure, for instance.
       *
       * Resolved by the caller because matching depends on the collector's
       * attribute schema, which the domain deliberately does not interpret.
       */
      readonly corroborating?: boolean;
    }
  | { readonly kind: 'work_unit'; readonly id: WorkUnitId }
  | { readonly kind: 'enrichment'; readonly id: EnrichmentId };

export interface Claim {
  readonly id: ClaimId;
  readonly assetId: AssetId;
  /** The assertion, exactly as it appears in the rendered asset. */
  readonly text: string;
  /** Character offsets into the asset's rendered text: [start, end). */
  readonly span: readonly [number, number];
  readonly claimType: ClaimType;
  readonly supportState: SupportState;
  readonly metricSource: MetricSource | null;
}

export type SupportFailureCode =
  | 'no_support'
  | 'interpretation_only'
  | 'role_requires_confirmation'
  | 'metric_requires_derived_or_confirmed'
  | 'scope_requires_corroborating_evidence'
  | 'outcome_requires_evidence';

export type SupportVerdict =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly code: SupportFailureCode;
      /** Plain sentence explaining what is missing. Surfaced to the user. */
      readonly reason: string;
      /**
       * What would make this claim recordable.
       *
       * Required, not optional. A refusal that does not name the next step
       * teaches the user nothing about their own evidence, and this is the
       * refusal they will meet most often. See `refusal.ts`.
       */
      readonly remedy: Remedy;
    };

const isEvidence = (node: SupportNode): node is Extract<SupportNode, { kind: 'evidence' }> =>
  node.kind === 'evidence';

/**
 * The single rule every claim type shares: AI interpretation alone can never
 * support a claim.
 *
 * An enrichment may accompany support and explain it. It may never *be* the
 * support. This is the mechanical form of "AI interprets, it does not
 * assert" (ADR-0002), and it is the reason a hallucinated bullet cannot be
 * produced rather than merely being caught later.
 */
export function isInterpretationOnly(support: readonly SupportNode[]): boolean {
  return support.length > 0 && support.every((node) => node.kind === 'enrichment');
}

/**
 * Whether a set of support nodes satisfies a claim of the given type.
 *
 * Returns a verdict rather than a boolean: when support is insufficient the
 * caller must emit a Gap, and the failure code says which question to ask.
 * "Refuse and ask" is the product's answer to missing information, so the
 * predicate has to carry enough to ask well.
 */
export function evaluateSupport(
  claimType: ClaimType,
  support: readonly SupportNode[],
): SupportVerdict {
  if (support.length === 0) {
    return {
      supported: false,
      code: 'no_support',
      reason: 'Nothing in the evidence supports this statement.',
      remedy: {
        kind: 'evidence',
        needs: 'imported',
        detail: 'Collect the work this describes, or group it into a work unit first.',
      },
    };
  }

  if (isInterpretationOnly(support)) {
    return {
      supported: false,
      code: 'interpretation_only',
      reason:
        'Only an AI interpretation supports this statement. Interpretation can explain evidence but cannot stand in for it.',
      remedy: {
        kind: 'evidence',
        needs: 'imported',
        detail: 'Cite the artifacts the interpretation was reading, not the interpretation.',
      },
    };
  }

  const evidence = support.filter(isEvidence);
  const hasWorkUnit = support.some((node) => node.kind === 'work_unit');
  const hasConfirmed = evidence.some((node) => node.evidenceClass === 'user_confirmed');

  switch (claimType) {
    case 'action':
      // The most permissive: doing the work is what collection observes.
      return evidence.length > 0 || hasWorkUnit
        ? { supported: true }
        : {
            supported: false,
            code: 'no_support',
            reason: 'No evidence or work unit records this action.',
            remedy: {
              kind: 'evidence',
              needs: 'imported',
              detail: 'Collect the commits or sessions where this happened.',
            },
          };

    case 'scope':
      // A number describing reach ("50+ users") needs evidence that actually
      // carries that value, not merely evidence that the work happened.
      return evidence.some((node) => node.corroborating === true)
        ? { supported: true }
        : {
            supported: false,
            code: 'scope_requires_corroborating_evidence',
            reason:
              'No evidence corroborates this scope. CareerForge will ask you to confirm it rather than estimate.',
            remedy: {
              kind: 'evidence',
              needs: 'corroborating',
              detail:
                'Cite evidence carrying the figure itself, or confirm the number and it becomes evidence you stand behind.',
            },
          };

    case 'role':
      // Never inferred. Three commits touching a shared config do not make
      // someone a lead, and a generator that decides otherwise has written
      // resume fraud on the user's behalf.
      return hasConfirmed
        ? { supported: true }
        : {
            supported: false,
            code: 'role_requires_confirmation',
            reason:
              'Leadership and responsibility cannot be inferred from activity. CareerForge will ask whether you led this work.',
            remedy: {
              kind: 'confirm',
              needs: 'user_confirmed',
              question: 'What was your role in this work? Did you lead it, or contribute to it?',
            },
          };

    case 'metric':
      // Either computed from evidence or confirmed by the person. A model
      // may never supply a number; that is the defining failure of every AI
      // resume tool currently shipping.
      return evidence.some(
        (node) => node.evidenceClass === 'derived' || node.evidenceClass === 'user_confirmed',
      )
        ? { supported: true }
        : {
            supported: false,
            code: 'metric_requires_derived_or_confirmed',
            reason:
              'Numbers must be computed from evidence or confirmed by you. CareerForge will ask rather than estimate.',
            remedy: {
              kind: 'confirm',
              needs: 'user_confirmed',
              question: 'Did this work produce a measurable result you can quote?',
            },
          };

    case 'outcome':
      // A specific factual assertion about a result, so it needs evidence.
      // A work unit is a grouping, not an observation of a result.
      return evidence.length > 0
        ? { supported: true }
        : {
            supported: false,
            code: 'outcome_requires_evidence',
            reason: 'No evidence records this outcome.',
            remedy: {
              kind: 'evidence',
              needs: 'imported',
              detail: 'Collect what shows the result — a merged change, a closed issue, a release.',
            },
          };
  }
}

/** Convenience wrapper for call sites that only need the boolean. */
export function isSupported(claimType: ClaimType, support: readonly SupportNode[]): boolean {
  return evaluateSupport(claimType, support).supported;
}

/**
 * Where a supported metric's number came from.
 *
 * Returns null when the claim is not a metric or is unsupported. Recorded on
 * the claim so the UI can say "derived from Git history" or "confirmed by
 * you" instead of presenting a bare figure.
 */
export function resolveMetricSource(
  claimType: ClaimType,
  support: readonly SupportNode[],
): MetricSource | null {
  if (claimType !== 'metric') return null;
  if (!isSupported(claimType, support)) return null;
  const evidence = support.filter(isEvidence);
  // Derived wins when both are present: a computed figure is reproducible,
  // whereas a remembered one is not.
  if (evidence.some((node) => node.evidenceClass === 'derived')) return 'derived';
  if (evidence.some((node) => node.evidenceClass === 'user_confirmed')) return 'user_confirmed';
  return null;
}
