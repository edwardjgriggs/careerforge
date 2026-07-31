/**
 * `@careerforge/ui`
 *
 * Evidence Explorer: the screen that answers two questions.
 *
 *   Why does CareerForge believe this?
 *   What evidence would make it stronger?
 *
 * Deliberately not a graph viewer. The provenance graph is the mechanism and a
 * bad interface — a node-and-edge view asks a person to learn the schema
 * before they can read their own résumé, and the thing they actually want to
 * know, *should I put this on a CV?*, is nowhere on it. So the traversal is
 * flattened into two lists a person reads in order, and the graph stays where
 * it belongs, underneath.
 *
 * The second question is what makes this more than a viewer. A screen showing
 * only the current state tells somebody their bullet is weak and leaves them
 * there. This one ranks what would change it, computes what each change would
 * be worth, and puts the question that would settle it directly on the page.
 *
 * The package may listen and may not send (ADR-0028). It binds `127.0.0.1` as
 * a constant, holds no provider and no HTTP client, and every path that could
 * put evidence on a wire lives in `policy`, in a different package.
 */

export const PACKAGE_NAME = '@careerforge/ui' as const;

export {
  createExplorerServer,
  handle,
  BIND_HOST,
  DEFAULT_PORT,
  type ExplorerServer,
  type ExplorerServerOptions,
} from './server.js';

export { readExplorerView, recordAnswer, openStores } from './reader.js';

export { renderPage } from './page.js';

export {
  escapeHtml,
  renderAsset,
  renderAssessment,
  renderClaimProof,
  renderEmptyState,
  renderImprovements,
  renderQuestions,
  renderStatement,
} from './render.js';

export {
  compareGrounds,
  CLASS_LABELS,
  GRADE_COPY,
  type AssetView,
  type ClaimView,
  type ExplorerView,
  type GroundView,
  type QuestionView,
  type UnitView,
} from './view-model.js';
