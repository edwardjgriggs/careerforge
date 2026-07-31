import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toInstant, type EvidenceDraft } from '@careerforge/domain';
import { generateBullet, type CandidateRecord, type ProposedClaim } from '@careerforge/generate';

import { AssetStore, UnpublishableAssetError } from './asset-store.js';
import { closeDatabase, openDatabase, IN_MEMORY } from './database.js';
import { EvidenceStore } from './evidence-store.js';
import type { Db } from './migrations/index.js';
import { ProvenanceStore } from './provenance-store.js';
import { deterministicPlatform } from './platform.js';
import { WorkUnitStore } from './work-unit-store.js';

/**
 * Assets against a real store.
 *
 * The generator's own tests prove the rules. These prove the things only a
 * database can: that the write path re-checks rather than trusting what it was
 * handed, that a refused asset leaves nothing behind, that the export gate
 * cannot be reached around, and that an assessment goes stale when the
 * evidence beneath it moves.
 */

const platform = deterministicPlatform();

let db: Db;
let assets: AssetStore;
let provenance: ProvenanceStore;
let workUnitId: string;
let evidenceIds: string[];

const draft = (n: number, overrides: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  collectorId: 'git',
  sourceUri: `git://repo/commit/${n}`,
  kind: 'git.commit',
  evidenceClass: 'imported',
  sensitivity: 'internal',
  occurredAt: toInstant(`2026-05-0${n + 1}T09:00:00.000Z`),
  occurredEnd: null,
  context: { projectKey: 'acme', workspace: null, stream: 'main' },
  title: `Commit ${n}`,
  summary: null,
  excerpt: null,
  payloadRef: null,
  attributes: { files: ['src/parser.ts'] },
  groupingHint: null,
  collectorVersion: '1.0.0',
  sourceFormatVersion: null,
  ...overrides,
});

beforeEach(() => {
  const opened = openDatabase({ path: IN_MEMORY });
  db = opened.db;
  assets = new AssetStore(db, platform);
  provenance = new ProvenanceStore(db, platform);

  const evidence = new EvidenceStore(db, platform);
  evidenceIds = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => evidence.emit(draft(n)).evidence.id);
  const units = new WorkUnitStore(db, platform);
  units.group();
  workUnitId = units.currentUnits()[0]!.id;
});

afterEach(() => {
  closeDatabase(db);
});

const candidates = (): CandidateRecord[] =>
  evidenceIds.map((id, n) => ({
    id,
    collectorId: 'git',
    kind: 'git.commit',
    evidenceClass: 'imported',
    attributes: { files: ['src/parser.ts'] },
    text: `Commit ${n}`,
    suppressed: false,
  }));

const build = (proposals: readonly ProposedClaim[], available = candidates()) =>
  generateBullet(proposals, { workUnitId, available, openQuestionCount: 0 });

const ACTION: ProposedClaim = {
  text: 'rewrote the transcript reader to stream rather than buffer',
  claimType: 'action',
  evidence: [],
};

const action = (): ProposedClaim => ({ ...ACTION, evidence: [evidenceIds[0]!] });

describe('recording', () => {
  it('writes the asset, its claims, and its support edges together', () => {
    const recorded = assets.record({
      assetType: 'resume_bullet',
      workUnitId,
      runId: null,
      bullet: build([action()]),
    });

    expect(recorded.claimIds).toHaveLength(1);
    const stored = assets.byId(recorded.id)!;
    expect(stored.text).toBe('Rewrote the transcript reader to stream rather than buffer.');
    expect(stored.reviewState).toBe('draft');

    const edges = db
      .prepare(
        `SELECT COUNT(*) AS n FROM provenance_edges WHERE to_kind='claim' AND relation='supports'`,
      )
      .get() as { n: number };
    expect(edges.n).toBeGreaterThanOrEqual(2);
  });

  it('stores the assessment beside the words', () => {
    const recorded = assets.record({
      assetType: 'resume_bullet',
      workUnitId,
      runId: null,
      bullet: build([action()]),
    });
    const stored = assets.byId(recorded.id)!;
    expect(stored.grade).toBe('observed');
    expect(stored.assessmentAtGeneration.signals).toContain('activity_only');
    expect(stored.assessmentAtGeneration.signals).toContain('outcome_not_evidenced');
  });

  it('refuses an asset with no surviving claims and writes nothing', () => {
    const bullet = build([
      { text: 'led the migration', claimType: 'role', evidence: [evidenceIds[0]!] },
    ]);
    expect(() =>
      assets.record({ assetType: 'resume_bullet', workUnitId, runId: null, bullet }),
    ).toThrow(UnpublishableAssetError);

    const count = db.prepare(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('raises the questions a refused generation implies, even with no asset', () => {
    // The bullet is worthless and the questions are the whole value. Refusing
    // to record them because the sentence came out empty would throw away the
    // only useful thing that happened.
    const bullet = build([
      { text: 'led the migration', claimType: 'role', evidence: [evidenceIds[0]!] },
    ]);
    const gapIds = assets.raiseQuestionsOnly(workUnitId, bullet);
    expect(gapIds).toHaveLength(1);
    expect(provenance.openGaps(workUnitId)[0]!.gapType).toBe('role');
  });

  it('turns a dropped claim into a question in the same transaction as the asset', () => {
    const recorded = assets.record({
      assetType: 'resume_bullet',
      workUnitId,
      runId: null,
      bullet: build([action(), { text: 'led it', claimType: 'role', evidence: [evidenceIds[0]!] }]),
    });
    expect(recorded.gapIds).toHaveLength(1);
    expect(provenance.openGaps(workUnitId).map((gap) => gap.gapType)).toEqual(['role']);
  });

  it('re-checks support against the store rather than trusting the generator', () => {
    // The generator works from records handed to it; this is the only place
    // that sees the database. A claim citing something not in the store must
    // fail here even though the generator was told it existed.
    const bullet = build(
      [{ ...ACTION, evidence: ['01NOTINSTORE'] }],
      [
        {
          id: '01NOTINSTORE',
          collectorId: 'git',
          kind: 'git.commit',
          evidenceClass: 'imported',
          attributes: {},
          text: 'a record the store has never seen',
          suppressed: false,
        },
      ],
    );
    expect(bullet.claims).toHaveLength(1);

    expect(() =>
      assets.record({ assetType: 'resume_bullet', workUnitId, runId: null, bullet }),
    ).toThrow();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number }).n).toBe(0);
  });

  it('sets corroborating on the edge when evidence carries the figure', () => {
    // The flag has existed on the edge since M7 with nothing to set it. This
    // is what sets it.
    const withCount = candidates().map((record, n) =>
      n === 0 ? { ...record, attributes: { fileCount: 8 } } : record,
    );
    const bullet = build(
      [action(), { text: 'across 8 files', claimType: 'scope', evidence: [evidenceIds[0]!] }],
      withCount,
    );
    assets.record({ assetType: 'resume_bullet', workUnitId, runId: null, bullet });

    const corroborating = db
      .prepare(`SELECT COUNT(*) AS n FROM provenance_edges WHERE corroborating = 1`)
      .get() as { n: number };
    expect(corroborating.n).toBe(1);
  });
});

describe('the export gate', () => {
  const recordDraft = () =>
    assets.record({
      assetType: 'resume_bullet',
      workUnitId,
      runId: null,
      bullet: build([action()]),
    }).id;

  it('refuses a draft', () => {
    recordDraft();
    expect(assets.exportable()).toEqual([]);
  });

  it('permits a reviewed asset', () => {
    assets.review(recordDraft(), 'reviewed');
    expect(assets.exportable()).toHaveLength(1);
  });

  it('refuses a rejected asset', () => {
    // The case the old denylist would have waved through. An asset a person
    // read and turned down is the last thing that should reach a résumé.
    assets.review(recordDraft(), 'rejected');
    expect(assets.exportable()).toEqual([]);
  });

  it('keeps what was generated beside what was decided about it', () => {
    const id = recordDraft();
    assets.review(id, 'rejected');
    expect(assets.byId(id)!.reviewState).toBe('draft');
    expect(assets.forWorkUnit(workUnitId)[0]!.reviewState).toBe('rejected');
  });
});

describe('the assessment is checked against the evidence as it stands', () => {
  it('does not drift when nothing has changed', () => {
    const id = assets.record({
      assetType: 'resume_bullet',
      workUnitId,
      runId: null,
      bullet: build([action()]),
    }).id;

    const assessed = assets.assess(id)!;
    expect(assessed.assessmentDrifted).toBe(false);
    expect(assessed.assessmentNow.grade).toBe('observed');
  });

  it('notices when supporting evidence has been withdrawn', () => {
    // The point of recomputing. A stored assessment presented as current
    // after the ground moved is the failure M7 rejected for support verdicts.
    const id = assets.record({
      assetType: 'resume_bullet',
      workUnitId,
      runId: null,
      bullet: build([action()]),
    }).id;

    new EvidenceStore(db, platform).tombstone(
      evidenceIds[0]! as never,
      'hidden',
      'contains a client name',
    );

    const assessed = assets.assess(id)!;
    expect(assessed.assessmentDrifted).toBe(true);
    expect(assessed.assessmentNow.grade).toBe('asserted');
    expect(assessed.assessmentAtGeneration.grade).toBe('observed');
    // Named, not merely counted down. Reading the support through
    // `evidence_current` would have made a withdrawal indistinguishable from
    // a record that was never cited.
    expect(assessed.assessmentNow.signals).toContain('support_superseded');
  });

  it('notices when a question was opened after the words were written', () => {
    const id = assets.record({
      assetType: 'resume_bullet',
      workUnitId,
      runId: null,
      bullet: build([action()]),
    }).id;
    expect(assets.assess(id)!.assessmentDrifted).toBe(false);

    provenance.raiseGap({
      workUnitId,
      gapType: 'metric',
      question: 'Did this produce a measurable result?',
      rationale: 'test',
    });
    expect(assets.assess(id)!.assessmentNow.signals).toContain('open_questions');
    expect(assets.assess(id)!.assessmentDrifted).toBe(true);
  });
});

describe('edits', () => {
  const recorded = () =>
    assets.record({
      assetType: 'resume_bullet',
      workUnitId,
      runId: null,
      bullet: build([action()]),
    });

  it('treats a rewording that keeps every claim as a style exemplar', () => {
    const { id } = recorded();
    const claim = provenance.claimsForAsset(id)[0]!.text;

    const result = assets.applyEdit(id, `${claim}, in one pass.`);
    expect(result.kind).toBe('wording');
    expect(assets.exemplars('resume_bullet')).toHaveLength(1);
    expect(assets.byId(result.assetId!)!.editedBy).toBe('user');
  });

  it('refuses to record an edit that changes what is asserted', () => {
    // Accepting new wording that asserts something new would let the style
    // loop learn to claim things nothing supports.
    const { id } = recorded();
    const result = assets.applyEdit(id, 'Led the rewrite of the transcript reader.');
    expect(result.kind).toBe('factual');
    expect(result.assetId).toBeNull();
    expect(assets.exemplars()).toEqual([]);
  });

  it('marks an edited asset reviewed, since a person just read it', () => {
    const { id } = recorded();
    const claim = provenance.claimsForAsset(id)[0]!.text;
    const result = assets.applyEdit(id, `${claim} throughout.`);
    expect(assets.exportable()).toHaveLength(1);
    expect(assets.exportable()[0]!.id).toBe(result.assetId);
  });
});
