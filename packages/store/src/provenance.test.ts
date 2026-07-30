import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  flatten,
  toInstant,
  type EvidenceClass,
  type EvidenceDraft,
  type EvidenceId,
} from '@careerforge/domain';

import { closeDatabase, IN_MEMORY, openDatabase } from './database.js';
import { EvidenceStore } from './evidence-store.js';
import { WorkUnitStore } from './work-unit-store.js';
import { MalformedEdgeError, ProvenanceStore, UnsupportedClaimError } from './provenance-store.js';
import { InterviewEngine, QUESTION_TEMPLATES } from './interview.js';
import { deterministicPlatform } from './platform.js';
import type { Db } from './migrations/index.js';

/**
 * The provenance graph, claims, gaps, and the interview.
 *
 * Most of this file is negative tests. That is the right shape for this
 * milestone: the value is not that supported claims can be written, it is that
 * unsupported ones cannot — and a rule that has never been observed to refuse
 * anything is a rule nobody should trust.
 */

let db: Db;
let evidence: EvidenceStore;
let units: WorkUnitStore;
let provenance: ProvenanceStore;
let interview: InterviewEngine;

beforeEach(() => {
  db = openDatabase({ path: IN_MEMORY }).db;
  const platform = deterministicPlatform();
  evidence = new EvidenceStore(db, platform);
  units = new WorkUnitStore(db, platform);
  provenance = new ProvenanceStore(db, platform);
  interview = new InterviewEngine(db, evidence, provenance, platform);
});

afterEach(() => {
  closeDatabase(db);
});

let sequence = 0;

function emit(over: Partial<EvidenceDraft> & { at?: string } = {}): string {
  const at = over.at ?? '2026-05-04T09:00:00.000Z';
  const draft: EvidenceDraft = {
    collectorId: 'git',
    sourceUri: `git://repo/commit/${++sequence}`,
    kind: 'git.commit',
    evidenceClass: 'imported',
    sensitivity: 'confidential',
    occurredAt: toInstant(at),
    occurredEnd: null,
    context: { projectKey: 'acme', workspace: null, stream: null },
    title: `Commit ${sequence}`,
    summary: null,
    excerpt: null,
    payloadRef: null,
    attributes: {},
    groupingHint: null,
    collectorVersion: '1.0.0',
    sourceFormatVersion: null,
    ...over,
  };
  return evidence.emit(draft).evidence.id;
}

const emitAs = (evidenceClass: EvidenceClass): string => emit({ evidenceClass });

function asset(content = 'Led implementation of the pricing engine.'): string {
  const id = `asset-${++sequence}`;
  db.prepare(
    `INSERT INTO assets (id, asset_type, work_unit_id, content, review_state, recorded_at)
     VALUES (?, 'resume_bullet', NULL, ?, 'draft', '2026-05-04T09:00:00.000Z')`,
  ).run(id, content);
  return id;
}

function enrichment(): string {
  const runId = `run-${++sequence}`;
  const id = `enr-${sequence}`;
  db.prepare(
    `INSERT INTO enrichment_runs
       (id, provider_id, model, params_hash, prompt_template, prompt_hash, input_ids, input_hash, started_at)
     VALUES (?, 'openai', 'gpt-5', 'p', 'bullet@1', 'h', '[]', 'ih', '2026-05-04T09:00:00.000Z')`,
  ).run(runId);
  db.prepare(
    `INSERT INTO enrichments
       (id, run_id, target_kind, target_id, enrichment_type, value, confidence, recorded_at)
     VALUES (?, ?, 'work_unit', 'wu', 'impact', '{}', 0.8, '2026-05-04T09:00:00.000Z')`,
  ).run(id, runId);
  return id;
}

function groupedUnit(): string {
  emit({ at: '2026-05-04T09:00:00.000Z' });
  emit({ at: '2026-05-04T10:00:00.000Z' });
  units.group();
  return units.currentUnits()[0]!.id;
}

describe('a claim cannot exist without support', () => {
  it('refuses a claim with no support at all', () => {
    expect(() =>
      provenance.recordClaim(
        { assetId: asset(), text: 'Did the thing', span: [0, 13], claimType: 'action' },
        [],
      ),
    ).toThrow(UnsupportedClaimError);
  });

  it('refuses a role claim supported only by imported evidence', () => {
    // Three commits touching a shared config do not make someone a lead. A
    // generator that decides otherwise has written résumé fraud on the user's
    // behalf.
    expect(() =>
      provenance.recordClaim(
        { assetId: asset(), text: 'Led the migration', span: [0, 17], claimType: 'role' },
        [
          { kind: 'evidence', id: emitAs('imported') },
          { kind: 'evidence', id: emitAs('imported') },
        ],
      ),
    ).toThrow(/Leadership and responsibility cannot be inferred/);
  });

  it('accepts a role claim once the person has confirmed it', () => {
    const recorded = provenance.recordClaim(
      { assetId: asset(), text: 'Led the migration', span: [0, 17], claimType: 'role' },
      [{ kind: 'evidence', id: emitAs('user_confirmed') }],
    );
    expect(recorded.supportState).toBe('supported');
  });

  it('refuses a metric claim supported only by imported evidence', () => {
    expect(() =>
      provenance.recordClaim(
        { assetId: asset(), text: 'Cut latency by 40%', span: [0, 18], claimType: 'metric' },
        [{ kind: 'evidence', id: emitAs('imported') }],
      ),
    ).toThrow(/Numbers must be computed from evidence or confirmed by you/);
  });

  it.each(['derived', 'user_confirmed'] as const)(
    'accepts a metric claim from %s evidence, and records where the number came from',
    (evidenceClass) => {
      const recorded = provenance.recordClaim(
        { assetId: asset(), text: 'Cut latency by 40%', span: [0, 18], claimType: 'metric' },
        [{ kind: 'evidence', id: emitAs(evidenceClass) }],
      );
      expect(recorded.metricSource).toBe(evidenceClass);
    },
  );

  it('refuses a scope claim with no corroborating evidence', () => {
    expect(() =>
      provenance.recordClaim(
        { assetId: asset(), text: 'across 50+ users', span: [0, 16], claimType: 'scope' },
        [{ kind: 'evidence', id: emitAs('imported') }],
      ),
    ).toThrow(/No evidence corroborates this scope/);
  });

  it('accepts a scope claim when evidence carries the value', () => {
    expect(() =>
      provenance.recordClaim(
        { assetId: asset(), text: 'across 50+ users', span: [0, 16], claimType: 'scope' },
        [{ kind: 'evidence', id: emitAs('imported'), corroborating: true }],
      ),
    ).not.toThrow();
  });

  it('refuses support that is not in the store', () => {
    expect(() =>
      provenance.recordClaim(
        { assetId: asset(), text: 'Did the thing', span: [0, 13], claimType: 'action' },
        [{ kind: 'evidence', id: 'does-not-exist' }],
      ),
    ).toThrow(/not in the store/);
  });

  it('writes nothing when it refuses', () => {
    // A claim row without its edges would be exactly the unsupported sentence
    // this milestone exists to prevent, so the refusal has to be atomic.
    const assetId = asset();
    try {
      provenance.recordClaim(
        { assetId, text: 'Led the migration', span: [0, 17], claimType: 'role' },
        [{ kind: 'evidence', id: emitAs('imported') }],
      );
    } catch {
      // expected
    }
    expect(provenance.claimsForAsset(assetId)).toEqual([]);
    expect((db.prepare(`SELECT COUNT(*) n FROM provenance_edges`).get() as { n: number }).n).toBe(
      0,
    );
  });
});

describe('an enrichment can explain a claim and never support one', () => {
  it('refuses a supports edge from an enrichment', () => {
    const assetId = asset();
    const recorded = provenance.recordClaim(
      { assetId, text: 'Did the thing', span: [0, 13], claimType: 'action' },
      [{ kind: 'evidence', id: emit() }],
    );
    expect(() =>
      provenance.link({ kind: 'enrichment', id: enrichment() }, 'supports', {
        kind: 'claim',
        id: recorded.id,
      }),
    ).toThrow(MalformedEdgeError);
  });

  it('refuses it at the database level too, not only in code', () => {
    // Two guards, because this is the distinction the whole product rests on.
    expect(() =>
      db
        .prepare(
          `INSERT INTO provenance_edges (id, from_kind, from_id, to_kind, to_id, relation, corroborating, recorded_at)
           VALUES ('e1','enrichment','x','claim','y','supports',0,'2026-05-04T09:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/);
  });

  it('keeps interpretation out of the grounds and in its own section', () => {
    const assetId = asset();
    const evidenceId = emit();
    const recorded = provenance.recordClaim(
      { assetId, text: 'Rebuilt the pricing engine', span: [0, 26], claimType: 'action' },
      [{ kind: 'evidence', id: evidenceId }],
    );
    provenance.attachInterpretation(recorded.id, enrichment());

    const proof = provenance.explain(recorded.id)!;
    expect(proof.verdict.supported).toBe(true);

    // The bullet exists because a model synthesised evidence. That is a fact
    // about its history and not a reason to believe it, so it appears — and
    // appears somewhere else.
    expect(proof.interpretation).toHaveLength(1);
    expect(proof.interpretation[0]!.provenanceClass).toBe('interpreted');
    for (const node of flatten(proof.grounds)) {
      expect(node.provenanceClass).not.toBe('interpreted');
    }
    expect(flatten(proof.grounds).map((node) => node.id)).toContain(evidenceId);
  });
});

describe('explaining a claim', () => {
  it('labels every node by what kind of thing it is', () => {
    const unitId = groupedUnit();
    const recorded = provenance.recordClaim(
      { assetId: asset(), text: 'Shipped the exporter', span: [0, 20], claimType: 'action' },
      [
        { kind: 'work_unit', id: unitId },
        { kind: 'evidence', id: emitAs('user_confirmed') },
      ],
    );

    const proof = provenance.explain(recorded.id)!;
    const classes = new Set(flatten(proof.grounds).map((node) => node.provenanceClass));
    expect(classes).toContain('grouped');
    expect(classes).toContain('stated');
    // The work unit's own members are reached through grouped_into, so the
    // original source records appear beneath it rather than being lost.
    expect(classes).toContain('observed');
  });

  it('reaches source evidence through the work unit that holds it', () => {
    const unitId = groupedUnit();
    const recorded = provenance.recordClaim(
      { assetId: asset(), text: 'Shipped the exporter', span: [0, 20], claimType: 'action' },
      [{ kind: 'work_unit', id: unitId }],
    );
    const proof = provenance.explain(recorded.id)!;

    const unit = proof.grounds[0]!;
    expect(unit.kind).toBe('work_unit');
    expect(unit.children.length).toBeGreaterThan(0);
    expect(unit.children.every((child) => child.via === 'grouped_into')).toBe(true);
  });

  it('recomputes the verdict from the graph rather than trusting the row', () => {
    // A stored verdict is a cached opinion. If the evidence is later hidden,
    // the honest answer is the one the graph gives now.
    const evidenceId = emitAs('user_confirmed');
    const recorded = provenance.recordClaim(
      { assetId: asset(), text: 'Led the migration', span: [0, 17], claimType: 'role' },
      [{ kind: 'evidence', id: evidenceId }],
    );
    expect(provenance.explain(recorded.id)!.verdict.supported).toBe(true);

    evidence.tombstone(evidenceId as EvidenceId, 'hidden', 'user hid this');
    const after = provenance.explain(recorded.id)!;
    expect(after.verdict.supported).toBe(false);
    expect(after.grounds).toEqual([]);
    // Counted, not named: the proof says something is gone without
    // reproducing what the user asked to remove.
    expect(after.withheld).toBe(1);
  });

  it('is bounded, and says so when it stops early', () => {
    const unitId = groupedUnit();
    const recorded = provenance.recordClaim(
      { assetId: asset(), text: 'Shipped the exporter', span: [0, 20], claimType: 'action' },
      [{ kind: 'work_unit', id: unitId }],
    );

    const shallow = provenance.explain(recorded.id, 1)!;
    expect(shallow.truncated).toBe(true);
    expect(shallow.grounds[0]!.children).toEqual([]);

    const full = provenance.explain(recorded.id, 4)!;
    expect(full.truncated).toBe(false);
  });

  it('terminates on a cycle rather than walking it', () => {
    const a = emit();
    const b = emit();
    provenance.link({ kind: 'evidence', id: a }, 'derived_from', { kind: 'evidence', id: b });
    provenance.link({ kind: 'evidence', id: b }, 'derived_from', { kind: 'evidence', id: a });

    const recorded = provenance.recordClaim(
      { assetId: asset(), text: 'Did the thing', span: [0, 13], claimType: 'action' },
      [{ kind: 'evidence', id: a }],
    );
    const proof = provenance.explain(recorded.id)!;
    expect(flatten(proof.grounds).some((node) => node.repeated)).toBe(true);
  });

  it('returns null for a claim that does not exist', () => {
    expect(provenance.explain('nope')).toBeNull();
  });
});

describe('gaps', () => {
  it('raises a question once and never twice', () => {
    const unitId = groupedUnit();
    const first = provenance.raiseGap({
      workUnitId: unitId,
      gapType: 'role',
      ...QUESTION_TEMPLATES['role']!('the exporter'),
    });
    expect(first).not.toBeNull();
    expect(
      provenance.raiseGap({
        workUnitId: unitId,
        gapType: 'role',
        ...QUESTION_TEMPLATES['role']!('the exporter'),
      }),
    ).toBeNull();
  });

  it('never re-raises a declined question, across runs', () => {
    const unitId = groupedUnit();
    const gapId = provenance.raiseGap({
      workUnitId: unitId,
      gapType: 'metric',
      ...QUESTION_TEMPLATES['metric']!('the exporter'),
    })!;
    interview.decline(gapId);

    expect(provenance.openGaps(unitId)).toEqual([]);
    expect(
      provenance.raiseGap({
        workUnitId: unitId,
        gapType: 'metric',
        ...QUESTION_TEMPLATES['metric']!('the exporter'),
      }),
    ).toBeNull();
  });

  it('turns a failed claim into the question that would settle it', () => {
    const unitId = groupedUnit();
    const gapId = provenance.raiseGapForFailure(
      unitId,
      'role',
      'role_requires_confirmation',
      QUESTION_TEMPLATES['role']!('the exporter').question,
      QUESTION_TEMPLATES['role']!('the exporter').rationale,
    );
    expect(provenance.gapById(gapId!)!.gapType).toBe('role');
  });

  it('records being asked without answering it', () => {
    const unitId = groupedUnit();
    const gapId = provenance.raiseGap({
      workUnitId: unitId,
      gapType: 'role',
      ...QUESTION_TEMPLATES['role']!('the exporter'),
    })!;
    const asked = provenance.markAskedNow(gapId);
    expect(provenance.gapById(asked)!.askedCount).toBe(1);
    expect(provenance.gapById(asked)!.status).toBe('open');
  });
});

describe('the interview', () => {
  /** A fresh question about the same thing, as a later run would raise it. */
  const openRoleGapAfterDecline = (unitId: string): string => {
    const id = `gap-again-${unitId}`;
    db.prepare(
      `INSERT INTO gaps (id, work_unit_id, gap_type, question, rationale, status, asked_count, recorded_at)
       VALUES (?, ?, 'role', ?, ?, 'open', 0, '2026-05-04T09:00:00.000Z')`,
    ).run(id, unitId, QUESTION_TEMPLATES['role']!('the exporter').question, 'again');
    return id;
  };

  const openRoleGap = (unitId: string): string =>
    provenance.raiseGap({
      workUnitId: unitId,
      gapType: 'role',
      ...QUESTION_TEMPLATES['role']!('the exporter'),
    })!;

  it('turns an answer into evidence the person confirmed', () => {
    const unitId = groupedUnit();
    const result = interview.answer(openRoleGap(unitId), 'I led it end to end.');

    const stored = evidence.byId(result.evidenceId as EvidenceId)!;
    expect(stored.evidenceClass).toBe('user_confirmed');
    expect(stored.excerpt).toBe('I led it end to end.');
    expect(stored.collectorId).toBe('interview');
  });

  it('makes a role claim possible that was impossible before', () => {
    // The whole point of asking. Before the answer this claim cannot exist.
    const unitId = groupedUnit();
    const assetId = asset();
    expect(() =>
      provenance.recordClaim(
        { assetId, text: 'Led the exporter work', span: [0, 21], claimType: 'role' },
        [{ kind: 'work_unit', id: unitId }],
      ),
    ).toThrow(UnsupportedClaimError);

    const answered = interview.answer(openRoleGap(unitId), 'I led it end to end.');
    expect(() =>
      provenance.recordClaim(
        { assetId, text: 'Led the exporter work', span: [0, 21], claimType: 'role' },
        [{ kind: 'evidence', id: answered.evidenceId }],
      ),
    ).not.toThrow();
  });

  it('closes the gap and links the answer to it', () => {
    const unitId = groupedUnit();
    const gapId = openRoleGap(unitId);
    const result = interview.answer(gapId, 'I led it.');

    expect(provenance.openGaps(unitId)).toEqual([]);
    const answersEdge = provenance
      .outgoing('evidence', result.evidenceId)
      .find((edge) => edge.relation === 'answers');
    expect(answersEdge).toBeDefined();
  });

  it('treats a second answer as a correction, not a second fact', () => {
    const unitId = groupedUnit();
    const first = interview.answer(openRoleGap(unitId), 'I contributed.');
    const naturalKey = evidence.byId(first.evidenceId as EvidenceId)!.naturalKey;

    // A later interview raises the same question again only if it was never
    // settled; it was, so it does not.
    expect(
      provenance.raiseGap({
        workUnitId: unitId,
        gapType: 'role',
        ...QUESTION_TEMPLATES['role']!('the exporter'),
      }),
    ).toBeNull();

    // Changing the answer supersedes rather than recording a second opinion
    // about the same question.
    const reopened = openRoleGapAfterDecline(unitId);
    const second = interview.answer(reopened, 'I led it end to end.');
    expect(second.superseded).toBe(true);

    const current = evidence.byNaturalKey(naturalKey)!;
    expect(current.excerpt).toBe('I led it end to end.');
    expect(current.supersedes).toBe(first.evidenceId);
    // One answer on record, not two opinions about the same question.
    expect(evidence.byId(first.evidenceId as EvidenceId)).toBeNull();
  });

  it('refuses an empty answer and suggests declining instead', () => {
    const unitId = groupedUnit();
    expect(() => interview.answer(openRoleGap(unitId), '   ')).toThrow(/Decline the question/);
  });

  it('makes an answer reusable by a second work unit', () => {
    // An answer given once is evidence forever, and evidence can support any
    // claim. This is how the system gets better the more it is used.
    const unitId = groupedUnit();
    const answered = interview.answer(openRoleGap(unitId), 'I led it.');

    for (const text of ['Led the exporter work', 'Led the follow-up rollout']) {
      expect(() =>
        provenance.recordClaim(
          { assetId: asset(), text, span: [0, text.length], claimType: 'role' },
          [{ kind: 'evidence', id: answered.evidenceId }],
        ),
      ).not.toThrow();
    }
  });

  it('needs no provider, no key, and no network', () => {
    // Stated as a test because it is easy to lose later: every question here
    // came from a template and a rule.
    const unitId = groupedUnit();
    const gapId = openRoleGap(unitId);
    const gap = provenance.gapById(gapId)!;
    expect(gap.question).toContain('What was your role');
    expect(gap.rationale).toContain('cannot be inferred');
    expect(() => interview.answer(gapId, 'I led it.')).not.toThrow();
  });
});
