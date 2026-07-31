import {
  assessEvidence,
  classifyEdit,
  createUlidFactory,
  instantFromEpochMillis,
  isExportable,
  sameAssessment,
  type AssetType,
  type ClaimType,
  type EditKind,
  type EvidenceAssessment,
  type EvidenceGrade,
  type Instant,
  type Platform,
  type ReviewState,
  type SupportingRecord,
  type UlidFactory,
} from '@careerforge/domain';
import type { GeneratedBullet } from '@careerforge/generate';

import type { Db } from './migrations/index.js';
import { ProvenanceStore } from './provenance-store.js';

/**
 * Where generated assets and their claims are recorded.
 *
 * `generate` cannot reach this file — it has no store dependency and no
 * database driver, the same rule that keeps `enrich` away from fact. It
 * produces a description of what should be written; this decides whether to
 * write it and does so atomically.
 *
 * ── Nothing is stored until every claim is accepted ──────────────────────
 *
 * The asset row, its claims, its support edges, and the questions its dropped
 * claims raise are one transaction. A half-written asset — text present,
 * claims missing — would be an unsupported bullet that looks reviewed, which
 * is the exact artifact this product exists not to produce.
 */

export interface RecordAssetInput {
  readonly assetType: AssetType;
  readonly workUnitId: string;
  readonly runId: string | null;
  readonly bullet: GeneratedBullet;
  /** The asset this one replaces, when regenerating or editing. */
  readonly supersedes?: string;
  readonly editedBy?: 'user';
}

export interface StoredAsset {
  readonly id: string;
  readonly assetType: AssetType;
  readonly workUnitId: string;
  readonly runId: string | null;
  readonly text: string;
  readonly reviewState: ReviewState;
  readonly editedBy: 'user' | null;
  readonly supersedes: string | null;
  readonly recordedAt: string;
  /** What the evidence looked like when the words were written. */
  readonly assessmentAtGeneration: EvidenceAssessment;
  readonly grade: EvidenceGrade;
}

/** An asset with its assessment checked against the evidence as it stands now. */
export interface AssessedAsset extends StoredAsset {
  readonly assessmentNow: EvidenceAssessment;
  /** True when the evidence has moved since the words were written. */
  readonly assessmentDrifted: boolean;
}

export interface RecordedAsset {
  readonly id: string;
  readonly claimIds: readonly string[];
  /** Gaps created for dropped claims. Fewer than dropped when already asked. */
  readonly gapIds: readonly string[];
}

/** Refused before anything was written. */
export class UnpublishableAssetError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnpublishableAssetError';
  }
}

interface AssetRow {
  id: string;
  asset_type: string;
  work_unit_id: string;
  run_id: string | null;
  content: string;
  review_state: string;
  edited_by: string | null;
  supersedes: string | null;
  recorded_at: string;
  evidence_grade: string | null;
  assessment: string;
}

const toAsset = (row: AssetRow): StoredAsset => ({
  id: row.id,
  assetType: row.asset_type as AssetType,
  workUnitId: row.work_unit_id,
  runId: row.run_id,
  text: row.content,
  reviewState: row.review_state as ReviewState,
  editedBy: row.edited_by as 'user' | null,
  supersedes: row.supersedes,
  recordedAt: row.recorded_at,
  assessmentAtGeneration: JSON.parse(row.assessment) as EvidenceAssessment,
  grade: (row.evidence_grade ?? 'asserted') as EvidenceGrade,
});

export class AssetStore {
  private readonly nextId: UlidFactory;
  private readonly provenance: ProvenanceStore;

  constructor(
    private readonly db: Db,
    private readonly platform: Platform,
  ) {
    this.nextId = createUlidFactory(platform.clock, platform.entropy);
    this.provenance = new ProvenanceStore(db, platform);
  }

  private now(): Instant {
    return instantFromEpochMillis(this.platform.clock());
  }

  /**
   * Write an asset, its claims, its support, and its questions.
   *
   * Every claim goes through `recordClaim`, which evaluates support again
   * against the store rather than trusting what the generator decided. The
   * duplication is deliberate: the generator works from records handed to it,
   * and the write path is the only place that sees the database. A claim that
   * passed in memory and fails here throws, and nothing is written.
   */
  record(input: RecordAssetInput): RecordedAsset {
    const { bullet } = input;

    if (bullet.claims.length === 0) {
      // An empty asset is something a user would later find and wonder about.
      // The dropped claims and their questions are the useful product here,
      // and they are still raised below.
      throw new UnpublishableAssetError(
        'Nothing in the evidence supported any part of this. No asset was written.',
      );
    }

    const id = this.nextId() as string;
    const claimIds: string[] = [];
    const gapIds: string[] = [];

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assets
             (id, asset_type, work_unit_id, run_id, content, review_state, edited_by,
              recorded_at, supersedes, evidence_grade, assessment)
           VALUES (?,?,?,?,?,'draft',?,?,?,?,?)`,
        )
        .run(
          id,
          input.assetType,
          input.workUnitId,
          input.runId,
          bullet.text,
          input.editedBy ?? null,
          this.now(),
          input.supersedes ?? null,
          bullet.assessment.grade,
          JSON.stringify(bullet.assessment),
        );

      for (const claim of bullet.claims) {
        const recorded = this.provenance.recordClaim(
          {
            assetId: id,
            text: claim.text,
            span: [claim.span[0], claim.span[1]],
            claimType: claim.claimType,
          },
          [
            ...claim.evidence.map((evidenceId) => ({
              kind: 'evidence' as const,
              id: evidenceId,
              ...(claim.corroboratingIds.includes(evidenceId) ? { corroborating: true } : {}),
            })),
            { kind: 'work_unit' as const, id: input.workUnitId },
          ],
        );
        claimIds.push(recorded.id);
      }

      // Raised inside the same transaction. A question that survived a failed
      // asset write would be asked about a bullet that does not exist.
      for (const dropped of bullet.dropped) {
        const gapId = this.provenance.raiseGap({
          workUnitId: input.workUnitId,
          gapType: dropped.gapType,
          question: dropped.question,
          rationale: `A stronger bullet would say "${dropped.text}", and ${dropped.reason.charAt(0).toLowerCase()}${dropped.reason.slice(1)}`,
        });
        if (gapId !== null) gapIds.push(gapId);
      }
    })();

    return { id, claimIds, gapIds };
  }

  /**
   * Raise the questions a generation implies without writing an asset.
   *
   * For the case where nothing survived. The bullet is worthless and the
   * questions are the whole value — refusing to record them because the
   * sentence came out empty would throw away the only useful thing that
   * happened.
   */
  raiseQuestionsOnly(workUnitId: string, bullet: GeneratedBullet): readonly string[] {
    const gapIds: string[] = [];
    this.db.transaction(() => {
      for (const dropped of bullet.dropped) {
        const gapId = this.provenance.raiseGap({
          workUnitId,
          gapType: dropped.gapType,
          question: dropped.question,
          rationale: dropped.reason,
        });
        if (gapId !== null) gapIds.push(gapId);
      }
    })();
    return gapIds;
  }

  /**
   * The asset in this revision chain that the claims are attached to.
   *
   * Reviewing or rewording an asset writes a new row superseding the old one,
   * and the claims stay where they were recorded — on the first row. Reading
   * support from the *current* row therefore found nothing, and an accepted
   * bullet exported as "asserted — 0 records" while its evidence sat one hop
   * away. It was invisible until an asset was reviewed and then exported,
   * which nothing did until the export path existed.
   *
   * Walking to the root is the fix rather than copying claims forward: one
   * claim set per chain is what makes `explain` show a bullet's proof once
   * instead of once per revision. It is sound precisely because an edit that
   * changes the claim set is refused as factual — a revision chain always
   * asserts the same things, so it can share one set of claims.
   */
  private rootAssetId(id: string): string {
    let current = id;
    // Bounded: a chain longer than this is a loop, and looping forever while
    // resolving a résumé bullet is a worse failure than answering wrongly.
    for (let hop = 0; hop < 64; hop++) {
      const row = this.db.prepare(`SELECT supersedes FROM assets WHERE id = ?`).get(current) as
        { supersedes: string | null } | undefined;
      if (row === undefined || row.supersedes === null) return current;
      current = row.supersedes;
    }
    return current;
  }

  /** The claims this asset asserts, resolved through its revision chain. */
  claimsFor(assetId: string): readonly { id: string; text: string; claimType: string }[] {
    return this.provenance.claimsForAsset(this.rootAssetId(assetId));
  }

  byId(id: string): StoredAsset | null {
    const row = this.db.prepare(`SELECT * FROM assets WHERE id = ?`).get(id) as
      AssetRow | undefined;
    return row === undefined ? null : toAsset(row);
  }

  forWorkUnit(workUnitId: string): readonly StoredAsset[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM assets a
         WHERE a.work_unit_id = ?
           AND NOT EXISTS (SELECT 1 FROM assets s WHERE s.supersedes = a.id)
         ORDER BY a.id DESC`,
      )
      .all(workUnitId) as AssetRow[];
    return rows.map(toAsset);
  }

  /**
   * The asset with its assessment recomputed from the evidence as it stands.
   *
   * The stored assessment says what the record looked like when the words were
   * written. This says what it looks like now, and the two are shown together
   * when they differ. Presenting only the stored one would be the failure M7
   * rejected for support verdicts: a judgement that cannot disagree with
   * reality because nobody ever asks it to.
   */
  assess(id: string): AssessedAsset | null {
    const asset = this.byId(id);
    if (asset === null) return null;

    const support = this.supportingRecords(this.rootAssetId(id));
    const openQuestions = this.provenance.openGaps(asset.workUnitId).length;
    const claimTypes = this.claimsFor(id).map((claim) => claim.claimType as ClaimType);

    const assessmentNow = assessEvidence({
      claimTypes,
      support,
      droppedClaimTypes: asset.assessmentAtGeneration.droppedClaimTypes ?? [],
      openQuestionCount: openQuestions,
    });

    return {
      ...asset,
      assessmentNow,
      assessmentDrifted: !sameAssessment(asset.assessmentAtGeneration, assessmentNow),
    };
  }

  /**
   * The records currently standing behind an asset's claims.
   *
   * Read through the provenance graph rather than from anything stored on the
   * asset, so a tombstoned record shows up as suppressed rather than silently
   * continuing to count.
   *
   * Deliberately joined against the base `evidence` table rather than
   * `evidence_current`. The view already excludes withdrawn records, which
   * would make a withdrawal look like a record that was never cited — the
   * counts would fall and nothing would say why. The assessment's job is to
   * *report* the withdrawal, so it has to be able to see it.
   */
  private supportingRecords(assetId: string): readonly SupportingRecord[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.collector_id, e.kind, e.evidence_class,
                MAX(pe.corroborating) AS corroborating,
                EXISTS (SELECT 1 FROM tombstones t
                        WHERE t.target_kind = 'evidence' AND t.target_id = e.id) AS suppressed
         FROM provenance_edges pe
         JOIN claims c ON c.id = pe.to_id
         JOIN evidence e ON e.id = pe.from_id
         WHERE pe.to_kind = 'claim' AND pe.relation = 'supports'
           AND pe.from_kind = 'evidence' AND c.asset_id = ?
         GROUP BY e.id`,
      )
      .all(assetId) as {
      id: string;
      collector_id: string;
      kind: string;
      evidence_class: string;
      corroborating: number;
      suppressed: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      collectorId: row.collector_id,
      evidenceClass: row.evidence_class as SupportingRecord['evidenceClass'],
      corroborating: row.corroborating === 1,
      suppressed: row.suppressed === 1,
      recordsOutcome: OUTCOME_KINDS.has(row.kind),
    }));
  }

  /**
   * Record a person's judgement.
   *
   * A superseding row, so what was generated stays queryable beside what was
   * decided about it. `rejected` is a real outcome and must remain: without
   * it, disagreeing with a draft would mean deleting it, and the store does
   * not delete.
   */
  review(assetId: string, reviewState: Exclude<ReviewState, 'draft'>): string {
    const row = this.db.prepare(`SELECT * FROM assets WHERE id = ?`).get(assetId) as
      AssetRow | undefined;
    if (row === undefined) throw new Error(`No asset ${assetId}.`);

    const id = this.nextId() as string;
    this.db
      .prepare(
        `INSERT INTO assets
           (id, asset_type, work_unit_id, run_id, content, review_state, edited_by,
            recorded_at, supersedes, evidence_grade, assessment)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        row.asset_type,
        row.work_unit_id,
        row.run_id,
        row.content,
        reviewState,
        row.edited_by,
        this.now(),
        assetId,
        row.evidence_grade,
        row.assessment,
      );
    return id;
  }

  /**
   * Apply a user's edit, and decide what kind of edit it was.
   *
   * A wording change becomes a style exemplar. A change to what is being
   * asserted is a factual disagreement and is reported as such rather than
   * recorded — the claims would have to be re-checked against evidence, and
   * silently accepting new wording would let the style loop learn to assert
   * things nothing supports.
   */
  applyEdit(
    assetId: string,
    text: string,
  ): { readonly kind: EditKind; readonly assetId: string | null } {
    const asset = this.byId(assetId);
    if (asset === null) throw new Error(`No asset ${assetId}.`);

    const claimsBefore = this.claimsFor(assetId).map((claim) => claim.text);

    // The claim set after the edit is *derived*, never taken from the caller.
    // The CLI originally passed the existing claims straight back, so every
    // edit classified as a rewording — including one that asserted something
    // new. Deciding here means no caller can make that mistake.
    //
    // The rule is substring survival: a claim whose exact words are still
    // present is unchanged, and anything else is treated as a factual edit.
    // Conservative in the safe direction. Rewriting "rewrote the reader" as
    // "overhauled the reader" is refused even though it probably means the
    // same thing, because nothing here can verify that it does — and the cost
    // of being wrong is a style corpus that teaches the generator to assert
    // things no evidence supports.
    const claimsAfter = claimsBefore.filter((claim) => text.includes(claim));
    const kind = classifyEdit(claimsBefore, claimsAfter);

    if (kind === 'factual') return { kind, assetId: null };

    const id = this.nextId() as string;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assets
             (id, asset_type, work_unit_id, run_id, content, review_state, edited_by,
              recorded_at, supersedes, evidence_grade, assessment)
           VALUES (?,?,?,?,?,'reviewed','user',?,?,?,?)`,
        )
        .run(
          id,
          asset.assetType,
          asset.workUnitId,
          asset.runId,
          text,
          this.now(),
          assetId,
          asset.grade,
          JSON.stringify(asset.assessmentAtGeneration),
        );

      this.db
        .prepare(
          `INSERT INTO style_exemplars (id, asset_type, before, after, asset_id, recorded_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(this.nextId() as string, asset.assetType, asset.text, text, id, this.now());
    })();

    return { kind, assetId: id };
  }

  exemplars(assetType?: AssetType): readonly { before: string; after: string }[] {
    const rows = (
      assetType === undefined
        ? this.db.prepare(`SELECT before, after FROM style_exemplars ORDER BY id`).all()
        : this.db
            .prepare(`SELECT before, after FROM style_exemplars WHERE asset_type = ? ORDER BY id`)
            .all(assetType)
    ) as { before: string; after: string }[];
    return rows;
  }

  /**
   * Assets that may be exported.
   *
   * The gate lives here, in the path anything leaves through, rather than in
   * a command or a UI. A CLI user, a scripted run, and a future desktop app
   * all inherit it because none of them can reach an asset any other way.
   */
  exportable(workUnitId?: string): readonly StoredAsset[] {
    const rows = (
      workUnitId === undefined
        ? this.db
            .prepare(
              `SELECT a.* FROM assets a
               WHERE NOT EXISTS (SELECT 1 FROM assets s WHERE s.supersedes = a.id)
               ORDER BY a.id`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT a.* FROM assets a
               WHERE a.work_unit_id = ?
                 AND NOT EXISTS (SELECT 1 FROM assets s WHERE s.supersedes = a.id)
               ORDER BY a.id`,
            )
            .all(workUnitId)
    ) as AssetRow[];

    return rows.map(toAsset).filter(isExportable);
  }
}

/**
 * Evidence kinds that record a result rather than the work.
 *
 * Mirrors the list in `@careerforge/generate`. Duplicated rather than
 * imported: `store` depending on `generate` for a constant would couple the
 * write path to the generator, and a store must be able to assess an asset a
 * different generator produced.
 */
const OUTCOME_KINDS = new Set([
  'git.release',
  'git.merge',
  'issue.closed',
  'deploy.completed',
  'incident.resolved',
]);
