/**
 * `@careerforge/enrich`
 *
 * Prompts, runs, and the record that makes a run reviewable.
 *
 * Everything an AI touches in CareerForge passes through here, and the package
 * is built around one commitment: **an AI output is a reviewable artifact, not
 * an authority.** Three things enforce it rather than express it.
 *
 *   A prompt is versioned and frozen (ADR-0023). The instrument that produced
 *   an interpretation stays recoverable, so the interpretation stays
 *   explicable after the code that produced it has moved on.
 *
 *   An interpretation cites its inputs or it is discarded (ADR-0024). A
 *   confident sentence about records the model was never shown does not reach
 *   the store.
 *
 *   An interpretation never supports a claim. That rule lives in the domain
 *   and the database (ADR-0020); this package cannot express a violation of it
 *   because nothing here writes evidence, claims, or support edges.
 *
 * The package holds no HTTP client and cannot acquire one (invariant I3). Its
 * only route to a provider is a `ProviderPort` that takes a `PolicyDecision`
 * rather than a payload, so a call that skips the consent gate is not
 * something a contributor has to remember to avoid — it is something they
 * cannot write down.
 */

export const PACKAGE_NAME = '@careerforge/enrich' as const;

export { canonicalise } from './canonical.js';

export {
  resolveTemplate,
  templateFor,
  templateHash,
  CURRENT_TEMPLATE,
  ENRICHABLE_TYPES,
  TEMPLATES,
  type PromptTemplate,
} from './templates.js';

export {
  isUnusable,
  validateResponse,
  REJECTION_REASONS,
  type Rejection,
  type RejectionReason,
  type ValidatedItem,
  type ValidatedResponse,
} from './response.js';

export {
  executeRun,
  fingerprintOf,
  inputHashOf,
  type CachedRun,
  type EnrichmentInput,
  type ExecuteOptions,
  type RunFingerprint,
  type RunOutcome,
  type RunRequest,
} from './run.js';

export {
  explainDifference,
  isReproducible,
  DIFFERENCE_DIMENSIONS,
  type ComparableRun,
  type DifferenceDimension,
  type RunDifference,
} from './diff.js';

export {
  createRecordedProvider,
  parseCassette,
  type Cassette,
  type CassetteEntry,
  type RecordedProviderOptions,
} from './recorded.js';
