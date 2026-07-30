import type { GroupCandidate } from '@careerforge/domain';

/**
 * Scoring grouping against hand-written labels.
 *
 * Two numbers, because grouping fails in two independent ways: it can draw the
 * boundaries badly, and it can decide the wrong things are worth keeping. A
 * single blended figure would let one hide inside the other.
 */

export interface Label {
  readonly rationale: string;
  /** One array per Work Unit a person would recognise. */
  readonly units: readonly (readonly string[])[];
  /** Evidence a person would call noise. */
  readonly excluded: readonly string[];
}

export interface CaseScore {
  readonly name: string;
  /** Pairwise agreement on which records belong together. */
  readonly pairF1: number;
  readonly pairPrecision: number;
  readonly pairRecall: number;
  /** Share of records whose keep-or-drop decision matched the label. */
  readonly admission: number;
  readonly expectedUnits: number;
  readonly actualUnits: number;
  /** Real work dropped as noise. The expensive mistake. */
  readonly lostRecords: readonly string[];
  /** Noise kept as real work. The annoying mistake. */
  readonly spuriousRecords: readonly string[];
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

function pairsWithin(units: readonly (readonly string[])[]): Set<string> {
  const pairs = new Set<string>();
  for (const unit of units) {
    for (let i = 0; i < unit.length; i++) {
      for (let j = i + 1; j < unit.length; j++) pairs.add(pairKey(unit[i]!, unit[j]!));
    }
  }
  return pairs;
}

/**
 * Score one case.
 *
 * Pairwise rather than exact cluster match, because exact match cannot
 * distinguish a unit that is right except for one stray member from one that
 * is wrong throughout, and that difference is most of what tuning is about.
 *
 * Only admitted candidates count as grouping. A record the strategy dropped
 * cannot also be grouped correctly, and counting it both ways would let a
 * strategy score well by admitting almost nothing.
 */
export function scoreCase(
  name: string,
  label: Label,
  candidates: readonly GroupCandidate[],
): CaseScore {
  const admitted = candidates.filter((candidate) => candidate.admitted);

  const expectedPairs = pairsWithin(label.units);
  const actualPairs = pairsWithin(admitted.map((candidate) => [...candidate.members]));

  let truePositives = 0;
  for (const pair of actualPairs) if (expectedPairs.has(pair)) truePositives++;

  const precision = actualPairs.size === 0 ? 1 : truePositives / actualPairs.size;
  const recall = expectedPairs.size === 0 ? 1 : truePositives / expectedPairs.size;
  const pairF1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const shouldKeep = new Set(label.units.flat());
  const shouldDrop = new Set(label.excluded);
  const kept = new Set<string>(admitted.flatMap((candidate) => candidate.members));

  const lost = [...shouldKeep].filter((id) => !kept.has(id)).sort();
  const spurious = [...shouldDrop].filter((id) => kept.has(id)).sort();

  const decisions = shouldKeep.size + shouldDrop.size;
  const correct = decisions - lost.length - spurious.length;

  return {
    name,
    pairF1,
    pairPrecision: precision,
    pairRecall: recall,
    admission: decisions === 0 ? 1 : correct / decisions,
    expectedUnits: label.units.length,
    actualUnits: admitted.length,
    lostRecords: lost,
    spuriousRecords: spurious,
  };
}

export interface Aggregate {
  readonly pairF1: number;
  readonly admission: number;
  readonly cases: number;
  readonly perfect: number;
}

/**
 * Unweighted mean across cases.
 *
 * Deliberately not weighted by record count: each case encodes one judgment
 * about what a Work Unit is, and a judgment illustrated with six records is
 * not three times more important than one illustrated with two.
 */
export function aggregate(scores: readonly CaseScore[]): Aggregate {
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    pairF1: mean(scores.map((score) => score.pairF1)),
    admission: mean(scores.map((score) => score.admission)),
    cases: scores.length,
    perfect: scores.filter(
      (score) =>
        score.pairF1 === 1 && score.admission === 1 && score.expectedUnits === score.actualUnits,
    ).length,
  };
}

export function formatScores(scores: readonly CaseScore[]): string {
  const width = Math.max(...scores.map((score) => score.name.length));
  const pct = (value: number): string => `${(value * 100).toFixed(0)}%`.padStart(4);

  const lines = scores.map((score) => {
    const flags = [
      score.expectedUnits === score.actualUnits
        ? ''
        : `units ${score.actualUnits}, expected ${score.expectedUnits}`,
      score.lostRecords.length > 0 ? `lost ${score.lostRecords.join(', ')}` : '',
      score.spuriousRecords.length > 0 ? `kept noise ${score.spuriousRecords.join(', ')}` : '',
    ].filter((flag) => flag !== '');

    return (
      `  ${score.name.padEnd(width)}  F1 ${pct(score.pairF1)}  admit ${pct(score.admission)}` +
      (flags.length > 0 ? `   ${flags.join(' · ')}` : '')
    );
  });

  const total = aggregate(scores);
  return [
    'grouping evaluation',
    ...lines,
    '',
    `  ${'AGGREGATE'.padEnd(width)}  F1 ${pct(total.pairF1)}  admit ${pct(total.admission)}` +
      `   ${total.perfect}/${total.cases} cases exactly right`,
  ].join('\n');
}
