import { validateAttributes } from '@careerforge/domain';
import type { CursorStore, EvidenceStore } from '@careerforge/store';

import type { CollectionReport, CollectorPort, Cursor, Scope } from './port.js';

/**
 * The collector host.
 *
 * Deliberately small. It drives a collector, persists what comes back, tallies
 * a report, and saves the cursor. It has no plugin registry, no scheduling, no
 * retry policy, and no configuration language — none of which anything needs
 * yet, and all of which would be designed against imagined collectors rather
 * than real ones.
 *
 * Out-of-process plugins arrive later (ADR-0008). When they do they implement
 * the same `CollectorPort` and are driven by this same loop; only the
 * transport changes.
 */

export interface CollectionOptions {
  readonly collector: CollectorPort;
  readonly scope: Scope;
  readonly store: EvidenceStore;
  readonly cursors: CursorStore;
  /** Ignore the stored cursor and replay everything. */
  readonly backfill?: boolean;
  /** Stop after this many drafts. Used by `--limit`, and by tests. */
  readonly limit?: number;
  /** Called after each emitted draft, for progress reporting. */
  readonly onProgress?: (emitted: number) => void;
}

/**
 * Run one collector over one scope.
 *
 * The cursor is saved only after the loop completes. An interrupted run
 * therefore re-reads some records next time, and re-reading is free because
 * emission is idempotent — the same artifact in the same state is a no-op.
 * Saving eagerly would be the opposite trade: faster resumes, and a gap in the
 * record every time a run was killed.
 */
export async function runCollection(options: CollectionOptions): Promise<CollectionReport> {
  const manifest = options.collector.describe();
  const declaredKinds = new Set(manifest.kinds);

  const startingCursor =
    options.backfill === true ? null : options.cursors.read(manifest.id, options.scope.key);
  let latestCursor: Cursor | null = startingCursor;

  let seen = 0;
  let emitted = 0;
  let inserted = 0;
  let superseded = 0;
  let unchanged = 0;
  const skipped: Record<string, number> = {};
  const unknownRecordTypes: Record<string, number> = {};
  const drift: Record<string, number> = {};

  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for await (const event of options.collector.collect(options.scope, startingCursor)) {
    if (event.kind === 'cursor') {
      latestCursor = event.cursor;
      continue;
    }

    // Not counted in `seen`: drift is an observation about the format, not
    // about an artifact, and the artifact it was noticed on is already
    // counted. See ADR-0016.
    if (event.kind === 'drift') {
      drift[event.signal] = (drift[event.signal] ?? 0) + 1;
      continue;
    }

    seen++;

    if (event.kind === 'skipped') {
      skip(event.reason);
      continue;
    }

    if (event.kind === 'unknown') {
      unknownRecordTypes[event.recordType] = (unknownRecordTypes[event.recordType] ?? 0) + 1;
      continue;
    }

    const { draft } = event;

    // Manifest honesty, checked rather than trusted. A collector emitting a
    // kind it never declared has a manifest that has stopped describing
    // reality, and the plugin index depends on manifests being true.
    if (!declaredKinds.has(draft.kind)) {
      skip(`undeclared kind: ${draft.kind}`);
      continue;
    }

    const attributes = validateAttributes(manifest.attributeSchema, draft.attributes);
    if (!attributes.valid) {
      skip(`invalid attributes: ${attributes.issues[0]?.code ?? 'unknown'}`);
      continue;
    }

    const result = options.store.emit(draft);
    emitted++;
    if (!result.inserted) unchanged++;
    else if (result.superseded !== null) superseded++;
    else inserted++;

    options.onProgress?.(emitted);

    if (options.limit !== undefined && emitted >= options.limit) break;
  }

  if (latestCursor !== null && latestCursor !== startingCursor) {
    options.cursors.advance(manifest.id, options.scope.key, latestCursor);
  }

  return {
    collectorId: manifest.id,
    scopeKey: options.scope.key,
    seen,
    emitted,
    inserted,
    superseded,
    unchanged,
    skipped,
    unknownRecordTypes,
    drift,
    cursor: latestCursor,
  };
}
