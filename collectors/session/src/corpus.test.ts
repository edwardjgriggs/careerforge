import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CursorStore,
  EvidenceStore,
  IN_MEMORY,
  closeDatabase,
  deterministicPlatform,
  openDatabase,
} from '@careerforge/store';
import { runCollection, formatReport } from '@careerforge/collect';

import { SessionCollector, defaultTranscriptRoot } from './index.js';

/**
 * The collector, run against whatever is actually on this machine.
 *
 * The fixture corpus proves the shapes we know about keep working. It cannot
 * prove anything about shapes nobody has seen yet, and this source produced 14
 * schema versions in 30 days — so the useful complement is a run against real
 * transcripts, which every developer of this project already has.
 *
 * Nothing here is committed and nothing is asserted about content. The test
 * asserts only that a real corpus does not break the collector, and prints
 * whatever drift it found so a format change surfaces on the run that
 * introduces it rather than in a bug report months later.
 *
 * It skips where there is no corpus, which includes CI. That is the trade:
 * this check runs where the data is, and the data does not belong in a
 * repository.
 */

const ROOT = defaultTranscriptRoot();
const AVAILABLE = existsSync(ROOT) && statSync(ROOT).isDirectory();

/** The whole corpus is hundreds of megabytes; a sample is the default. */
const FULL_SWEEP = process.env['CAREERFORGE_LIVE_CORPUS'] === '1';
const SAMPLED_PROJECTS = 3;

describe.runIf(AVAILABLE)('live corpus', () => {
  it('collects from real transcripts without throwing', async () => {
    const collector = new SessionCollector();
    const sources = await collector.discover(ROOT);
    expect(sources.length).toBeGreaterThan(0);

    const chosen = FULL_SWEEP
      ? sources
      : [...sources]
          .sort((a, b) => newestMtime(b.scope.location) - newestMtime(a.scope.location))
          .slice(0, SAMPLED_PROJECTS);

    const { db } = openDatabase({ path: IN_MEMORY });
    try {
      const platform = deterministicPlatform();
      const store = new EvidenceStore(db, platform);
      const cursors = new CursorStore(db, platform);

      const drift = new Map<string, number>();
      let emitted = 0;
      let seen = 0;

      for (const source of chosen) {
        const report = await runCollection({
          collector,
          scope: source.scope,
          store,
          cursors,
          backfill: true,
        });
        seen += report.seen;
        emitted += report.emitted;
        for (const [signal, count] of Object.entries(report.drift)) {
          drift.set(signal, (drift.get(signal) ?? 0) + count);
        }
        if (Object.keys(report.drift).length > 0) console.log(formatReport(report));
      }

      console.log(
        `live corpus: ${chosen.length}/${sources.length} project(s), ` +
          `${seen} transcript(s) examined, ${emitted} emitted` +
          (FULL_SWEEP ? '' : ' — set CAREERFORGE_LIVE_CORPUS=1 for the full sweep'),
      );

      // Not an assertion that drift is zero. Drift is expected and is the
      // reason the channel exists; the point is that it is visible and that
      // finding some did not stop the run.
      if (drift.size > 0) {
        console.log(
          `live corpus drift:\n${[...drift]
            .sort()
            .map(([signal, count]) => `  ${count} x ${signal}`)
            .join('\n')}`,
        );
      }

      expect(seen).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('reaches the same state twice over real data', async () => {
    // Determinism against fixtures is easy. Determinism against a corpus with
    // years of accumulated shapes is the claim that matters.
    const sources = await new SessionCollector().discover(ROOT);
    const newest = [...sources].sort(
      (a, b) => newestMtime(b.scope.location) - newestMtime(a.scope.location),
    )[0];
    if (newest === undefined) return;

    const fingerprints: string[] = [];
    for (let run = 0; run < 2; run++) {
      const { db } = openDatabase({ path: IN_MEMORY });
      try {
        const platform = deterministicPlatform();
        const store = new EvidenceStore(db, platform);
        await runCollection({
          collector: new SessionCollector(),
          scope: newest.scope,
          store,
          cursors: new CursorStore(db, platform),
          backfill: true,
        });
        fingerprints.push(
          JSON.stringify(
            store
              .all()
              .map((e) => [e.naturalKey, e.contentHash])
              .sort(),
          ),
        );
      } finally {
        closeDatabase(db);
      }
    }
    expect(fingerprints[0]).toBe(fingerprints[1]);
  });
});

function newestMtime(directory: string): number {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl'))
      .reduce((newest, name) => Math.max(newest, statSync(join(directory, name)).mtimeMs), 0);
  } catch {
    return 0;
  }
}

describe.runIf(!AVAILABLE)('live corpus', () => {
  it('is skipped where there is no corpus', () => {
    // Present so the absence is visible in the report rather than silent.
    expect(AVAILABLE).toBe(false);
  });
});
