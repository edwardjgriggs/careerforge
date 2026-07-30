import {
  canonicalAttributes,
  createUlidFactory,
  deriveContentHash,
  deriveNaturalKey,
  toInstant,
  type AttributeMap,
  type Evidence,
  type EvidenceClass,
  type EvidenceDraft,
  type EvidenceId,
  type Instant,
  type Platform,
  type Sensitivity,
  type Tombstone,
  type TombstoneId,
  type TombstoneScope,
  type UlidFactory,
} from '@careerforge/domain';

import type { Db } from './migrations/index.js';

/**
 * Persistence for evidence.
 *
 * Two rules shape every method here:
 *
 *   Nothing is ever mutated. Corrections supersede, deletions tombstone.
 *   Nothing is read from a base table. `evidence_current` is the read surface.
 *
 * Both are enforced below the code — by triggers and by the view — so a
 * mistake here fails loudly rather than quietly corrupting a decade of
 * someone's career history.
 */

export interface EmitResult {
  readonly evidence: Evidence;
  /** False when an identical artifact was already stored. */
  readonly inserted: boolean;
  /** Set when this insert corrected an earlier record. */
  readonly superseded: EvidenceId | null;
}

interface EvidenceRow {
  id: string;
  schema_version: number;
  collector_id: string;
  source_uri: string;
  natural_key: string;
  content_hash: string;
  kind: string;
  evidence_class: string;
  sensitivity: string;
  subject_id: string;
  asserted_by: string;
  occurred_at: string;
  occurred_end: string | null;
  recorded_at: string;
  project_key: string | null;
  workspace: string | null;
  stream: string | null;
  grouping_hint: string | null;
  supersedes: string | null;
  collector_version: string;
  source_format_version: string | null;
  title: string | null;
  summary: string | null;
  excerpt: string | null;
  payload_ref: string | null;
  attributes: string | null;
  content_destroyed: number;
}

const SELECT_CURRENT = `SELECT * FROM evidence_current`;

/**
 * Every record ever written, current or not, joined to its content.
 *
 * Used only where history genuinely matters: idempotency checks and lineage.
 * Ordinary reads go through `evidence_current` (ADR-0013), and the `e.`
 * prefix is what stops this being pasted into one by accident.
 */
const SELECT_ANY = `
  SELECT e.*, c.title, c.summary, c.excerpt, c.payload_ref, c.attributes,
         CASE WHEN c.evidence_id IS NULL THEN 1 ELSE 0 END AS content_destroyed
  FROM evidence e
  LEFT JOIN evidence_content c ON c.evidence_id = e.id`;

function toEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id as EvidenceId,
    schemaVersion: row.schema_version,
    collectorId: row.collector_id,
    sourceUri: row.source_uri,
    naturalKey: row.natural_key,
    contentHash: row.content_hash,
    kind: row.kind,
    evidenceClass: row.evidence_class as EvidenceClass,
    sensitivity: row.sensitivity as Sensitivity,
    attribution: {
      subjectId: row.subject_id as Evidence['attribution']['subjectId'],
      assertedBy: row.asserted_by as Evidence['attribution']['assertedBy'],
    },
    occurredAt: row.occurred_at as Instant,
    occurredEnd: row.occurred_end as Instant | null,
    recordedAt: row.recorded_at as Instant,
    context: {
      projectKey: row.project_key,
      workspace: row.workspace,
      stream: row.stream,
    },
    // Content may legitimately be gone: redaction and purge delete the
    // content row while the spine survives (ADR-0015).
    title: row.title ?? '',
    summary: row.summary,
    excerpt: row.excerpt,
    payloadRef: row.payload_ref,
    attributes:
      row.attributes === null || row.attributes === undefined
        ? {}
        : (JSON.parse(row.attributes) as AttributeMap),
    groupingHint: row.grouping_hint,
    supersedes: row.supersedes as EvidenceId | null,
    collectorVersion: row.collector_version,
    sourceFormatVersion: row.source_format_version,
  };
}

export class EvidenceStore {
  private readonly nextId: UlidFactory;

  constructor(
    private readonly db: Db,
    private readonly platform: Platform,
  ) {
    this.nextId = createUlidFactory(platform.clock, platform.entropy);
  }

  /**
   * Store a collected artifact.
   *
   * Idempotent by construction. The natural key identifies the artifact and
   * the content hash identifies its state, so:
   *
   *   same key, same content  -> no-op
   *   same key, new content   -> a new row superseding the old one
   *   new key                 -> a new row
   *
   * Without this, a backfill overlapping an incremental run would duplicate
   * the user's entire history.
   */
  emit(draft: EvidenceDraft): EmitResult {
    const naturalKey = deriveNaturalKey(this.platform.digest, draft.collectorId, draft.sourceUri);
    const contentHash = deriveContentHash(this.platform.digest, {
      title: draft.title,
      summary: draft.summary,
      excerpt: draft.excerpt,
      attributes: draft.attributes,
    });

    const write = this.db.transaction((): EmitResult => {
      // Have we recorded this exact state of this exact artifact before —
      // current, superseded, or suppressed?
      //
      // This single check is what makes collection convergent. A backfill
      // overlapping an incremental run, a resumed job replaying what it
      // already emitted, a second device collecting the same repository: all
      // of them re-present states already on record, in an order nobody
      // controls. Recognising a seen state makes every one of them a no-op,
      // so repetition and ordering cannot drift the store.
      //
      // It also means a suppressed record is never resurrected by
      // re-collection, and that a collector flipping a value back and forth
      // cannot violate the unique constraint.
      const seen = this.db
        .prepare(`${SELECT_ANY} WHERE e.natural_key = ? AND e.content_hash = ?`)
        .get(naturalKey, contentHash) as EvidenceRow | undefined;

      if (seen !== undefined) {
        return { evidence: toEvidence(seen), inserted: false, superseded: null };
      }

      // Genuinely new content for this artifact. Supersede whatever is
      // current, if anything still is.
      const existing = this.db
        .prepare(`SELECT * FROM evidence_current WHERE natural_key = ? ORDER BY id DESC LIMIT 1`)
        .get(naturalKey) as EvidenceRow | undefined;

      const id = this.nextId() as string as EvidenceId;
      const recordedAt = toInstant(new Date(this.platform.clock()).toISOString());
      const supersedes = existing === undefined ? null : (existing.id as EvidenceId);

      this.db
        .prepare(
          `INSERT INTO evidence (
             id, schema_version, collector_id, source_uri, natural_key, content_hash,
             kind, evidence_class, sensitivity, subject_id, asserted_by,
             occurred_at, occurred_end, recorded_at,
             project_key, workspace, stream, grouping_hint, supersedes,
             collector_version, source_format_version
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          1,
          draft.collectorId,
          draft.sourceUri,
          naturalKey,
          contentHash,
          draft.kind,
          draft.evidenceClass,
          draft.sensitivity,
          'self',
          'self',
          draft.occurredAt,
          draft.occurredEnd,
          recordedAt,
          draft.context.projectKey,
          draft.context.workspace,
          draft.context.stream,
          draft.groupingHint,
          supersedes,
          draft.collectorVersion,
          draft.sourceFormatVersion,
        );

      this.db
        .prepare(
          `INSERT INTO evidence_content (evidence_id, title, summary, excerpt, payload_ref, attributes)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          id,
          draft.title,
          draft.summary,
          draft.excerpt,
          draft.payloadRef,
          // Stored canonically so the representation matches the hash: two
          // collectors that build the same object differently must not
          // produce order-dependent stored state. See canonicalAttributes.
          JSON.stringify(canonicalAttributes(draft.attributes)),
        );

      this.db
        .prepare(`INSERT INTO evidence_fts (evidence_id, title, summary, excerpt) VALUES (?,?,?,?)`)
        .run(id, draft.title, draft.summary ?? '', draft.excerpt ?? '');

      const stored = this.db.prepare(`${SELECT_CURRENT} WHERE id = ?`).get(id) as EvidenceRow;
      return { evidence: toEvidence(stored), inserted: true, superseded: supersedes };
    });

    return write();
  }

  /** Current evidence, newest first. The only supported read surface. */
  all(): readonly Evidence[] {
    const rows = this.db
      .prepare(`${SELECT_CURRENT} ORDER BY occurred_at DESC, id DESC`)
      .all() as EvidenceRow[];
    return rows.map(toEvidence);
  }

  byId(id: EvidenceId): Evidence | null {
    const row = this.db.prepare(`${SELECT_CURRENT} WHERE id = ?`).get(id) as
      EvidenceRow | undefined;
    return row === undefined ? null : toEvidence(row);
  }

  byNaturalKey(naturalKey: string): Evidence | null {
    const row = this.db.prepare(`${SELECT_CURRENT} WHERE natural_key = ?`).get(naturalKey) as
      EvidenceRow | undefined;
    return row === undefined ? null : toEvidence(row);
  }

  /** Full-text search. Works with no API key and no network (ADR-0005). */
  search(query: string, limit = 50): readonly Evidence[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM evidence_fts f
         JOIN evidence_current c ON c.id = f.evidence_id
         WHERE evidence_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as EvidenceRow[];
    return rows.map(toEvidence);
  }

  /** Every record ever written, including superseded and suppressed ones. */
  history(naturalKey: string): readonly Evidence[] {
    const rows = this.db
      .prepare(`${SELECT_ANY} WHERE e.natural_key = ? ORDER BY e.id ASC`)
      .all(naturalKey) as EvidenceRow[];
    return rows.map(toEvidence);
  }

  /**
   * Current evidence within a window, oldest first.
   *
   * Filtered on `occurredAt` — when the work happened — never `recordedAt`.
   * "What did I do last quarter" is a question about the work, and backfill
   * makes the two differ by years.
   */
  between(
    options: { readonly from?: Instant; readonly to?: Instant; readonly limit?: number } = {},
  ): readonly Evidence[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.from !== undefined) {
      clauses.push('occurred_at >= ?');
      params.push(options.from);
    }
    if (options.to !== undefined) {
      clauses.push('occurred_at <= ?');
      params.push(options.to);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    params.push(options.limit ?? 500);

    const rows = this.db
      .prepare(`${SELECT_CURRENT}${where} ORDER BY occurred_at ASC, id ASC LIMIT ?`)
      .all(...params) as EvidenceRow[];
    return rows.map(toEvidence);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM evidence_current`).get() as {
      n: number;
    };
    return row.n;
  }

  /**
   * Suppress a record.
   *
   * `hidden` keeps the bytes and is reversible. `redacted` and `purged`
   * destroy the content row, which is permitted precisely because content
   * lives apart from the immutable spine (ADR-0015). The tombstone always
   * survives, so provenance stays explicable rather than dangling.
   */
  tombstone(targetId: EvidenceId, scope: TombstoneScope, reason: string | null = null): Tombstone {
    const write = this.db.transaction((): Tombstone => {
      const id = this.nextId() as string as TombstoneId;
      const recordedAt = toInstant(new Date(this.platform.clock()).toISOString());

      this.db
        .prepare(
          `INSERT INTO tombstones (id, target_kind, target_id, reason, scope, recorded_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(id, 'evidence', targetId, reason, scope, recordedAt);

      if (scope !== 'hidden') {
        this.db.prepare(`DELETE FROM evidence_content WHERE evidence_id = ?`).run(targetId);
        this.db.prepare(`DELETE FROM evidence_fts WHERE evidence_id = ?`).run(targetId);
      }

      return { id, targetKind: 'evidence', targetId, reason, scope, recordedAt };
    });

    return write();
  }

  /** Rebuild the derived search index from base tables. */
  reindex(): number {
    const rebuild = this.db.transaction((): number => {
      this.db.prepare(`DELETE FROM evidence_fts`).run();
      const inserted = this.db
        .prepare(
          `INSERT INTO evidence_fts (evidence_id, title, summary, excerpt)
           SELECT evidence_id, title, COALESCE(summary,''), COALESCE(excerpt,'')
           FROM evidence_content`,
        )
        .run();
      return inserted.changes;
    });
    return rebuild();
  }
}
