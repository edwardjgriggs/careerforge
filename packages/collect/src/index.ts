/**
 * `@careerforge/collect`
 *
 * The collector contract and the host that drives it.
 *
 * A collector turns a source into Evidence. It has no store handle, cannot
 * write, and cannot decide what a Work Unit is — invariant I6, held by the
 * shape of the interface rather than by discipline.
 *
 * `describeConformance` is the contract every collector is held to, in-tree or
 * third-party. Import it, point it at your collector, and if it passes, your
 * collector works.
 */

export const PACKAGE_NAME = '@careerforge/collect' as const;

export {
  formatReport,
  totalSkipped,
  type CollectionReport,
  type CollectorCapabilities,
  type CollectorEvent,
  type CollectorManifest,
  type CollectorPort,
  type Cursor,
  type Scope,
  type SourceRef,
} from './port.js';

export { runCollection, type CollectionOptions } from './host.js';

export { isoWeek } from './buckets.js';

export { describeConformance, type ConformanceSubject, type TestHooks } from './conformance.js';
