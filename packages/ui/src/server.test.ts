import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toInstant, type EvidenceDraft } from '@careerforge/domain';
import { generateBullet, type CandidateRecord } from '@careerforge/generate';
import {
  AssetStore,
  closeDatabase,
  EvidenceStore,
  IN_MEMORY,
  openDatabase,
  WorkUnitStore,
  deterministicPlatform,
  type Db,
} from '@careerforge/store';

import { renderPage } from './page.js';
import { readExplorerView, recordAnswer } from './reader.js';
import { BIND_HOST, createExplorerServer } from './server.js';

/**
 * The Explorer against a real store, and against a real socket.
 *
 * Two things are load-bearing here and only one of them is the HTML. The other
 * is the binding: a career store served to a local network is a serious
 * mistake with a very quiet failure mode, so the address is asserted rather
 * than assumed.
 */

const platform = deterministicPlatform();

let db: Db;
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
  title: `Rewrote the reader, pass ${n}`,
  summary: null,
  excerpt: null,
  payloadRef: null,
  attributes: { files: ['src/reader.ts'] },
  groupingHint: null,
  collectorVersion: '1.0.0',
  sourceFormatVersion: null,
  ...overrides,
});

beforeEach(() => {
  db = openDatabase({ path: IN_MEMORY }).db;
});

afterEach(() => {
  closeDatabase(db);
});

/** A store with evidence, a unit, and one generated bullet. */
function seed(): { assetId: string } {
  const evidence = new EvidenceStore(db, platform);
  evidenceIds = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => evidence.emit(draft(n)).evidence.id);
  const units = new WorkUnitStore(db, platform);
  units.group();
  workUnitId = units.currentUnits()[0]!.id;

  const available: CandidateRecord[] = evidenceIds.map((id, n) => ({
    id,
    collectorId: 'git',
    kind: 'git.commit',
    evidenceClass: 'imported',
    attributes: { files: ['src/reader.ts'] },
    text: `Rewrote the reader, pass ${n}`,
    suppressed: false,
  }));

  const bullet = generateBullet(
    [
      {
        text: 'rewrote the transcript reader to stream rather than buffer',
        claimType: 'action',
        evidence: [evidenceIds[0]!],
      },
      { text: 'led the rewrite', claimType: 'role', evidence: [evidenceIds[0]!] },
    ],
    { workUnitId, available, openQuestionCount: 0 },
  );

  const recorded = new AssetStore(db, platform).record({
    assetType: 'resume_bullet',
    workUnitId,
    runId: null,
    bullet,
  });
  return { assetId: recorded.id };
}

describe('the server binds to this machine and nowhere else', () => {
  it('listens on loopback', async () => {
    // The one mistake this whole design is arranged to make impossible. A
    // career store — transcripts, client names, unguarded opinions — reachable
    // from a coffee-shop network fails very quietly.
    const explorer = await createExplorerServer({ db, port: 0 });
    try {
      const address = explorer.server.address();
      expect(typeof address === 'object' && address !== null).toBe(true);
      expect((address as { address: string }).address).toBe('127.0.0.1');
      expect(explorer.url).toContain('127.0.0.1');
    } finally {
      await explorer.close();
    }
  });

  it('offers no way to bind anywhere else', () => {
    // Asserted against the source, because the guarantee is the *absence* of
    // an option. A default is a suggestion; a constant is a decision.
    const source = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');
    expect(source).toContain("BIND_HOST = '127.0.0.1'");
    expect(BIND_HOST).toBe('127.0.0.1');
    // No option, environment variable, or flag reaches the listen call.
    expect(source).not.toMatch(/host\s*[:?]/i);
    expect(source).toContain('server.listen(port, BIND_HOST');
  });

  it('holds no network client of its own', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    );
    const deps = Object.keys(
      (manifest as { dependencies?: Record<string, string> }).dependencies ?? {},
    );
    expect(deps.sort()).toEqual(['@careerforge/domain', '@careerforge/store']);
  });
});

describe('the view a real store produces', () => {
  it('answers both questions for a generated bullet', () => {
    const { assetId } = seed();
    const view = readExplorerView(db);

    const asset = view.assets.find((candidate) => candidate.id === assetId)!;
    // Question one.
    expect(asset.claims[0]!.grounds.length).toBeGreaterThan(0);
    // Question two.
    expect(asset.improvements.length).toBeGreaterThan(0);
  });

  it('carries the question raised by the dropped role claim into the improvements', () => {
    seed();
    const asset = readExplorerView(db).assets[0]!;
    const answerable = asset.improvements.find((i) => i.action.kind === 'answer')!;
    expect(answerable.effect.unlocks).toContain('role');
  });

  it('reports sensitivity on every ground', () => {
    seed();
    const asset = readExplorerView(db).assets[0]!;
    expect(asset.claims[0]!.grounds.some((g) => g.sensitivity === 'internal')).toBe(true);
  });

  it('counts what a fresh store holds', () => {
    const view = readExplorerView(db);
    expect(view.totals).toEqual({ evidence: 0, units: 0, assets: 0, questions: 0 });
  });
});

describe('answering a question updates the page', () => {
  it('leaves the grade alone, because the sentence has not changed', () => {
    // The subtle and important case. Answering makes the *evidence* stronger
    // and leaves the *words* untouched — they still rest on the records they
    // were generated from. Showing an improved grade above unchanged text
    // would be a lie about what the reader is looking at.
    seed();
    expect(readExplorerView(db).assets[0]!.assessment.grade).toBe('observed');

    recordAnswer(db, readExplorerView(db).questions[0]!.id, 'I led this work.');

    expect(readExplorerView(db).assets[0]!.assessment.grade).toBe('observed');
  });

  it('says the statement has fallen behind its own evidence, at the top', () => {
    seed();
    recordAnswer(db, readExplorerView(db).questions[0]!.id, 'I led this work.');

    const improvements = readExplorerView(db).assets[0]!.improvements;
    expect(improvements[0]!.kind).toBe('regenerate_with_new_evidence');
    expect(improvements[0]!.summary).toContain('your answer is not in this statement yet');
    expect(improvements[0]!.why).toContain('did not change the words already written');
  });

  it('closes the question it answered', () => {
    seed();
    const gapId = readExplorerView(db).questions[0]!.id;
    recordAnswer(db, gapId, 'I led this work.');
    expect(readExplorerView(db).questions.map((q) => q.id)).not.toContain(gapId);
  });

  it('re-ranks what is left, because the best next step has changed', () => {
    seed();
    recordAnswer(db, readExplorerView(db).questions[0]!.id, 'I led this work.');

    const improvements = readExplorerView(db).assets[0]!.improvements;
    // The question that was answered is gone from the list entirely.
    expect(improvements.some((i) => i.action.kind === 'answer')).toBe(false);
    expect(improvements.map((i) => i.kind)).toContain('record_outcome');
  });
});

describe('the page', () => {
  it('renders a full document with everything inlined', () => {
    // A page about whether you can trust what you are reading must not fetch
    // a script from a third party.
    seed();
    const html = renderPage(readExplorerView(db));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toContain('//cdn');
  });

  it('declares a policy that permits nothing external', () => {
    seed();
    const html = renderPage(readExplorerView(db));
    expect(html).toContain('Evidence Explorer');
    expect(html).toContain('Nothing on this page has left it');
  });

  it('renders the empty state for a fresh store rather than a blank page', () => {
    const html = renderPage(readExplorerView(db));
    expect(html).toContain('Nothing collected yet');
    expect(html).not.toContain('undefined');
  });

  it('shows both halves of the screen for a generated bullet', () => {
    seed();
    const html = renderPage(readExplorerView(db));
    expect(html).toContain('Why CareerForge believes this');
    expect(html).toContain('What would make this stronger');
  });
});
