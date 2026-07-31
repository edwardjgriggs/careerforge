/**
 * `@careerforge/generate`
 *
 * Turning a work unit into a claim somebody could be asked about.
 *
 * The package exists to enforce one ordering. A model proposes typed, cited
 * assertions; each faces the support predicate the domain has held since M1;
 * whatever fails becomes a question rather than a softer sentence; and only
 * then is the bullet composed, from what survived.
 *
 * Composing last is what makes the guarantee mechanical instead of diligent.
 * A generator that writes prose and then removes the claims it cannot support
 * is doing surgery on its own output and will one day miss. Here a failed
 * claim's words are never placed, so there is nothing to miss.
 *
 * Like `enrich`, this package cannot import the store or a database driver.
 * It produces a description of what should be recorded and hands it back.
 */

export const PACKAGE_NAME = '@careerforge/generate' as const;

export {
  generateBullet,
  isPublishable,
  type DroppedClaim,
  type GeneratedBullet,
  type GenerateOptions,
  type ProposedClaim,
  type SupportedClaim,
} from './bullet.js';

export {
  renderBullet,
  spansAreExact,
  type PlacedClaim,
  type RenderableClaim,
  type RenderedBullet,
} from './render.js';

export {
  assertedFigures,
  corroboratesFigures,
  recordsOutcome,
  resolveSupport,
  OUTCOME_KINDS,
  type CandidateRecord,
  type ResolvedSupport,
} from './support.js';
