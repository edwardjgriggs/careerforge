import {
  suggestImprovements,
  type EvidenceAssessment,
  type ProvenanceClass,
  type Sensitivity,
  type SupportingRecord,
} from '@careerforge/domain';
import {
  AssetStore,
  InterviewEngine,
  ProvenanceStore,
  WorkUnitStore,
  EvidenceStore,
  nodePlatform,
  type Db,
} from '@careerforge/store';

import type {
  AssetView,
  ClaimView,
  ExplorerView,
  GroundView,
  QuestionView,
  UnitView,
} from './view-model.js';

/**
 * The store, read into something a person can be shown.
 *
 * The flattening happens here rather than in the renderer, so the shape of the
 * screen is decided by a testable function rather than by whatever the SQL
 * happened to return. It is also where the two questions are actually
 * answered: `explain` for the first, `suggestImprovements` for the second.
 *
 * Read-only except for one path — recording an interview answer, which is a
 * local write through the same engine the CLI uses.
 */

/**
 * Whether any collector in this build observes outcomes.
 *
 * Passed to the strengthening layer so its advice is honest. Today no shipped
 * collector emits one, so "record what changed" is offered as something only
 * the person can supply — which is true, and better than pointing at a
 * collector that does not exist.
 */
const OUTCOME_KINDS = new Set([
  'git.release',
  'git.merge',
  'issue.closed',
  'deploy.completed',
  'incident.resolved',
]);

interface Stores {
  readonly assets: AssetStore;
  readonly provenance: ProvenanceStore;
  readonly units: WorkUnitStore;
  readonly evidence: EvidenceStore;
  readonly interview: InterviewEngine;
}

export function openStores(db: Db): Stores {
  const evidence = new EvidenceStore(db, nodePlatform);
  const provenance = new ProvenanceStore(db, nodePlatform);
  return {
    assets: new AssetStore(db, nodePlatform),
    provenance,
    units: new WorkUnitStore(db, nodePlatform),
    evidence,
    interview: new InterviewEngine(db, evidence, provenance, nodePlatform),
  };
}

/** Sensitivity of one evidence record, or null when it is not evidence. */
function sensitivityOf(db: Db, kind: string, id: string): Sensitivity | null {
  if (kind !== 'evidence') return null;
  const row = db.prepare(`SELECT sensitivity FROM evidence WHERE id = ?`).get(id) as
    { sensitivity: string } | undefined;
  return row === undefined ? null : (row.sensitivity as Sensitivity);
}

function toGround(
  db: Db,
  node: {
    kind: string;
    id: string;
    provenanceClass: ProvenanceClass;
    label: string;
    detail: string | null;
  },
): GroundView {
  return {
    id: node.id,
    provenanceClass: node.provenanceClass,
    classLabel: node.provenanceClass,
    label: node.label,
    detail: node.detail,
    sensitivity: sensitivityOf(db, node.kind, node.id),
  };
}

/**
 * The records currently behind an asset, for the strengthening calculation.
 *
 * Read through the base `evidence` table rather than `evidence_current`,
 * because a withdrawn record must be visible *as* withdrawn — the view would
 * make it look like a record that was never cited.
 */
function supportingRecords(db: Db, assetId: string): readonly SupportingRecord[] {
  const rows = db
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

function claimViews(db: Db, stores: Stores, assetId: string): readonly ClaimView[] {
  const rootClaims = stores.assets.claimsFor(assetId);
  const views: ClaimView[] = [];

  for (const claim of rootClaims) {
    const explanation = stores.provenance.explain(claim.id);
    if (explanation === null) continue;

    const row = db.prepare(`SELECT span_start, span_end FROM claims WHERE id = ?`).get(claim.id) as
      { span_start: number; span_end: number } | undefined;

    views.push({
      id: claim.id,
      text: explanation.text,
      claimType: explanation.claimType,
      span: [row?.span_start ?? 0, row?.span_end ?? 0],
      // Only the top level. A proof that expands every ancestor is a graph
      // viewer; the question is "what stands behind this", and the answer is
      // the records that do, not their history.
      grounds: explanation.grounds.map((node) => toGround(db, node)),
      interpretation: explanation.interpretation.map((node) => toGround(db, node)),
      withheld: explanation.withheld,
    });
  }

  return views;
}

function assetView(db: Db, stores: Stores, assetId: string): AssetView | null {
  const assessed = stores.assets.assess(assetId);
  if (assessed === null) return null;

  const unit = stores.units.byId(assessed.workUnitId);
  const claims = claimViews(db, stores, assetId);
  const openGaps = stores.provenance.openGaps(assessed.workUnitId);
  const support = supportingRecords(db, assetId);

  // Evidence in this unit that arrived *after* the words did, and that the
  // statement therefore cannot be using. Not "records it does not cite" — a
  // bullet never cites every record in its unit, and reporting that would fire
  // on every asset with something that is neither a problem nor news.
  const cited = new Set(support.map((record) => record.id));
  const uncited = stores.units.memberIds(assessed.workUnitId).filter((id) => !cited.has(id));

  let newerRecordCount = 0;
  let uncitedIncludesAnswer = false;
  if (uncited.length > 0) {
    const placeholders = uncited.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT COUNT(*) AS newer,
                SUM(CASE WHEN evidence_class = 'user_confirmed' THEN 1 ELSE 0 END) AS answers
         FROM evidence
         WHERE id IN (${placeholders}) AND recorded_at > ?`,
      )
      .get(...uncited, assessed.recordedAt) as { newer: number; answers: number | null };
    newerRecordCount = row.newer;
    uncitedIncludesAnswer = (row.answers ?? 0) > 0;
  }

  return {
    id: assessed.id,
    workUnitId: assessed.workUnitId,
    workUnitTitle: unit?.title ?? '(work unit no longer in the store)',
    text: assessed.text,
    reviewState: assessed.reviewState,
    grade: assessed.assessmentNow.grade,
    assessment: assessed.assessmentNow,
    driftedFrom: assessed.assessmentDrifted ? assessed.assessmentAtGeneration : null,
    claims,
    improvements: suggestImprovements({
      workUnitId: assessed.workUnitId,
      assessment: assessed.assessmentNow,
      support,
      claimTypes: claims.map((claim) => claim.claimType as never),
      newerRecordCount,
      uncitedIncludesAnswer,
      openGaps: openGaps.map((gap) => ({
        id: gap.id,
        gapType: gap.gapType,
        question: gap.question,
      })),
      // Honest rather than aspirational: nothing in this build observes an
      // outcome, so the advice says the person is the only route.
      outcomeCollectorAvailable: false,
    }),
  };
}

export function readExplorerView(db: Db): ExplorerView {
  const stores = openStores(db);

  const units = stores.units.currentUnits();
  const assets = units
    .flatMap((unit) => stores.assets.forWorkUnit(unit.id))
    .map((asset) => assetView(db, stores, asset.id))
    .filter((view): view is AssetView => view !== null);

  const unitViews: UnitView[] = units.map((unit) => ({
    id: unit.id,
    title: unit.title,
    recordCount: stores.units.memberIds(unit.id).length,
    occurredAt: unit.occurredAt,
    assetCount: stores.assets.forWorkUnit(unit.id).length,
    openQuestionCount: stores.provenance.openGaps(unit.id).length,
  }));

  const questions: QuestionView[] = stores.provenance.openGaps().map((gap) => ({
    id: gap.id,
    workUnitId: gap.workUnitId,
    workUnitTitle: units.find((unit) => unit.id === gap.workUnitId)?.title ?? '(unknown work)',
    gapType: gap.gapType,
    question: gap.question,
    rationale: gap.rationale,
  }));

  const evidenceCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM evidence_current`).get() as { n: number }
  ).n;

  return {
    assets,
    units: unitViews,
    questions,
    totals: {
      evidence: evidenceCount,
      units: units.length,
      assets: assets.length,
      questions: questions.length,
    },
  };
}

/** Record an answer. The one write path the Explorer has, and it is local. */
export function recordAnswer(db: Db, gapId: string, answer: string): { evidenceId: string } {
  const stores = openStores(db);
  const result = stores.interview.answer(gapId, answer);
  return { evidenceId: result.evidenceId };
}

export type { EvidenceAssessment };
