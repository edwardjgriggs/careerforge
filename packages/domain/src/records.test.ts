import { describe, expect, it } from 'vitest';

import { classifyEdit, isExportable, revisionOf, REVIEW_STATES, type Asset } from './assets.js';
import type { SupportFailureCode } from './claims.js';
import { correctionOf, isTombstoned, isUserConfirmed, type Evidence } from './evidence.js';
import {
  isCacheHit,
  isStale,
  supersede,
  type Enrichment,
  type EnrichmentRun,
} from './enrichment.js';
import {
  gapTypeForFailure,
  isAlreadyAnswered,
  isAskable,
  markAnswered,
  markAsked,
  markDeclined,
  type Gap,
} from './gaps.js';
import type {
  AssetId,
  EnrichmentId,
  EnrichmentRunId,
  EvidenceId,
  GapId,
  ProvenanceEdgeId,
  TombstoneId,
  WorkUnitId,
} from './ids.js';
import {
  isSupportingRelation,
  isWellFormed,
  supportEdgesFor,
  PROVENANCE_RELATIONS,
  type ProvenanceEdge,
} from './provenance.js';
import {
  SELF_ATTRIBUTION,
  isSelfAsserted,
  isThirdPartyAttestation,
  SELF,
  type IdentityId,
} from './subject.js';
import { toInstant } from './time.js';
import {
  suppressedIds,
  destroysContent,
  isReversible,
  TOMBSTONE_SCOPES,
  type Tombstone,
} from './tombstone.js';
import { deriveSensitivity, isRewritable, meetsThreshold, pinsUnit } from './work-unit.js';

const at = (iso: string) => toInstant(iso);
const T0 = at('2026-07-30T14:02:11.000Z');

const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: 'ev-1' as EvidenceId,
  schemaVersion: 1,
  collectorId: 'git',
  sourceUri: 'git://repo/commit/abc',
  naturalKey: 'nk',
  contentHash: 'ch',
  kind: 'git.commit',
  evidenceClass: 'imported',
  sensitivity: 'confidential',
  attribution: SELF_ATTRIBUTION,
  occurredAt: T0,
  occurredEnd: null,
  recordedAt: T0,
  context: { projectKey: 'careerforge', workspace: null, stream: 'main' },
  title: 'Add parser',
  summary: null,
  excerpt: null,
  payloadRef: null,
  attributes: {},
  groupingHint: null,
  supersedes: null,
  tombstonedBy: null,
  collectorVersion: '1.0.0',
  sourceFormatVersion: null,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────
describe('evidence corrections', () => {
  it('creates a new record rather than mutating the original', () => {
    const original = evidence();
    const corrected = correctionOf(
      original,
      { title: 'Add tolerant parser' },
      { id: 'ev-2' as EvidenceId, contentHash: 'ch2', recordedAt: at('2026-07-31T00:00:00.000Z') },
    );

    expect(corrected.id).not.toBe(original.id);
    expect(corrected.supersedes).toBe(original.id);
    expect(corrected.title).toBe('Add tolerant parser');
    // The original object is untouched — nothing is mutated in place.
    expect(original.title).toBe('Add parser');
    expect(original.supersedes).toBeNull();
  });

  it('carries identity forward — a correction describes the same artifact', () => {
    const original = evidence();
    const corrected = correctionOf(
      original,
      { title: 'x' },
      { id: 'ev-2' as EvidenceId, contentHash: 'ch2', recordedAt: T0 },
    );
    expect(corrected.naturalKey).toBe(original.naturalKey);
    expect(corrected.sourceUri).toBe(original.sourceUri);
    expect(corrected.contentHash).not.toBe(original.contentHash);
  });

  it('clears any tombstone on the correction', () => {
    const original = evidence({ tombstonedBy: 'tomb-1' as TombstoneId });
    const corrected = correctionOf(
      original,
      {},
      { id: 'ev-2' as EvidenceId, contentHash: 'ch2', recordedAt: T0 },
    );
    expect(corrected.tombstonedBy).toBeNull();
  });

  it('recognises user-confirmed evidence', () => {
    expect(isUserConfirmed(evidence({ evidenceClass: 'user_confirmed' }))).toBe(true);
    expect(isUserConfirmed(evidence({ evidenceClass: 'imported' }))).toBe(false);
    expect(isUserConfirmed(evidence({ evidenceClass: 'derived' }))).toBe(false);
  });

  it('recognises a tombstoned record', () => {
    expect(isTombstoned(evidence({ tombstonedBy: 'tomb-1' as TombstoneId }))).toBe(true);
    expect(isTombstoned(evidence())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('work units', () => {
  it('takes the most restrictive member sensitivity', () => {
    expect(deriveSensitivity(['public', 'restricted', 'internal'])).toBe('restricted');
  });

  it('refuses to rewrite a pinned unit', () => {
    expect(isRewritable({ pinned: false, tombstonedBy: null })).toBe(true);
    expect(isRewritable({ pinned: true, tombstonedBy: null })).toBe(false);
    expect(isRewritable({ pinned: false, tombstonedBy: 'tomb' as TombstoneId })).toBe(false);
  });

  it('treats human-assigned membership as pinning', () => {
    expect(pinsUnit({ assignedBy: 'user' })).toBe(true);
    expect(pinsUnit({ assignedBy: 'strategy' })).toBe(false);
  });

  describe('substance threshold', () => {
    const threshold = {
      minDurationMinutes: 5,
      minDistinctArtifacts: 3,
      commitQualifiesAlone: true,
    };

    it('admits work that ran long enough', () => {
      expect(
        meetsThreshold({ durationMinutes: 40, distinctArtifacts: 1, hasCommit: false }, threshold),
      ).toBe(true);
    });

    it('admits work that touched enough artifacts', () => {
      expect(
        meetsThreshold({ durationMinutes: 1, distinctArtifacts: 9, hasCommit: false }, threshold),
      ).toBe(true);
    });

    it('admits a commit however brief — a merged change is completed work', () => {
      expect(
        meetsThreshold({ durationMinutes: 0.2, distinctArtifacts: 0, hasCommit: true }, threshold),
      ).toBe(true);
    });

    it('excludes the sub-minute fragments that are 90% of session files', () => {
      expect(
        meetsThreshold({ durationMinutes: 0.4, distinctArtifacts: 0, hasCommit: false }, threshold),
      ).toBe(false);
    });

    it('honours a configuration where commits do not qualify alone', () => {
      expect(
        meetsThreshold(
          { durationMinutes: 0.2, distinctArtifacts: 0, hasCommit: true },
          { ...threshold, commitQualifiesAlone: false },
        ),
      ).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('gaps', () => {
  const gap = (overrides: Partial<Gap> = {}): Gap => ({
    id: 'gap-1' as GapId,
    workUnitId: 'wu-1' as WorkUnitId,
    gapType: 'metric',
    question: 'Approximately how many users were affected?',
    rationale: 'A scope claim would strengthen this bullet.',
    status: 'open',
    answeredBy: null,
    askedCount: 0,
    lastAskedAt: null,
    ...overrides,
  });

  it('maps every support failure to a question type', () => {
    const codes: SupportFailureCode[] = [
      'no_support',
      'interpretation_only',
      'role_requires_confirmation',
      'metric_requires_derived_or_confirmed',
      'scope_requires_corroborating_evidence',
      'outcome_requires_evidence',
    ];
    for (const code of codes) {
      expect(gapTypeForFailure(code, 'action'), code).toBeTruthy();
    }
    expect(gapTypeForFailure('role_requires_confirmation', 'role')).toBe('role');
    expect(gapTypeForFailure('metric_requires_derived_or_confirmed', 'metric')).toBe('metric');
    expect(gapTypeForFailure('scope_requires_corroborating_evidence', 'scope')).toBe('scope');
    expect(gapTypeForFailure('no_support', 'metric')).toBe('metric');
    expect(gapTypeForFailure('no_support', 'action')).toBe('context');
  });

  it('asks only open questions', () => {
    expect(isAskable(gap({ status: 'open' }))).toBe(true);
    for (const status of ['answered', 'declined', 'stale'] as const) {
      expect(isAskable(gap({ status })), status).toBe(false);
    }
  });

  it('never re-raises an answered question', () => {
    const existing = [gap({ status: 'answered' })];
    expect(
      isAlreadyAnswered({ workUnitId: 'wu-1' as WorkUnitId, gapType: 'metric' }, existing),
    ).toBe(true);
  });

  it('never re-raises a declined question', () => {
    const existing = [gap({ status: 'declined' })];
    expect(
      isAlreadyAnswered({ workUnitId: 'wu-1' as WorkUnitId, gapType: 'metric' }, existing),
    ).toBe(true);
  });

  it('still raises a different question type for the same unit', () => {
    const existing = [gap({ status: 'answered', gapType: 'metric' })];
    expect(isAlreadyAnswered({ workUnitId: 'wu-1' as WorkUnitId, gapType: 'role' }, existing)).toBe(
      false,
    );
  });

  it('still raises the same question for a different unit', () => {
    const existing = [gap({ status: 'answered' })];
    expect(
      isAlreadyAnswered({ workUnitId: 'wu-2' as WorkUnitId, gapType: 'metric' }, existing),
    ).toBe(false);
  });

  it('records asking without mutating the original', () => {
    const original = gap();
    const asked = markAsked(original, T0);
    expect(asked.askedCount).toBe(1);
    expect(asked.lastAskedAt).toBe(T0);
    expect(original.askedCount).toBe(0);
  });

  it('closes a gap when answered, linking the evidence', () => {
    const answered = markAnswered(gap(), 'ev-9' as EvidenceId);
    expect(answered.status).toBe('answered');
    expect(answered.answeredBy).toBe('ev-9');
    expect(isAskable(answered)).toBe(false);
  });

  it('closes a gap when declined', () => {
    expect(isAskable(markDeclined(gap()))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('enrichment', () => {
  const run = (overrides: Partial<EnrichmentRun> = {}): EnrichmentRun => ({
    id: 'run-1' as EnrichmentRunId,
    providerId: 'openai',
    model: 'model-x',
    paramsHash: 'p1',
    promptTemplate: 'skills@1',
    promptHash: 'pr1',
    inputIds: ['ev-1'],
    inputHash: 'in1',
    policyDecisionId: 'pd-1',
    redactionProfile: 'default@1',
    startedAt: T0,
    completedAt: T0,
    status: 'completed',
    ...overrides,
  });

  it('reuses an identical completed run instead of calling a provider', () => {
    expect(isCacheHit(run(), run())).toBe(true);
  });

  it('does not reuse a failed or running run', () => {
    expect(isCacheHit(run({ status: 'failed' }), run())).toBe(false);
    expect(isCacheHit(run({ status: 'running' }), run())).toBe(false);
  });

  it('does not reuse across a changed model, prompt, params, or inputs', () => {
    expect(isCacheHit(run(), run({ model: 'model-y' }))).toBe(false);
    expect(isCacheHit(run(), run({ promptHash: 'pr2' }))).toBe(false);
    expect(isCacheHit(run(), run({ paramsHash: 'p2' }))).toBe(false);
    expect(isCacheHit(run(), run({ inputHash: 'in2' }))).toBe(false);
  });

  it('flags staleness when inputs are superseded', () => {
    expect(isStale(run(), 'in2')).toBe(true);
    expect(isStale(run(), 'in1')).toBe(false);
  });

  it('supersedes rather than overwrites', () => {
    const original: Enrichment = {
      id: 'enr-1' as EnrichmentId,
      runId: 'run-1' as EnrichmentRunId,
      targetKind: 'work_unit',
      targetId: 'wu-1' as WorkUnitId,
      enrichmentType: 'skills',
      value: ['typescript'],
      confidence: 0.8,
      supersededBy: null,
      recordedAt: T0,
    };
    const superseded = supersede(original, 'enr-2' as EnrichmentId);
    expect(superseded.supersededBy).toBe('enr-2');
    expect(superseded.value).toEqual(['typescript']);
    expect(original.supersededBy).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('provenance', () => {
  const edge = (overrides: Partial<ProvenanceEdge> = {}): ProvenanceEdge => ({
    id: 'pe-1' as ProvenanceEdgeId,
    fromKind: 'evidence',
    fromId: 'ev-1',
    toKind: 'claim',
    toId: 'cl-1',
    relation: 'supports',
    weight: null,
    recordedAt: T0,
    ...overrides,
  });

  it('treats only `supports` as carrying support', () => {
    expect(isSupportingRelation('supports')).toBe(true);
    for (const relation of PROVENANCE_RELATIONS.filter((r) => r !== 'supports')) {
      expect(isSupportingRelation(relation), relation).toBe(false);
    }
  });

  it('never lets an interpretation count as support', () => {
    // The distinction the whole provenance model exists to make.
    expect(isSupportingRelation('interprets')).toBe(false);
  });

  it('rejects malformed edges', () => {
    expect(isWellFormed(edge({ fromId: '' }))).toBe(false);
    expect(isWellFormed(edge({ fromKind: 'claim', fromId: 'cl-1', toId: 'cl-1' }))).toBe(false);
    expect(isWellFormed(edge({ relation: 'supports', toKind: 'evidence' }))).toBe(false);
    expect(isWellFormed(edge({ relation: 'answers', toKind: 'claim' }))).toBe(false);
    expect(isWellFormed(edge({ relation: 'grouped_into', toKind: 'claim' }))).toBe(false);
  });

  it('accepts well-formed edges', () => {
    expect(isWellFormed(edge())).toBe(true);
    expect(isWellFormed(edge({ relation: 'answers', toKind: 'gap', toId: 'gap-1' }))).toBe(true);
    expect(
      isWellFormed(edge({ relation: 'grouped_into', toKind: 'work_unit', toId: 'wu-1' })),
    ).toBe(true);
  });

  it('collects only supporting edges for a claim', () => {
    const edges = [
      edge({ id: 'a' as ProvenanceEdgeId }),
      edge({ id: 'b' as ProvenanceEdgeId, relation: 'interprets', fromKind: 'enrichment' }),
      edge({ id: 'c' as ProvenanceEdgeId, toId: 'cl-2' }),
    ];
    const found = supportEdgesFor('cl-1', edges);
    expect(found.map((e) => e.id)).toEqual(['a']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('assets', () => {
  const asset = (overrides: Partial<Asset> = {}): Asset => ({
    id: 'as-1' as AssetId,
    assetType: 'resume_bullet',
    workUnitId: 'wu-1' as WorkUnitId,
    runId: null,
    renderedText: 'Implemented Intune compliance policies for 50+ users.',
    reviewState: 'draft',
    revisionOf: null,
    editedBy: null,
    recordedAt: T0,
    ...overrides,
  });

  it('refuses to export an unreviewed draft', () => {
    expect(isExportable(asset({ reviewState: 'draft' }))).toBe(false);
  });

  it('exports anything a human has seen', () => {
    for (const state of REVIEW_STATES.filter((s) => s !== 'draft')) {
      expect(isExportable(asset({ reviewState: state })), state).toBe(true);
    }
  });

  it('creates a new asset on edit rather than overwriting', () => {
    const original = asset();
    const revised = revisionOf(original, 'Rolled out Intune policies to 50+ users.', {
      id: 'as-2' as AssetId,
      recordedAt: at('2026-07-31T00:00:00.000Z'),
    });
    expect(revised.revisionOf).toBe(original.id);
    expect(revised.editedBy).toBe('user');
    expect(revised.reviewState).toBe('reviewed');
    expect(original.renderedText).toContain('Implemented');
  });

  describe('edit classification', () => {
    it('treats rephrasing as a style signal', () => {
      expect(
        classifyEdit(['implemented policies', '50 users'], ['50 users', 'implemented policies']),
      ).toBe('wording');
    });

    it('treats an added claim as factual, not stylistic', () => {
      // Critical: otherwise the style loop quietly learns to assert things
      // the evidence never supported.
      expect(classifyEdit(['implemented policies'], ['implemented policies', 'led the team'])).toBe(
        'factual',
      );
    });

    it('treats a removed claim as factual', () => {
      expect(classifyEdit(['a', 'b'], ['a'])).toBe('factual');
    });

    it('treats a changed claim as factual', () => {
      expect(classifyEdit(['50 users'], ['500 users'])).toBe('factual');
    });

    it('treats an unchanged claim set as wording', () => {
      expect(classifyEdit(['a', 'b'], ['a', 'b'])).toBe('wording');
      expect(classifyEdit([], [])).toBe('wording');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('tombstones', () => {
  const tombstone = (overrides: Partial<Tombstone> = {}): Tombstone => ({
    id: 'tomb-1' as TombstoneId,
    targetKind: 'evidence',
    targetId: 'ev-1',
    reason: null,
    scope: 'hidden',
    recordedAt: T0,
    ...overrides,
  });

  it('suppresses from reads under every scope', () => {
    // A redacted or purged record has lost its content, so surfacing it would
    // imply evidence that is no longer there.
    for (const scope of TOMBSTONE_SCOPES) {
      expect(suppressedIds([tombstone({ scope })]).has('ev-1'), scope).toBe(true);
    }
  });

  it('only `hidden` is reversible', () => {
    expect(isReversible('hidden')).toBe(true);
    expect(isReversible('redacted')).toBe(false);
    expect(isReversible('purged')).toBe(false);
  });

  it('redacted and purged destroy content', () => {
    expect(destroysContent('hidden')).toBe(false);
    expect(destroysContent('redacted')).toBe(true);
    expect(destroysContent('purged')).toBe(true);
  });

  it('collects suppressed ids across many tombstones', () => {
    const ids = suppressedIds([
      tombstone({ targetId: 'ev-1' }),
      tombstone({ targetId: 'ev-2', scope: 'purged' }),
    ]);
    expect([...ids].sort()).toEqual(['ev-1', 'ev-2']);
  });

  it('returns an empty set when nothing is suppressed', () => {
    expect(suppressedIds([]).size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('attribution', () => {
  it('is self-asserted today', () => {
    expect(isSelfAsserted(SELF_ATTRIBUTION)).toBe(true);
    expect(isThirdPartyAttestation(SELF_ATTRIBUTION)).toBe(false);
  });

  it('can already express a peer attestation without a schema change', () => {
    // ADR-0011: the reason these two columns exist years before the feature.
    const attested = { subjectId: SELF, assertedBy: 'colleague-1' as IdentityId };
    expect(isThirdPartyAttestation(attested)).toBe(true);
  });

  it('can already express evidence about someone else', () => {
    const aboutReport = { subjectId: 'report-1' as IdentityId, assertedBy: SELF };
    expect(isThirdPartyAttestation(aboutReport)).toBe(true);
  });
});
