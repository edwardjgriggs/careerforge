import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  groupContextTemporal,
  DEFAULT_GROUPING_CONFIG,
  type GroupableEvidence,
} from '@careerforge/domain';

import { aggregate, formatScores, scoreCase, type CaseScore, type Label } from './score.js';

/**
 * The grouping benchmark.
 *
 * The labels in `cases/` are the specification for what a Work Unit is. This
 * measures how close `context-temporal@1` gets, and the committed baseline
 * makes a regression a build failure rather than something noticed later.
 *
 * See `README.md` for how to add a case and why the labels come first.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = join(HERE, 'cases');
const BASELINE = join(HERE, 'baseline.json');

const caseNames = readdirSync(CASES)
  .filter((name) => statSync(join(CASES, name)).isDirectory())
  .sort();

function runCase(name: string): CaseScore {
  const dir = join(CASES, name);
  const evidence = JSON.parse(
    readFileSync(join(dir, 'evidence.json'), 'utf8'),
  ) as GroupableEvidence[];
  const label = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Label;
  return scoreCase(name, label, groupContextTemporal(evidence, DEFAULT_GROUPING_CONFIG));
}

describe('grouping evaluation', () => {
  it('found labelled cases to score', () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(8);
  });

  it('every case labels every record it contains', () => {
    // A record left out of both `units` and `excluded` is an unstated
    // judgment, and it would silently shrink the denominator of the score.
    for (const name of caseNames) {
      const dir = join(CASES, name);
      const evidence = JSON.parse(
        readFileSync(join(dir, 'evidence.json'), 'utf8'),
      ) as GroupableEvidence[];
      const label = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Label;

      const labelled = new Set([...label.units.flat(), ...label.excluded]);
      const present = evidence.map((record) => record.id).sort();
      expect([...labelled].sort(), `${name} labels records it does not contain`).toEqual(present);
      expect(label.rationale.length, `${name} has no rationale`).toBeGreaterThan(20);
    }
  });

  it('scores at or above the committed baseline', () => {
    const scores = caseNames.map(runCase);
    const total = aggregate(scores);

    console.log(formatScores(scores));

    if (!existsSync(BASELINE)) {
      writeFileSync(
        BASELINE,
        `${JSON.stringify(
          {
            pairF1: total.pairF1,
            admission: total.admission,
            perfect: total.perfect,
            cases: total.cases,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      throw new Error(
        'No baseline existed, so one was written from the current score. Review it and commit it.',
      );
    }

    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
      pairF1: number;
      admission: number;
      perfect: number;
    };

    // Tolerance for floating-point drift only. Any real regression fails.
    const epsilon = 1e-9;
    expect(
      total.pairF1 + epsilon,
      'grouping got worse. If this was a deliberate trade, update baseline.json in the same commit and say why.',
    ).toBeGreaterThanOrEqual(baseline.pairF1);
    expect(total.admission + epsilon, 'admission accuracy regressed').toBeGreaterThanOrEqual(
      baseline.admission,
    );
    expect(total.perfect, 'fewer cases are now exactly right').toBeGreaterThanOrEqual(
      baseline.perfect,
    );
  });

  it('is deterministic — the same evidence always groups the same way', () => {
    for (const name of caseNames) {
      const dir = join(CASES, name);
      const evidence = JSON.parse(
        readFileSync(join(dir, 'evidence.json'), 'utf8'),
      ) as GroupableEvidence[];

      const forwards = groupContextTemporal(evidence);
      // Reversed input, because a strategy that depends on the order rows come
      // back from a database would converge differently on two machines.
      const backwards = groupContextTemporal([...evidence].reverse());
      expect(JSON.stringify(backwards), `${name} depends on input order`).toBe(
        JSON.stringify(forwards),
      );
    }
  });
});
