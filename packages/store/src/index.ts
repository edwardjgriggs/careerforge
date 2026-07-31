/**
 * `@careerforge/store`
 *
 * SQLite is canonical (ADR-0003). This package is the only thing that talks
 * to it.
 *
 * Two guarantees are enforced below the code rather than by convention:
 * append-only writes, by trigger; and current-state reads, by view. A mistake
 * here fails loudly instead of quietly corrupting a decade of career history.
 */

export const PACKAGE_NAME = '@careerforge/store' as const;

export {
  openDatabase,
  closeDatabase,
  checkIntegrity,
  IN_MEMORY,
  type IntegrityResult,
  type OpenOptions,
  type OpenResult,
} from './database.js';

export {
  migrate,
  schemaVersion,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationFailedError,
  SchemaTooNewError,
  type Db,
  type Migration,
  type MigrationReport,
} from './migrations/index.js';

export { EvidenceStore, type EmitResult } from './evidence-store.js';

export { CursorStore } from './cursors.js';

export { WorkUnitStore, type GroupOptions, type GroupingReport } from './work-unit-store.js';

export {
  ProvenanceStore,
  MalformedEdgeError,
  UnsupportedClaimError,
  type ClaimDraft,
  type RecordedClaim,
  type SupportOffer,
} from './provenance-store.js';

export { ConsentStore, type StoredGrant } from './consent-store.js';

export {
  AssetStore,
  UnpublishableAssetError,
  type AssessedAsset,
  type RecordAssetInput,
  type RecordedAsset,
  type StoredAsset,
} from './asset-store.js';

export {
  EnrichmentStore,
  type RecordRunInput,
  type StoredEnrichment,
  type StoredRun,
} from './enrichment-store.js';

export {
  InterviewEngine,
  INTERVIEW_COLLECTOR_ID,
  QUESTION_TEMPLATES,
  type AnswerResult,
} from './interview.js';

export { BlobStore, hashToRef, isBlobRef, refToHash, type BlobRef } from './blobs.js';

export {
  canonicalJson,
  digestTree,
  exportStore,
  rebuildStore,
  ExportFormatTooNewError,
  EXPORT_FORMAT_VERSION,
  type ExportReport,
  type RebuildReport,
} from './export.js';

export {
  nodePlatform,
  deterministicPlatform,
  sha256,
  systemClock,
  systemEntropy,
} from './platform.js';
