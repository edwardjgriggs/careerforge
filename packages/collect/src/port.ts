import type { AttributeSchema, EvidenceDraft, Sensitivity } from '@careerforge/domain';

/**
 * The collector contract.
 *
 * A collector has one job: turn a source into Evidence. It has no store
 * handle, cannot write, cannot classify around policy, and cannot decide what
 * a Work Unit is. It emits, and the core does the rest — invariant I6, held by
 * the shape of this interface rather than by discipline.
 *
 * Writing one should not require understanding the rest of CareerForge. If it
 * does, that is a bug in this file.
 */

/** What to collect from. `key` identifies it for cursor storage. */
export interface Scope {
  /** Stable across runs. Cursors are stored per (collector, scope key). */
  readonly key: string;
  /** A path or URI the collector understands. The core never parses it. */
  readonly location: string;
}

export interface SourceRef {
  readonly scope: Scope;
  /** Shown to the user when choosing what to collect. */
  readonly label: string;
}

/** Opaque to the core. Only the collector that wrote one knows what it means. */
export type Cursor = string;

/**
 * What a collector yields.
 *
 * `Architecture.md` §6.1 specifies evidence drafts and cursor advances. The
 * `skipped` and `unknown` events are how §6.3's CollectionReport gets its
 * numbers: tolerant parsing (ADR-0010) is only safe if what was skipped is
 * counted, because silent tolerance is silent data loss.
 */
export type CollectorEvent =
  | { readonly kind: 'evidence'; readonly draft: EvidenceDraft }
  | { readonly kind: 'cursor'; readonly cursor: Cursor }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly recordType: string };

export interface CollectorCapabilities {
  /** Can replay history. Every collector must: backfill is the acquisition model. */
  readonly backfill: boolean;
  /** Can resume from a cursor. */
  readonly incremental: boolean;
  /** Can watch for changes. Declared now, unused until much later. */
  readonly watch: boolean;
}

export interface CollectorManifest {
  /** Stable namespace. Prefixes every `kind` this collector emits. */
  readonly id: string;
  readonly version: string;
  readonly description: string;
  /** Evidence kinds emitted, each namespaced by `id`. */
  readonly kinds: readonly string[];
  readonly attributeSchema: AttributeSchema;
  readonly capabilities: CollectorCapabilities;
  readonly defaultSensitivity: Sensitivity;
  /**
   * The narrow set of source fields this collector genuinely depends on.
   *
   * Declaring it is half of tolerant parsing (ADR-0010): anything outside this
   * set is ignored, whatever the upstream format does next.
   */
  readonly requiredFields: readonly string[];
}

export interface CollectorPort {
  describe(): CollectorManifest;
  /** Find what could be collected under a location. */
  discover(location: string): Promise<readonly SourceRef[]>;
  /**
   * Emit evidence for a scope.
   *
   * `cursor === null` means backfill: replay everything visible. Every
   * collector must implement it — a collector that can only watch the present
   * is incomplete and fails its contract test.
   */
  collect(scope: Scope, cursor: Cursor | null): AsyncIterable<CollectorEvent>;
}

/**
 * What happened during a run.
 *
 * Skip trends are how format drift is detected before users report missing
 * evidence, which is what makes tolerant parsing responsible rather than
 * merely convenient.
 */
export interface CollectionReport {
  readonly collectorId: string;
  readonly scopeKey: string;
  /** Source records the collector looked at. */
  readonly seen: number;
  /** Drafts emitted. */
  readonly emitted: number;
  /** Drafts that became new evidence rows. */
  readonly inserted: number;
  /** Drafts that corrected an earlier record. */
  readonly superseded: number;
  /** Drafts already on record — the normal case on a re-run. */
  readonly unchanged: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly unknownRecordTypes: Readonly<Record<string, number>>;
  readonly cursor: Cursor | null;
}

export function totalSkipped(report: CollectionReport): number {
  return Object.values(report.skipped).reduce((sum, n) => sum + n, 0);
}

export function formatReport(report: CollectionReport): string {
  const lines = [
    `${report.collectorId} · ${report.scopeKey}`,
    `  seen ${report.seen}, emitted ${report.emitted}`,
    `  new ${report.inserted}, corrected ${report.superseded}, unchanged ${report.unchanged}`,
  ];

  const skipped = totalSkipped(report);
  if (skipped > 0) {
    lines.push(`  skipped ${skipped}:`);
    for (const [reason, count] of Object.entries(report.skipped).sort()) {
      lines.push(`    ${count} ${reason}`);
    }
  }

  const unknown = Object.entries(report.unknownRecordTypes).sort();
  if (unknown.length > 0) {
    lines.push(
      `  unrecognised record types (ignored): ${unknown.map(([t, n]) => `${t} x${n}`).join(', ')}`,
    );
  }

  return lines.join('\n');
}
