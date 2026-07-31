import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assessEvidence,
  describeSignal,
  evaluateSupport,
  isActionable,
  isExportable,
  isSupportingRelation,
  isWellFormed,
  maxSensitivity,
  sameAssessment,
  suggestImprovements,
  suppressedIds,
  toInstant,
  CLAIM_TYPES,
  EVIDENCE_GRADES,
  EVIDENCE_SIGNALS,
  GAP_TYPES,
  REVIEW_STATES,
  type SupportNode,
} from '@careerforge/domain';
import {
  generateBullet,
  spansAreExact,
  type CandidateRecord,
  type ProposedClaim,
} from '@careerforge/generate';
import { renderPage, BIND_HOST } from '@careerforge/ui';
import type { EnrichmentId, EvidenceId, ProvenanceEdgeId } from '@careerforge/domain';
import {
  createOpenAIProvider,
  evaluate,
  ProviderRefusedError,
  POLICY_RULES,
} from '@careerforge/policy';
import {
  explainDifference,
  templateFor,
  validateResponse,
  ENRICHABLE_TYPES,
  TEMPLATES,
} from '@careerforge/enrich';
import {
  canonicalJson,
  closeDatabase,
  ConsentStore,
  deterministicPlatform,
  EXPORT_FORMAT_VERSION,
  IN_MEMORY,
  openDatabase,
  ProvenanceStore,
  UnsupportedClaimError,
} from '@careerforge/store';
import { COMMAND_NAMES } from '@careerforge/cli';
import { describeConformance } from '@careerforge/collect';
import { GitCollector } from '@careerforge/collector-git';

/**
 * The invariant ledger.
 *
 * Working principle: *every architectural invariant should eventually have an
 * executable test.* Architecture should increasingly be something the suite
 * enforces rather than something contributors are expected to remember.
 *
 * This file is the ledger of that effort. Each of the six invariants from
 * `Architecture.md` §1.2 appears exactly once, either enforced or explicitly
 * marked as awaiting the milestone that makes it enforceable. Nothing is
 * silently absent.
 *
 * When a milestone lands, its pending entries here become real tests. If this
 * file still says "pending" for something that shipped, that is a bug.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('I1 — the domain layer imports no adapter, no network, no AI', () => {
  it('is enforced by lint (see test/boundaries.test.ts)', () => {
    const config = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');
    expect(config).toContain('Invariant I1');
  });

  it('is enforced by the compiler — domain cannot see Node types at all', () => {
    // Stronger than the architecture asked for. TypeScript 6 stopped
    // auto-including ambient @types, so withholding them makes `import fs`
    // a compile error as well as a lint error.
    const tsconfig: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/domain/tsconfig.json'), 'utf8'),
    );
    const types = (tsconfig as { compilerOptions?: { types?: string[] } }).compilerOptions?.types;
    expect(types ?? []).toEqual([]);
  });

  it('is enforced by the manifest — domain declares no dependencies', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/domain/package.json'), 'utf8'),
    );
    expect((manifest as { dependencies?: object }).dependencies ?? {}).toEqual({});
  });
});

describe('I2 — no UPDATE or DELETE against domain tables', () => {
  it('is expressed in the domain as supersede-and-tombstone', () => {
    const suppressed = suppressedIds([
      {
        id: 'tomb-1' as never,
        targetKind: 'evidence',
        targetId: 'ev-1',
        reason: null,
        scope: 'hidden',
        recordedAt: '2026-07-30T00:00:00.000Z' as never,
      },
    ]);
    expect(suppressed.has('ev-1')).toBe(true);
  });

  it('is enforced by the database, not by convention', () => {
    // Raw SQL, bypassing every repository and every good intention.
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      db.prepare(
        `INSERT INTO evidence (id, schema_version, collector_id, source_uri, natural_key,
           content_hash, kind, evidence_class, sensitivity, occurred_at, recorded_at, collector_version)
         VALUES ('ev-1',1,'git','u','nk','ch','git.commit','imported','public',
                 '2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z','1.0.0')`,
      ).run();
      expect(() => db.prepare(`UPDATE evidence SET kind='x'`).run()).toThrow(/append-only/);
      expect(() => db.prepare(`DELETE FROM evidence`).run()).toThrow(/append-only/);
    } finally {
      closeDatabase(db);
    }
  });

  it('covers every domain table, with no exempt list to remember', () => {
    // ADR-0013 made append-only universal. The per-table coverage check lives
    // in packages/store/src/append-only.test.ts and fails if a table is added
    // without its guards.
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const tables = (
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      const triggers = new Set(
        (
          db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
      expect(tables.filter((t) => !triggers.has(`${t}_no_update`))).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  it('reads resolve current state through views, never base tables', () => {
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const views = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='view'`).all() as { name: string }[]
      ).map((r) => r.name);
      expect(views).toContain('evidence_current');
    } finally {
      closeDatabase(db);
    }
  });
});

describe('I3 — every outbound call passes through the Policy Engine', () => {
  it('is enforced by lint for module imports and the global fetch', () => {
    const config = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');
    expect(config).toContain('Invariant I3');
    expect(config).toContain('no-restricted-globals');
  });

  it('is enforced by CI running the whole suite with no provider credentials', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('no-api-key');
    expect(workflow).toContain('OPENAI_API_KEY');
  });

  it('has its comparison rule available as a pure function', () => {
    // The domain states which sensitivity may go where. It performs no
    // egress and knows nothing about providers.
    expect(maxSensitivity(['public', 'restricted'])).toBe('restricted');
  });

  it('refuses an egress without a matching grant', () => {
    const decision = evaluate(
      {
        provider: { id: 'openai', locality: 'remote' },
        purpose: 'enrich',
        items: [
          {
            kind: 'evidence',
            id: 'ev-1',
            sensitivity: 'confidential',
            projectKey: 'acme',
            text: 'work',
          },
        ],
      },
      { consent: () => null },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.payload).toBe('');
  });

  it('writes a PolicyDecision for every evaluation, permitted or not', () => {
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const consent = new ConsentStore(db, deterministicPlatform());
      for (let n = 0; n < 3; n++) {
        consent.recordDecision(
          evaluate(
            {
              provider: { id: 'openai', locality: 'remote' },
              purpose: 'enrich',
              items: [
                {
                  kind: 'evidence',
                  id: `ev-${n}`,
                  sensitivity: 'public',
                  projectKey: null,
                  text: 'x',
                },
              ],
            },
            { consent: () => null },
          ),
        );
      }
      // N calls, N rows. A trail with only the permitted calls would answer
      // "what left?" and not "what was attempted?" (ADR-0009).
      expect(consent.decisionCount()).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });

  it('every policy refusal names a rule and what would change it', () => {
    // The principle applies wherever CareerForge says no: a refusal without a
    // next step is an obstacle rather than a guide (ADR-0022).
    const decision = evaluate(
      {
        provider: { id: 'openai', locality: 'remote' },
        purpose: 'enrich',
        items: [
          {
            kind: 'evidence',
            id: 'ev-1',
            sensitivity: 'restricted',
            projectKey: 'acme',
            text: 'work',
          },
        ],
      },
      { consent: () => null },
    );
    for (const refusal of decision.refusals) {
      expect(POLICY_RULES).toContain(refusal.rule);
      expect(isActionable(refusal.remedy)).toBe(true);
    }
  });

  it('refuses every claim type with a remedy, not merely a reason', () => {
    // The same rule for the refusal users meet most often.
    for (const claimType of CLAIM_TYPES) {
      const verdict = evaluateSupport(claimType, []);
      if (verdict.supported) throw new Error(`${claimType} should be unsupported with no support`);
      expect(isActionable(verdict.remedy), `${claimType} has no actionable remedy`).toBe(true);
    }
  });
});

describe('I4 — every claim resolves to at least one provenance edge', () => {
  it('refuses a claim with no support', () => {
    expect(evaluateSupport('action', []).supported).toBe(false);
  });

  it('refuses a claim supported only by AI interpretation', () => {
    const interpretationOnly: SupportNode[] = [{ kind: 'enrichment', id: 'en-1' as EnrichmentId }];
    expect(evaluateSupport('action', interpretationOnly).supported).toBe(false);
  });

  it('never infers a role claim', () => {
    const activity: SupportNode[] = [
      { kind: 'evidence', id: 'ev-1' as EvidenceId, evidenceClass: 'imported' },
    ];
    expect(evaluateSupport('role', activity).supported).toBe(false);
  });

  it('never accepts a model-generated metric', () => {
    const notComputed: SupportNode[] = [
      { kind: 'evidence', id: 'ev-1' as EvidenceId, evidenceClass: 'imported' },
    ];
    expect(evaluateSupport('metric', notComputed).supported).toBe(false);
  });

  it('keeps interpretation out of the supporting relation set', () => {
    expect(isSupportingRelation('supports')).toBe(true);
    expect(isSupportingRelation('interprets')).toBe(false);
  });

  it('refuses to persist a claim the predicate rejects', () => {
    // The predicate is the rule; this is the rule reaching the write path.
    // A claim row without support that satisfies its type would be a sentence
    // on somebody's résumé that nothing in their history backs up, so the
    // store refuses rather than warning. The full negative matrix lives in
    // packages/store/src/provenance.test.ts.
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const store = new ProvenanceStore(db, deterministicPlatform());
      db.prepare(
        `INSERT INTO assets (id, asset_type, work_unit_id, content, review_state, recorded_at)
         VALUES ('a1','resume_bullet',NULL,'x','draft','2026-05-04T09:00:00.000Z')`,
      ).run();

      expect(() =>
        store.recordClaim({ assetId: 'a1', text: 'Led it', span: [0, 6], claimType: 'role' }, []),
      ).toThrow(UnsupportedClaimError);
      expect((db.prepare('SELECT COUNT(*) n FROM claims').get() as { n: number }).n).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('will not let the graph express an enrichment as support', () => {
    // Two guards for the distinction the product rests on: the predicate
    // rejects interpretation-only support, and the graph cannot record the
    // edge at all (ADR-0020).
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      expect(
        isWellFormed({
          id: 'pe-1' as ProvenanceEdgeId,
          fromKind: 'enrichment',
          fromId: 'en-1',
          toKind: 'claim',
          toId: 'cl-1',
          relation: 'supports',
          weight: null,
          corroborating: false,
          recordedAt: toInstant('2026-05-04T09:00:00.000Z'),
        }),
      ).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('I5 — the database is reconstructible from the export', () => {
  it('has a rebuild path, and it is a first-class command', () => {
    // The full 10,000-record round trip, and the collect -> export -> rebuild
    // -> re-collect -> export scenario, live in
    // packages/store/src/export.test.ts where the fixtures are.
    expect(COMMAND_NAMES).toContain('export');
    expect(COMMAND_NAMES).toContain('rebuild');
  });

  it('exports deterministically — no timestamp, sorted keys', () => {
    // Determinism is the precondition for the round trip. A generation
    // timestamp would make two exports of identical data differ.
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('versions the export format separately from the schema', () => {
    // ADR-0004: the database may be refactored freely; the export is a
    // long-term contract with the user and changes far less often.
    expect(EXPORT_FORMAT_VERSION).toBeGreaterThan(0);
  });
});

describe('I6 — collectors emit records and never write', () => {
  it('gives collectors nowhere for a store to arrive', () => {
    // Held by the shape of the interface: collect(scope, cursor) takes no
    // database, and the host is the only thing that writes.
    const collector = new GitCollector();
    const surface = new Set(Object.keys(collector));
    for (const forbidden of ['db', 'store', 'database', 'connection']) {
      expect(surface.has(forbidden), `collector exposes ${forbidden}`).toBe(false);
    }
  });

  it('holds every collector to one shared conformance suite', () => {
    // The contract behind "a contributor should not need to understand the
    // whole codebase to write a collector". Exported for third parties to run
    // against their own collectors, in their own repositories.
    expect(typeof describeConformance).toBe('function');
  });

  it('requires backfill of every collector — it is the acquisition model', () => {
    expect(new GitCollector().describe().capabilities.backfill).toBe(true);
  });

  it('requires a declared narrow field set, for tolerant parsing', () => {
    // ADR-0010: depend on a few fields, ignore everything else, survive
    // upstream churn without a release.
    expect(new GitCollector().describe().requiredFields.length).toBeGreaterThan(0);
  });

  it('namespaces every emitted kind by the collector id', () => {
    const manifest = new GitCollector().describe();
    const misnamespaced = manifest.kinds.filter((k) => !k.startsWith(`${manifest.id}.`));
    expect(misnamespaced).toEqual([]);
  });
});

describe('an AI output is a reviewable artifact, never an authority', () => {
  it('lets no provider be reached except with a decision', async () => {
    // The structural claim behind invariant I3. A `ProviderCall` carries a
    // `PolicyDecision`, not a payload, so there is no parameter through which
    // a caller could substitute bytes the engine never saw. The refused case
    // proves the guard runs before anything else.
    const refused = evaluate(
      {
        provider: { id: 'openai', locality: 'remote' },
        purpose: 'enrich',
        items: [
          {
            kind: 'evidence',
            id: 'ev-1',
            sensitivity: 'internal',
            projectKey: 'acme',
            text: 'some work',
          },
        ],
      },
      { consent: () => null },
    );

    let called = false;
    const provider = createOpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: async () => {
        called = true;
        throw new Error('should never be reached');
      },
    });

    await expect(
      provider({
        decision: refused,
        model: 'gpt-test',
        params: { temperature: 0, maxOutputTokens: 100 },
        instructions: 'anything',
        schema: {},
        schemaName: 'test',
      }),
    ).rejects.toBeInstanceOf(ProviderRefusedError);
    expect(called).toBe(false);
  });

  it('freezes every published prompt against a committed lockfile', () => {
    // Editing a published template would make every run record naming it a
    // lie: the record names text that never ran (ADR-0023).
    const lock: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/enrich/src/templates.lock.json'), 'utf8'),
    );
    expect(Object.keys(lock as object).sort()).toEqual(Object.keys(TEMPLATES).sort());
  });

  it('publishes a prompt only for types it can do well', () => {
    // `leadership` is named in the domain and deliberately unimplemented.
    // Shipping a weak prompt for it would be worse than shipping none: it is
    // the claim type most likely to end a career.
    expect(ENRICHABLE_TYPES.length).toBeGreaterThan(0);
    for (const type of ENRICHABLE_TYPES) expect(templateFor(type)).not.toBeNull();
    expect(templateFor('leadership')).toBeNull();
  });

  it('requires every prompt to demand a citation, in the schema and not only in prose', () => {
    for (const template of Object.values(TEMPLATES)) {
      const properties = template.schema['properties'] as Record<string, { items?: unknown }>;
      const item = (Object.values(properties)[0]?.items ?? {}) as { required?: string[] };
      expect(item.required, `${template.id} does not require a citation`).toContain('evidence');
    }
  });

  it('discards an interpretation citing a record that was never sent', () => {
    const template = templateFor('skills')!;
    const result = validateResponse(
      {
        skills: [
          { name: 'real', category: 'engineering', rationale: 'r', evidence: ['01SENT'] },
          { name: 'invented', category: 'engineering', rationale: 'r', evidence: ['01NEVER'] },
        ],
      },
      template,
      ['01SENT'],
    );
    expect(result.items).toHaveLength(1);
    expect(result.rejections[0]!.reason).toBe('fabricated_citation');
  });

  it('names the setting when a provider is not configured, and says what still works', async () => {
    // A missing key must never look like a broken product. AI is additive
    // (ADR-0005), so the refusal has to say so.
    const provider = createOpenAIProvider({ apiKey: undefined });
    const allowed = evaluate(
      {
        provider: { id: 'ollama', locality: 'local' },
        purpose: 'enrich',
        items: [
          {
            kind: 'evidence',
            id: 'ev-1',
            sensitivity: 'public',
            projectKey: null,
            text: 'some work',
          },
        ],
      },
      { consent: () => null },
    );

    try {
      await provider({
        decision: allowed,
        model: 'gpt-test',
        params: { temperature: 0, maxOutputTokens: 100 },
        instructions: 'anything',
        schema: {},
        schemaName: 'test',
      });
      expect.unreachable('should have refused');
    } catch (error) {
      const refusal = (error as ProviderRefusedError).refusals[0]!;
      expect(refusal.rule).toBe('provider-configured@1');
      expect(isActionable(refusal.remedy)).toBe(true);
      expect(refusal.remedy).toMatchObject({ kind: 'configure', setting: 'OPENAI_API_KEY' });
    }
  });

  it('attributes a changed answer rather than merely reporting one', () => {
    // The user's question is never "did this change?" — it is "why?".
    const base = {
      templateId: 'skills@1',
      promptHash: 'p1',
      paramsHash: 'a1',
      inputHash: 'i1',
      inputIds: ['01EV1'],
      providerId: 'openai',
      model: 'gpt-5',
      resolvedModel: 'gpt-5-2026-01-01',
    };
    expect(explainDifference(base, base, false)).toEqual([]);
    // Identical on every recorded dimension and a different answer: the model
    // itself. Reporting "nothing changed" here would teach a user to distrust
    // the record.
    expect(explainDifference(base, base, true)[0]!.dimension).toBe('model_nondeterminism');
    expect(
      explainDifference(base, { ...base, resolvedModel: 'gpt-5-2026-06-01' }, true)[0]!.dimension,
    ).toBe('model_build');
  });

  it('gives enrichment no route to write a fact', () => {
    // ADR-0002 as a property of the build graph. The package that talks to
    // models cannot reach the tables that hold fact.
    const manifest: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/enrich/package.json'), 'utf8'),
    );
    const deps = Object.keys(
      (manifest as { dependencies?: Record<string, string> }).dependencies ?? {},
    );
    expect(deps).not.toContain('@careerforge/store');
    expect(deps).not.toContain('better-sqlite3');
  });
});

describe('a generated claim is checked before it is written, never after', () => {
  const record = (overrides: Partial<CandidateRecord> = {}): CandidateRecord => ({
    id: '01A',
    collectorId: 'git',
    kind: 'git.commit',
    evidenceClass: 'imported',
    attributes: {},
    text: 'rewrote the reader',
    suppressed: false,
    ...overrides,
  });

  const generate = (proposals: readonly ProposedClaim[], available = [record()]) =>
    generateBullet(proposals, { workUnitId: '01WU', available, openQuestionCount: 0 });

  const ACTION: ProposedClaim = {
    text: 'rewrote the transcript reader',
    claimType: 'action',
    evidence: ['01A'],
  };

  it.each(CLAIM_TYPES)('never lets an unsupported %s claim reach the text', (claimType) => {
    // Every claim type, against evidence that records activity and nothing
    // else. `action` is the only one activity alone can carry, and that is the
    // whole taxonomy working as designed.
    const bullet = generate([{ text: 'did the thing somehow', claimType, evidence: ['01A'] }]);
    if (claimType === 'action') {
      expect(bullet.claims).toHaveLength(1);
      return;
    }
    expect(bullet.claims, `${claimType} survived on activity alone`).toEqual([]);
    expect(bullet.text).toBe('');
    expect(bullet.dropped[0]!.gapType).toBeDefined();
  });

  it('leaves no trace of a dropped claim in the rendered text', () => {
    // The guarantee that makes this mechanical rather than diligent: the
    // sentence is composed from survivors, so there is nothing to strip out.
    const bullet = generate([
      ACTION,
      { text: 'led the entire migration', claimType: 'role', evidence: ['01A'] },
    ]);
    expect(bullet.text).toBe('Rewrote the transcript reader.');
    for (const word of ['led', 'entire', 'migration']) {
      expect(bullet.text.toLowerCase()).not.toContain(word);
    }
  });

  it('never hedges — there is no code path from a failed claim to weaker words', () => {
    const bullet = generate([
      ACTION,
      { text: 'led the migration', claimType: 'role', evidence: ['01A'] },
    ]);
    expect(bullet.text).not.toMatch(/helped|contributed|assisted|involved in|part of/i);
  });

  it('places every claim exactly where it says it is', () => {
    // An explanation highlighting the wrong characters says something
    // confident and false about which part of a bullet the evidence covers.
    const bullet = generate([
      ACTION,
      { text: 'removed the buffering path', claimType: 'action', evidence: ['01A'] },
      { text: 'added a streaming fixture', claimType: 'action', evidence: ['01A'] },
    ]);
    expect(spansAreExact({ text: bullet.text, claims: bullet.claims })).toBe(true);
  });

  it('turns every dropped claim into a question with a gap type', () => {
    const bullet = generate([
      { text: 'led it', claimType: 'role', evidence: ['01A'] },
      { text: 'by 40%', claimType: 'metric', evidence: ['01A'] },
    ]);
    expect(bullet.dropped).toHaveLength(2);
    for (const dropped of bullet.dropped) {
      expect(GAP_TYPES).toContain(dropped.gapType);
      expect(dropped.question.length).toBeGreaterThan(10);
      expect(isActionable(dropped.remedy)).toBe(true);
    }
  });
});

describe('an asset carries a description of its evidence, not a model score', () => {
  it('grades from counted records rather than anything a model said', () => {
    const assessment = assessEvidence({
      claimTypes: ['action'],
      support: [
        {
          id: 'a',
          collectorId: 'git',
          evidenceClass: 'imported',
          corroborating: false,
          suppressed: false,
          recordsOutcome: false,
        },
        {
          id: 'b',
          collectorId: 'session',
          evidenceClass: 'imported',
          corroborating: false,
          suppressed: false,
          recordsOutcome: false,
        },
      ],
      droppedClaimTypes: [],
      openQuestionCount: 0,
    });
    expect(assessment.grade).toBe('corroborated');
    expect(assessment.sourceCount).toBe(2);
  });

  it('offers named grades rather than a score, so nobody averages them', () => {
    expect(EVIDENCE_GRADES.every((grade) => typeof grade === 'string')).toBe(true);
    expect(EVIDENCE_GRADES).toHaveLength(4);
  });

  it('gives every signal a sentence, so a limit reads the same on every surface', () => {
    for (const signal of EVIDENCE_SIGNALS) {
      expect(describeSignal(signal).length, signal).toBeGreaterThan(20);
    }
  });

  it('is deterministic, so a stored assessment can be checked against a fresh one', () => {
    const input = {
      claimTypes: ['action'] as const,
      support: [],
      droppedClaimTypes: [] as const,
      openQuestionCount: 0,
    };
    expect(sameAssessment(assessEvidence(input), assessEvidence(input))).toBe(true);
  });
});

describe('nothing leaves without human approval', () => {
  it('permits only a reviewed asset, by allowlist', () => {
    // Written as a denylist, this was one added review state away from being
    // wrong — and the database already had that state.
    expect(isExportable({ reviewState: 'reviewed' })).toBe(true);
    for (const state of REVIEW_STATES.filter((s) => s !== 'reviewed')) {
      expect(isExportable({ reviewState: state }), state).toBe(false);
    }
  });

  it('agrees with the schema about what a review state is', () => {
    // The domain listed `exported` while the database permitted `rejected`.
    // Nothing caught it because nothing had written an asset row yet.
    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const sql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='assets'`).get() as {
          sql: string;
        }
      ).sql;
      for (const state of REVIEW_STATES) {
        expect(sql, `schema does not permit review_state '${state}'`).toContain(`'${state}'`);
      }
    } finally {
      closeDatabase(db);
    }
  });
});

describe('the Explorer explains rather than displays', () => {
  it('answers what evidence would make a statement stronger, with computed effects', () => {
    // The second question Evidence Explorer exists for. A list of what is
    // missing, with no indication of what any of it is worth, is a to-do list.
    const support = [
      {
        id: 'a',
        collectorId: 'git',
        evidenceClass: 'imported' as const,
        corroborating: false,
        suppressed: false,
        recordsOutcome: false,
      },
    ];
    const improvements = suggestImprovements({
      workUnitId: '01WU',
      assessment: assessEvidence({
        claimTypes: ['action'],
        support,
        droppedClaimTypes: [],
        openQuestionCount: 1,
      }),
      support,
      claimTypes: ['action'],
      openGaps: [{ id: '01G', gapType: 'role', question: 'Did you lead this?' }],
      outcomeCollectorAvailable: false,
    });

    expect(improvements.length).toBeGreaterThan(0);
    for (const improvement of improvements) {
      expect(improvement.effect.gradeNow).toBeDefined();
      expect(improvement.effect.gradeAfter).toBeDefined();
      expect(improvement.why.length).toBeGreaterThan(30);
    }
    // Best first: something that moves the grade outranks something that does not.
    expect(improvements[0]!.effect.raisesGrade || improvements[0]!.effect.unlocks.length > 0).toBe(
      true,
    );
  });

  it('serves the Explorer to this machine and offers no way to change that', () => {
    // A career store reachable from a local network fails very quietly.
    expect(BIND_HOST).toBe('127.0.0.1');
    const source = readFileSync(join(ROOT, 'packages/ui/src/server.ts'), 'utf8');
    expect(source).toContain('server.listen(port, BIND_HOST');
    expect(source).not.toMatch(/host\s*[:?]/i);
  });

  it('gives the UI no route to send anything', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/ui/package.json'), 'utf8'),
    );
    const deps = Object.keys(
      (manifest as { dependencies?: Record<string, string> }).dependencies ?? {},
    );
    expect(deps.sort()).toEqual(['@careerforge/domain', '@careerforge/store']);
  });

  it('renders a page that needs nothing from anywhere', () => {
    // A page about whether you can trust what you are reading must not make a
    // third party a participant in reading it.
    const page = renderPage({
      assets: [],
      units: [],
      questions: [],
      totals: { evidence: 0, units: 0, assets: 0, questions: 0 },
    });
    expect(page).not.toMatch(/<script[^>]+src=/i);
    expect(page).not.toMatch(/<link[^>]+href=/i);
    // And an empty store gets a screen full of what to do next, not "no data".
    expect(page).toContain('careerforge collect --backfill');
  });
});

describe('cross-cutting promises', () => {
  it('nothing leaves without human review — the gate is in the export path', () => {
    expect(isExportable({ reviewState: 'draft' })).toBe(false);
    expect(isExportable({ reviewState: 'reviewed' })).toBe(true);
  });

  it('a work unit is as sensitive as its most sensitive member', () => {
    expect(maxSensitivity(['public', 'internal', 'restricted', 'confidential'])).toBe('restricted');
  });

  it('every ADR states the conditions that would overturn it', () => {
    // A decision without falsification conditions is a belief. The ledger
    // principle applies to reasoning as much as to code.
    const adrDir = join(ROOT, 'docs/adr');
    const adrs = readdirSync(adrDir).filter((f) => /^\d{4}-.*\.md$/.test(f));
    expect(adrs.length).toBeGreaterThanOrEqual(12);
    for (const file of adrs) {
      const body = readFileSync(join(adrDir, file), 'utf8');
      expect(body, `${file} is missing a "Revisit if" section`).toContain('Revisit if');
      expect(body, `${file} is missing "Alternatives considered"`).toContain(
        'Alternatives considered',
      );
    }
  });

  it('every ADR appears in the index', () => {
    // The index had silently drifted four ADRs behind by M5. An index nobody
    // can trust is worse than no index, because it answers "is that all of
    // them?" with a confident no.
    const adrDir = join(ROOT, 'docs/adr');
    const index = readFileSync(join(adrDir, 'README.md'), 'utf8');
    const missing = readdirSync(adrDir)
      .filter((f) => /^\d{4}-.*\.md$/.test(f))
      .filter((f) => !index.includes(`(${f})`));
    expect(missing, 'ADRs not listed in docs/adr/README.md').toEqual([]);
  });
});
