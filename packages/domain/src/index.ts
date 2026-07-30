/**
 * `@careerforge/domain`
 *
 * The vocabulary of CareerForge, and the rules that govern it.
 *
 * This package is pure. It performs no I/O, imports no adapter, knows nothing
 * about SQL, HTTP, files, or AI, and cannot even see Node's types — invariant
 * I1 is enforced by the compiler and by lint (ADR-0005). Platform primitives
 * arrive as function parameters, never as imports (ADR-0012).
 *
 * That purity is not aesthetic. It is what lets the rule that matters most —
 * a claim may not be asserted without evidence — be tested exhaustively as a
 * pure function, long before any provider exists to break it.
 */

export const PACKAGE_NAME = '@careerforge/domain' as const;

// ── Platform seams ────────────────────────────────────────────────────────
export type { Brand, Clock, Digest, EntropySource, Platform } from './primitives.js';

// ── Identifiers ───────────────────────────────────────────────────────────
export {
  createUlidFactory,
  isUlid,
  toUlid,
  ulidTime,
  MAX_ULID_TIME,
  ULID_LENGTH,
  type AssetId,
  type ClaimId,
  type EnrichmentId,
  type EnrichmentRunId,
  type EvidenceId,
  type GapId,
  type PolicyDecisionId,
  type ProvenanceEdgeId,
  type TombstoneId,
  type Ulid,
  type UlidFactory,
  type WorkUnitId,
} from './ids.js';

// ── Time ──────────────────────────────────────────────────────────────────
export {
  compareInstants,
  coveringSpan,
  epochMillisOf,
  instantFromEpochMillis,
  isInstant,
  isOrderedSpan,
  toInstant,
  type Instant,
  type TimeSpan,
} from './time.js';

// ── Sensitivity ───────────────────────────────────────────────────────────
export {
  compareSensitivity,
  isPermittedAt,
  isSensitivity,
  maxSensitivity,
  sensitivityRank,
  SENSITIVITY_LEVELS,
  type Sensitivity,
} from './sensitivity.js';

// ── Identity and attribution ──────────────────────────────────────────────
export {
  isSelfAsserted,
  isThirdPartyAttestation,
  SELF,
  SELF_ATTRIBUTION,
  type Attribution,
  type Identity,
  type IdentityId,
} from './subject.js';

// ── Attributes ────────────────────────────────────────────────────────────
export {
  validateAttributes,
  ATTRIBUTE_TYPES,
  type AttributeIssue,
  type AttributeIssueCode,
  type AttributeMap,
  type AttributeSchema,
  type AttributeSpec,
  type AttributeType,
  type AttributeValidation,
  type AttributeValue,
} from './attributes.js';

// ── Identity derivation ───────────────────────────────────────────────────
export {
  canonicalContentInput,
  canonicalNaturalKeyInput,
  deriveContentHash,
  deriveNaturalKey,
  hasContentChanged,
  type ContentFingerprint,
} from './keys.js';

// ── Evidence ──────────────────────────────────────────────────────────────
export {
  correctionOf,
  isCurrent,
  isTombstoned,
  isUserConfirmed,
  EVIDENCE_CLASSES,
  EVIDENCE_SCHEMA_VERSION,
  type Evidence,
  type EvidenceClass,
  type EvidenceContext,
  type EvidenceDraft,
} from './evidence.js';

// ── Work units ────────────────────────────────────────────────────────────
export {
  deriveSensitivity,
  isRewritable,
  meetsThreshold,
  pinsUnit,
  MEMBER_ROLES,
  WORK_UNIT_SCHEMA_VERSION,
  type MemberAssigner,
  type MemberRole,
  type SubstanceSignals,
  type SubstanceThreshold,
  type WorkUnit,
  type WorkUnitMember,
} from './work-unit.js';

// ── Claims: the unit of accountability ────────────────────────────────────
export {
  evaluateSupport,
  isInterpretationOnly,
  isSupported,
  resolveMetricSource,
  CLAIM_TYPES,
  SUPPORT_STATES,
  type Claim,
  type ClaimType,
  type MetricSource,
  type SupportFailureCode,
  type SupportNode,
  type SupportState,
  type SupportVerdict,
} from './claims.js';

// ── Gaps ──────────────────────────────────────────────────────────────────
export {
  gapTypeForFailure,
  isAlreadyAnswered,
  isAskable,
  markAnswered,
  markAsked,
  markDeclined,
  GAP_STATUSES,
  GAP_TYPES,
  type Gap,
  type GapStatus,
  type GapType,
} from './gaps.js';

// ── Enrichment ────────────────────────────────────────────────────────────
export {
  isCacheHit,
  isStale,
  supersede,
  ENRICHMENT_TYPES,
  type Enrichment,
  type EnrichmentRun,
  type EnrichmentTargetKind,
  type EnrichmentType,
} from './enrichment.js';

// ── Provenance ────────────────────────────────────────────────────────────
export {
  isSupportingRelation,
  isWellFormed,
  supportEdgesFor,
  MAX_EXPLANATION_DEPTH,
  PROVENANCE_NODE_KINDS,
  PROVENANCE_RELATIONS,
  type ProvenanceEdge,
  type ProvenanceNodeKind,
  type ProvenanceRelation,
} from './provenance.js';

// ── Assets ────────────────────────────────────────────────────────────────
export {
  classifyEdit,
  isExportable,
  revisionOf,
  ASSET_TYPES,
  REVIEW_STATES,
  type Asset,
  type AssetType,
  type EditKind,
  type ReviewState,
  type StyleExemplar,
} from './assets.js';

// ── Tombstones ────────────────────────────────────────────────────────────
export {
  destroysContent,
  isReversible,
  suppressedIds,
  suppressesFromReads,
  TOMBSTONE_SCOPES,
  type Tombstone,
  type TombstoneScope,
} from './tombstone.js';
