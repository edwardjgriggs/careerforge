import {
  classify,
  createUlidFactory,
  evaluateSupport,
  explainClaim,
  gapTypeForFailure,
  instantFromEpochMillis,
  isWellFormed,
  toInstant,
  type ClaimType,
  type EvidenceClass,
  type Explanation,
  type ExplanationGap,
  type Gap,
  type GapStatus,
  type GapType,
  type Instant,
  type NodeDescription,
  type Platform,
  type ProvenanceEdge,
  type ProvenanceLookup,
  type ProvenanceNodeKind,
  type ProvenanceRelation,
  type SupportNode,
  type UlidFactory,
} from '@careerforge/domain';

import type { Db } from './migrations/index.js';

/**
 * The provenance graph, and the claims and gaps that hang off it.
 *
 * Two guarantees are enforced here rather than hoped for:
 *
 *   A claim cannot be written without support that satisfies its type.
 *   An enrichment cannot be written as support for anything.
 *
 * Both fail loudly. A claim that slipped through unsupported would be a
 * sentence on somebody's résumé that nothing in their history backs up, which
 * is the exact failure this product exists to make impossible.
 */

/** A claim was offered with support that does not satisfy its type. */
export class UnsupportedClaimError extends Error {
  constructor(
    readonly claimType: ClaimType,
    readonly code: string,
    reason: string,
  ) {
    super(`Refusing to record a ${claimType} claim: ${reason}`);
    this.name = 'UnsupportedClaimError';
  }
}

/** An edge was offered that the graph is not allowed to express. */
export class MalformedEdgeError extends Error {
  constructor(relation: ProvenanceRelation, from: string, to: string) {
    super(`Refusing a ${relation} edge from ${from} to ${to}: it would make the graph unreadable.`);
    this.name = 'MalformedEdgeError';
  }
}

export interface ClaimDraft {
  readonly assetId: string;
  readonly text: string;
  readonly span: readonly [number, number];
  readonly claimType: ClaimType;
}

/** One record offered as support, with what only the caller can know. */
export interface SupportOffer {
  readonly kind: 'evidence' | 'work_unit';
  readonly id: string;
  /** The evidence carries the claim's asserted value, not just the activity. */
  readonly corroborating?: boolean;
}

export interface RecordedClaim {
  readonly id: string;
  readonly supportState: 'supported';
  readonly metricSource: 'derived' | 'user_confirmed' | null;
}

interface EdgeRow {
  id: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  relation: string;
  weight: number | null;
  corroborating: number;
  recorded_at: string;
}

function toEdge(row: EdgeRow): ProvenanceEdge {
  return {
    id: row.id as ProvenanceEdge['id'],
    fromKind: row.from_kind as ProvenanceNodeKind,
    fromId: row.from_id,
    toKind: row.to_kind as ProvenanceNodeKind,
    toId: row.to_id,
    relation: row.relation as ProvenanceRelation,
    weight: row.weight,
    corroborating: row.corroborating === 1,
    recordedAt: toInstant(row.recorded_at),
  };
}

export class ProvenanceStore implements ProvenanceLookup {
  private readonly nextId: UlidFactory;

  constructor(
    private readonly db: Db,
    private readonly platform: Platform,
  ) {
    this.nextId = createUlidFactory(platform.clock, platform.entropy);
  }

  private now(): Instant {
    return instantFromEpochMillis(this.platform.clock());
  }

  // ── The graph ───────────────────────────────────────────────────────────

  link(
    from: { kind: ProvenanceNodeKind; id: string },
    relation: ProvenanceRelation,
    to: { kind: ProvenanceNodeKind; id: string },
    options: { weight?: number; corroborating?: boolean } = {},
  ): string {
    const id = this.nextId() as string;
    const edge: ProvenanceEdge = {
      id: id as ProvenanceEdge['id'],
      fromKind: from.kind,
      fromId: from.id,
      toKind: to.kind,
      toId: to.id,
      relation,
      weight: options.weight ?? null,
      corroborating: options.corroborating === true,
      recordedAt: this.now(),
    };

    if (!isWellFormed(edge)) {
      throw new MalformedEdgeError(relation, `${from.kind}:${from.id}`, `${to.kind}:${to.id}`);
    }

    this.db
      .prepare(
        `INSERT INTO provenance_edges
           (id, from_kind, from_id, to_kind, to_id, relation, weight, corroborating, recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        edge.fromKind,
        edge.fromId,
        edge.toKind,
        edge.toId,
        edge.relation,
        edge.weight,
        edge.corroborating ? 1 : 0,
        edge.recordedAt,
      );
    return id;
  }

  incoming(kind: ProvenanceNodeKind, id: string): readonly ProvenanceEdge[] {
    const rows = this.db
      .prepare(`SELECT * FROM provenance_edges WHERE to_kind = ? AND to_id = ? ORDER BY id`)
      .all(kind, id) as EdgeRow[];
    const stored = rows.map(toEdge);
    if (kind !== 'work_unit') return stored;

    // Membership already lives in `work_unit_members`, with its own role and
    // confidence. Writing it a second time as edges would give the same fact
    // two homes that could disagree, so `grouped_into` is derived by join —
    // the same choice ADR-0013 made for suppression, for the same reason.
    return [...stored, ...this.membershipEdges(id)];
  }

  private membershipEdges(workUnitId: string): readonly ProvenanceEdge[] {
    const rows = this.db
      .prepare(
        `SELECT evidence_id, recorded_at FROM work_unit_members
         WHERE work_unit_id = ? ORDER BY evidence_id`,
      )
      .all(workUnitId) as { evidence_id: string; recorded_at: string }[];

    return rows.map((row) => ({
      id: `derived:grouped_into:${workUnitId}:${row.evidence_id}` as ProvenanceEdge['id'],
      fromKind: 'evidence',
      fromId: row.evidence_id,
      toKind: 'work_unit',
      toId: workUnitId,
      relation: 'grouped_into',
      weight: null,
      corroborating: false,
      recordedAt: toInstant(row.recorded_at),
    }));
  }

  /**
   * Whether a record has been hidden or purged.
   *
   * A proof must not cite something the user has removed. Checked at
   * explanation time rather than baked into the edges, because the edges are
   * append-only and a tombstone is a later decision (ADR-0013).
   */
  private isSuppressed(kind: ProvenanceNodeKind, id: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM tombstones WHERE target_kind = ? AND target_id = ? LIMIT 1`)
      .get(kind, id) as { hit: number } | undefined;
    return row !== undefined;
  }

  outgoing(kind: ProvenanceNodeKind, id: string): readonly ProvenanceEdge[] {
    const rows = this.db
      .prepare(`SELECT * FROM provenance_edges WHERE from_kind = ? AND from_id = ? ORDER BY id`)
      .all(kind, id) as EdgeRow[];
    return rows.map(toEdge);
  }

  /**
   * Resolve one node to what a person would recognise.
   *
   * Returns null for anything missing rather than throwing: a proof over a
   * partially purged store should show what survives and say what did not,
   * not fail to render (ADR-0015).
   */
  describe(kind: ProvenanceNodeKind, id: string): NodeDescription | null {
    // Suppressed records drop out of proofs entirely. The verdict is then
    // recomputed without them, which is the honest answer: if the only thing
    // backing a sentence has been hidden, the sentence is no longer supported.
    if (this.isSuppressed(kind, id)) return null;

    switch (kind) {
      case 'evidence': {
        const row = this.db
          .prepare(
            `SELECT e.evidence_class, e.kind, e.occurred_at, e.collector_id,
                    COALESCE(c.title, '(content removed)') AS title
             FROM evidence e LEFT JOIN evidence_content c ON c.evidence_id = e.id
             WHERE e.id = ?`,
          )
          .get(id) as
          | {
              evidence_class: string;
              kind: string;
              occurred_at: string;
              collector_id: string;
              title: string;
            }
          | undefined;
        if (row === undefined) return null;
        return {
          kind,
          id,
          label: row.title,
          detail: `${row.kind} · ${row.occurred_at.slice(0, 10)}`,
          evidenceClass: row.evidence_class as EvidenceClass,
        };
      }

      case 'work_unit': {
        const row = this.db
          .prepare(`SELECT title, occurred_at, project_key FROM work_units WHERE id = ?`)
          .get(id) as
          { title: string; occurred_at: string; project_key: string | null } | undefined;
        if (row === undefined) return null;
        const members = (
          this.db
            .prepare(`SELECT COUNT(*) AS n FROM work_unit_members WHERE work_unit_id = ?`)
            .get(id) as { n: number }
        ).n;
        return {
          kind,
          id,
          label: row.title,
          detail: `${row.project_key ?? 'no project'} · ${members} artifact(s) · ${row.occurred_at.slice(0, 10)}`,
        };
      }

      case 'enrichment': {
        const row = this.db
          .prepare(
            `SELECT e.enrichment_type, r.model, r.provider_id
             FROM enrichments e JOIN enrichment_runs r ON r.id = e.run_id
             WHERE e.id = ?`,
          )
          .get(id) as { enrichment_type: string; model: string; provider_id: string } | undefined;
        if (row === undefined) return null;
        return {
          kind,
          id,
          label: `${row.enrichment_type} interpretation`,
          detail: `${row.provider_id} · ${row.model}`,
        };
      }

      case 'claim': {
        const row = this.db.prepare(`SELECT text, claim_type FROM claims WHERE id = ?`).get(id) as
          { text: string; claim_type: string } | undefined;
        if (row === undefined) return null;
        return { kind, id, label: row.text, detail: row.claim_type };
      }

      case 'gap': {
        const row = this.db.prepare(`SELECT question, gap_type FROM gaps WHERE id = ?`).get(id) as
          { question: string; gap_type: string } | undefined;
        if (row === undefined) return null;
        return { kind, id, label: row.question, detail: row.gap_type };
      }

      case 'asset': {
        const row = this.db
          .prepare(`SELECT asset_type, content FROM assets WHERE id = ?`)
          .get(id) as { asset_type: string; content: string } | undefined;
        if (row === undefined) return null;
        return { kind, id, label: row.content.slice(0, 120), detail: row.asset_type };
      }
    }
  }

  // ── Claims ──────────────────────────────────────────────────────────────

  /**
   * Record a claim, or refuse to.
   *
   * Support is evaluated before anything is written and the whole thing is one
   * transaction, so there is no state in which a claim exists without the
   * edges that justify it. Invariant I4, held by the write path rather than by
   * a later audit.
   */
  recordClaim(draft: ClaimDraft, support: readonly SupportOffer[]): RecordedClaim {
    const resolved: SupportNode[] = [];
    for (const offer of support) {
      const description = this.describe(offer.kind, offer.id);
      if (description === null) {
        throw new UnsupportedClaimError(
          draft.claimType,
          'missing_support',
          `the ${offer.kind} offered as support (${offer.id}) is not in the store`,
        );
      }
      resolved.push(
        offer.kind === 'work_unit'
          ? { kind: 'work_unit', id: offer.id as never }
          : {
              kind: 'evidence',
              id: offer.id as never,
              evidenceClass: description.evidenceClass ?? 'imported',
              corroborating: offer.corroborating === true,
            },
      );
    }

    const verdict = evaluateSupport(draft.claimType, resolved);
    if (!verdict.supported) {
      throw new UnsupportedClaimError(draft.claimType, verdict.code, verdict.reason);
    }

    const metricSource = metricSourceOf(draft.claimType, resolved);
    const id = this.nextId() as string;
    const now = this.now();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO claims
             (id, asset_id, text, span_start, span_end, claim_type, support_state, metric_source, recorded_at, supersedes)
           VALUES (?,?,?,?,?,?,'supported',?,?,NULL)`,
        )
        .run(
          id,
          draft.assetId,
          draft.text,
          draft.span[0],
          draft.span[1],
          draft.claimType,
          metricSource,
          now,
        );

      for (const offer of support) {
        this.link(
          { kind: offer.kind, id: offer.id },
          'supports',
          { kind: 'claim', id },
          {
            ...(offer.corroborating === true ? { corroborating: true } : {}),
          },
        );
      }
    })();

    return { id, supportState: 'supported', metricSource };
  }

  /** Attach a model's reading to a claim. Explains it; never supports it. */
  attachInterpretation(claimId: string, enrichmentId: string): string {
    return this.link({ kind: 'enrichment', id: enrichmentId }, 'interprets', {
      kind: 'claim',
      id: claimId,
    });
  }

  /**
   * Why is this claim true?
   *
   * The verdict is recomputed from the graph rather than read from the row, so
   * an explanation cannot disagree with what is currently recorded.
   */
  explain(claimId: string, maxDepth?: number): Explanation | null {
    const row = this.db
      .prepare(`SELECT id, text, claim_type, asset_id FROM claims WHERE id = ?`)
      .get(claimId) as
      { id: string; text: string; claim_type: string; asset_id: string } | undefined;
    if (row === undefined) return null;

    return explainClaim(
      { id: row.id as never, text: row.text, claimType: row.claim_type as ClaimType },
      this,
      {
        ...(maxDepth === undefined ? {} : { maxDepth }),
        openGaps: this.openGapsForClaim(row.id),
      },
    );
  }

  /**
   * Open questions relevant to a claim.
   *
   * Reached through the work units in the claim's own support, so the
   * questions offered are about this work rather than about the store at
   * large.
   */
  private openGapsForClaim(claimId: string): readonly ExplanationGap[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT g.id, g.question, g.gap_type
         FROM gaps_current g
         WHERE g.status = 'open'
           AND g.work_unit_id IN (
             SELECT e.from_id FROM provenance_edges e
             WHERE e.to_kind = 'claim' AND e.to_id = ? AND e.from_kind = 'work_unit'
             UNION
             SELECT m.work_unit_id FROM work_unit_members m
             WHERE m.evidence_id IN (
               SELECT e2.from_id FROM provenance_edges e2
               WHERE e2.to_kind = 'claim' AND e2.to_id = ? AND e2.from_kind = 'evidence'
             )
           )
         ORDER BY g.id`,
      )
      .all(claimId, claimId) as { id: string; question: string; gap_type: string }[];

    return rows.map((row) => ({ id: row.id, question: row.question, gapType: row.gap_type }));
  }

  claimsForAsset(assetId: string): readonly { id: string; text: string; claimType: ClaimType }[] {
    const rows = this.db
      .prepare(
        `SELECT id, text, claim_type FROM claims_current WHERE asset_id = ? ORDER BY span_start`,
      )
      .all(assetId) as { id: string; text: string; claim_type: string }[];
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      claimType: row.claim_type as ClaimType,
    }));
  }

  // ── Gaps ────────────────────────────────────────────────────────────────

  /**
   * Raise a question, unless it has already been asked and settled.
   *
   * Deduplication happens before a gap exists rather than at ask time: a
   * question the user has answered or declined must never reappear, and the
   * cheapest way to guarantee that is never to create it twice.
   */
  raiseGap(input: {
    workUnitId: string;
    gapType: GapType;
    question: string;
    rationale: string;
  }): string | null {
    const settled = this.db
      .prepare(
        `SELECT id FROM gaps_current
         WHERE work_unit_id = ? AND gap_type = ? AND status IN ('open','answered','declined')
         LIMIT 1`,
      )
      .get(input.workUnitId, input.gapType) as { id: string } | undefined;
    if (settled !== undefined) return null;

    const id = this.nextId() as string;
    this.db
      .prepare(
        `INSERT INTO gaps
           (id, work_unit_id, gap_type, question, rationale, status, answered_by, asked_count, last_asked_at, recorded_at, supersedes)
         VALUES (?,?,?,?,?,'open',NULL,0,NULL,?,NULL)`,
      )
      .run(id, input.workUnitId, input.gapType, input.question, input.rationale, this.now());
    return id;
  }

  /** Raise the question a failed claim implies. Rule-driven; no model. */
  raiseGapForFailure(
    workUnitId: string,
    claimType: ClaimType,
    code: Parameters<typeof gapTypeForFailure>[0],
    question: string,
    rationale: string,
  ): string | null {
    return this.raiseGap({
      workUnitId,
      gapType: gapTypeForFailure(code, claimType),
      question,
      rationale,
    });
  }

  openGaps(workUnitId?: string): readonly Gap[] {
    const rows =
      workUnitId === undefined
        ? (this.db
            .prepare(`SELECT * FROM gaps_current WHERE status = 'open' ORDER BY id`)
            .all() as GapRow[])
        : (this.db
            .prepare(
              `SELECT * FROM gaps_current WHERE status = 'open' AND work_unit_id = ? ORDER BY id`,
            )
            .all(workUnitId) as GapRow[]);
    return rows.map(toGap);
  }

  /** Open questions for a bounded page of units, read in one query. */
  openGapsForWorkUnits(workUnitIds: readonly string[], limit = 100): readonly Gap[] {
    if (workUnitIds.length === 0) return [];
    const placeholders = workUnitIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM gaps_current
         WHERE status = 'open' AND work_unit_id IN (${placeholders})
         ORDER BY id LIMIT ?`,
      )
      .all(...workUnitIds, Math.max(1, Math.trunc(limit))) as GapRow[];
    return rows.map(toGap);
  }

  /** Open-question counts for a page of units in one query. */
  openGapCountsForWorkUnits(workUnitIds: readonly string[]): ReadonlyMap<string, number> {
    if (workUnitIds.length === 0) return new Map();
    const placeholders = workUnitIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT work_unit_id, COUNT(*) AS n FROM gaps_current
         WHERE status = 'open' AND work_unit_id IN (${placeholders})
         GROUP BY work_unit_id`,
      )
      .all(...workUnitIds) as { work_unit_id: string; n: number }[];
    return new Map(rows.map((row) => [row.work_unit_id, row.n]));
  }

  gapById(gapId: string): Gap | null {
    const row = this.db.prepare(`SELECT * FROM gaps_current WHERE id = ?`).get(gapId) as
      GapRow | undefined;
    return row === undefined ? null : toGap(row);
  }

  /** Every transition writes a new record; nothing is edited (ADR-0013). */
  private transitionGap(
    gap: Gap,
    changes: {
      status?: GapStatus;
      answeredBy?: string | null;
      askedCount?: number;
      lastAskedAt?: Instant | null;
    },
  ): string {
    const id = this.nextId() as string;
    this.db
      .prepare(
        `INSERT INTO gaps
           (id, work_unit_id, gap_type, question, rationale, status, answered_by, asked_count, last_asked_at, recorded_at, supersedes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        gap.workUnitId,
        gap.gapType,
        gap.question,
        gap.rationale,
        changes.status ?? gap.status,
        changes.answeredBy === undefined ? gap.answeredBy : changes.answeredBy,
        changes.askedCount ?? gap.askedCount,
        changes.lastAskedAt === undefined ? gap.lastAskedAt : changes.lastAskedAt,
        this.now(),
        gap.id,
      );
    return id;
  }

  markAskedNow(gapId: string): string {
    const gap = this.requireGap(gapId);
    return this.transitionGap(gap, { askedCount: gap.askedCount + 1, lastAskedAt: this.now() });
  }

  /** The user chose not to answer. Never raised again for this work unit. */
  declineGap(gapId: string): string {
    return this.transitionGap(this.requireGap(gapId), { status: 'declined' });
  }

  markAnsweredBy(gapId: string, evidenceId: string): string {
    const gap = this.requireGap(gapId);
    const id = this.transitionGap(gap, { status: 'answered', answeredBy: evidenceId });
    this.link({ kind: 'evidence', id: evidenceId }, 'answers', { kind: 'gap', id });
    return id;
  }

  private requireGap(gapId: string): Gap {
    const gap = this.gapById(gapId);
    if (gap === null) {
      throw new Error(`No current gap ${gapId}. It may have been answered already.`);
    }
    return gap;
  }
}

interface GapRow {
  id: string;
  work_unit_id: string;
  gap_type: string;
  question: string;
  rationale: string;
  status: string;
  answered_by: string | null;
  asked_count: number;
  last_asked_at: string | null;
  recorded_at: string;
  supersedes: string | null;
}

function toGap(row: GapRow): Gap {
  return {
    id: row.id as Gap['id'],
    workUnitId: row.work_unit_id as Gap['workUnitId'],
    gapType: row.gap_type as GapType,
    question: row.question,
    rationale: row.rationale,
    status: row.status as GapStatus,
    answeredBy: row.answered_by as Gap['answeredBy'],
    askedCount: row.asked_count,
    lastAskedAt: row.last_asked_at === null ? null : toInstant(row.last_asked_at),
    supersedes: row.supersedes as Gap['supersedes'],
  };
}

function metricSourceOf(
  claimType: ClaimType,
  support: readonly SupportNode[],
): 'derived' | 'user_confirmed' | null {
  if (claimType !== 'metric') return null;
  const evidence = support.filter(
    (node): node is Extract<SupportNode, { kind: 'evidence' }> => node.kind === 'evidence',
  );
  if (evidence.some((node) => node.evidenceClass === 'derived')) return 'derived';
  if (evidence.some((node) => node.evidenceClass === 'user_confirmed')) return 'user_confirmed';
  return null;
}

/** Re-exported so callers can label a proof without importing the domain. */
export { classify };
