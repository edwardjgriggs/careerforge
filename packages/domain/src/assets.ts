import type { AssetId, EnrichmentRunId, WorkUnitId } from './ids.js';
import type { Instant } from './time.js';

/**
 * Assets: generated views, not stored facts.
 *
 * An asset row is a *generation record* — reproducible from its provenance,
 * carrying its inputs, never a source of truth. Deleting every asset loses
 * nothing but compute. See `Vision.md` §1.
 */

export const ASSET_TYPES = [
  'resume_bullet',
  'star_story',
  'portfolio_entry',
  'interview_answer',
  'review_summary',
  'cover_letter_section',
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

/**
 * What a person has decided about an asset.
 *
 * `rejected` rather than `exported`: exporting is an act, not a judgement, and
 * a state meaning "already left" cannot answer the question the gate actually
 * asks. Rejection is a real review outcome and needs somewhere to live —
 * without it, disagreeing with a draft would mean deleting it, and the store
 * does not delete.
 *
 * These three matched the database schema all along; the domain listed
 * `exported` and the mismatch was invisible because nothing had yet written an
 * asset row. See `isExportable` for why that combination was dangerous.
 */
export const REVIEW_STATES = ['draft', 'reviewed', 'rejected'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export interface Asset {
  readonly id: AssetId;
  readonly assetType: AssetType;
  readonly workUnitId: WorkUnitId;
  readonly runId: EnrichmentRunId | null;
  readonly renderedText: string;
  readonly reviewState: ReviewState;
  /** The prior asset this revises. Set when a user edits. */
  readonly revisionOf: AssetId | null;
  readonly editedBy: 'user' | null;
  readonly recordedAt: Instant;
}

/**
 * Whether an asset may leave CareerForge.
 *
 * The gate lives in the export path rather than the UI, so a CLI user, a
 * scripted run, and a future desktop app all inherit it. Anything leaving as
 * a professional artifact has been seen by a human — that is the whole of
 * "humans approve professional claims".
 *
 * An allowlist, deliberately. This was written as `!== 'draft'` while the
 * domain listed three states that happened to make that correct, and the
 * database permitted a fourth — `rejected` — that the denylist would have
 * waved straight through. An asset a person read and turned down is the last
 * thing that should reach a résumé. A denylist is one added state away from
 * being wrong, and it will be wrong silently.
 */
export function isExportable(asset: Pick<Asset, 'reviewState'>): boolean {
  return asset.reviewState === 'reviewed';
}

/** A user edit creates a new asset. The original is never overwritten. */
export function revisionOf(
  original: Asset,
  renderedText: string,
  minted: { readonly id: AssetId; readonly recordedAt: Instant },
): Asset {
  return {
    ...original,
    id: minted.id,
    renderedText,
    reviewState: 'reviewed',
    revisionOf: original.id,
    editedBy: 'user',
    recordedAt: minted.recordedAt,
  };
}

export type EditKind = 'wording' | 'factual';

/**
 * Whether an edit changed the wording or the assertions.
 *
 * A wording change is a style exemplar and teaches future phrasing. A change
 * to the claim set is a factual disagreement and belongs in the interview
 * engine instead — treating the two alike would let the style loop quietly
 * learn to assert things the evidence never supported.
 */
export function classifyEdit(before: readonly string[], after: readonly string[]): EditKind {
  if (before.length !== after.length) return 'factual';
  const normalise = (claims: readonly string[]) => [...claims].sort();
  const a = normalise(before);
  const b = normalise(after);
  return a.every((claim, index) => claim === b[index]) ? 'wording' : 'factual';
}

/**
 * A recorded before/after pair used as a few-shot example.
 *
 * Exemplars teach phrasing, never facts. They never modify evidence and never
 * leave the machine except under the same policy gate as any other egress.
 */
export interface StyleExemplar {
  readonly assetType: AssetType;
  readonly before: string;
  readonly after: string;
  readonly recordedAt: Instant;
}
