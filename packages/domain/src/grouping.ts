import type { EvidenceId } from './ids.js';
import { compareInstants, epochMillisOf, type Instant } from './time.js';
import { maxSensitivity, type Sensitivity } from './sensitivity.js';
import { meetsThreshold, type SubstanceSignals, type SubstanceThreshold } from './work-unit.js';

/**
 * Grouping: turning a stream of artifacts into units of work.
 *
 * Pure, and deliberately so. Grouping must be identical on every machine for
 * sync to converge without a coordinator (ADR-0004), which means it cannot
 * depend on wall-clock time, a database, a locale, or a model. Given the same
 * evidence and the same strategy version, it produces the same answer or it is
 * broken.
 *
 * A strategy that needed a provider — the AI-based grouping ADR-0006 permits
 * later — would live in `enrich` and produce this same record shape. It would
 * not live here, because this package cannot see a network and should not.
 */

/** The minimum a strategy needs to know about a piece of evidence. */
export interface GroupableEvidence {
  readonly id: EvidenceId;
  readonly kind: string;
  readonly sensitivity: Sensitivity;
  readonly occurredAt: Instant;
  readonly occurredEnd: Instant | null;
  readonly projectKey: string | null;
  readonly stream: string | null;
  readonly title: string;
}

export interface GroupCandidate {
  /** Stable across runs, and the identity a re-run supersedes on. */
  readonly groupingKey: string;
  readonly projectKey: string | null;
  readonly stream: string | null;
  readonly occurredAt: Instant;
  readonly occurredEnd: Instant;
  readonly sensitivity: Sensitivity;
  readonly members: readonly EvidenceId[];
  /** Chosen from the members; a strategy never writes prose (ADR-0002). */
  readonly title: string;
  readonly admitted: boolean;
  /** Why it was or was not admitted, in words a user could act on. */
  readonly reason: string;
}

/**
 * Configuration, not constants.
 *
 * These will be wrong at first. Every one of them is tuned against the
 * evaluation corpus in `eval/grouping`, so a change to any of them is measured
 * rather than argued about.
 */
export interface GroupingConfig {
  /**
   * How long a pause can be before it is a different piece of work, when
   * nothing but proximity connects two artifacts.
   *
   * Deliberately shorter than a night. Proximity is transitive, so a tolerance
   * wide enough to bridge one night bridges every night: run against a real
   * store, a 20-hour gap produced a single "unit" of 839 artifacts spanning a
   * month. Continuity across days has to be earned by a shared stream, below.
   */
  readonly idleGapMinutes: number;
  /**
   * The same tolerance, for artifacts sharing a named stream.
   *
   * Far more generous, because a branch *is* the statement that this is one
   * piece of work. Proximity is a weak signal and a shared branch name is a
   * strong one, so they should not share a threshold — which the evaluation
   * corpus demonstrated before this distinction existed.
   */
  readonly sameStreamGapMinutes: number;
  /**
   * Stream names that carry no statement about which work something is part of.
   *
   * A feature branch is somebody saying "this belongs together". A trunk is
   * where work lands when nobody said anything, and `HEAD` is not even a name
   * — a detached checkout reports it for everything. Measured against a real
   * store, treating these as a shared stream chained 839 artifacts spanning a
   * month into a single "unit".
   *
   * They are handled like a missing stream rather than ignored: work still
   * groups by proximity, it just does not inherit the generous tolerance that
   * a deliberate branch name earns.
   */
  readonly trunkStreams: readonly string[];
  readonly threshold: SubstanceThreshold;
  /**
   * Kinds that count as a completed change on their own.
   *
   * Configuration rather than a hard-coded `git.commit` so a third-party
   * collector can qualify without editing the core.
   */
  readonly commitKinds: readonly string[];
}

export const CONTEXT_TEMPORAL_V1 = 'context-temporal@1';

/**
 * Defaults, tuned against `eval/grouping` and no further.
 *
 * Every number here was moved because a labelled case said it was wrong, and
 * none were moved because output "looked better".
 */
export const DEFAULT_GROUPING_CONFIG: GroupingConfig = {
  // 6 hours: longer than a lunch and a long meeting, far shorter than a night.
  idleGapMinutes: 6 * 60,
  // 7 days: a branch left over a long weekend is still the same feature.
  sameStreamGapMinutes: 7 * 24 * 60,
  trunkStreams: ['main', 'master', 'trunk', 'develop', 'default', 'HEAD'],
  threshold: {
    minActiveMinutes: 15,
    minDistinctArtifacts: 8,
    commitQualifiesAlone: true,
  },
  commitKinds: ['git.commit'],
};

/** Where evidence with no project attribution is collected. */
const UNATTRIBUTED = '(unattributed)';

interface OpenGroup {
  projectKey: string | null;
  stream: string | null;
  start: Instant;
  end: Instant;
  members: GroupableEvidence[];
}

const endOf = (evidence: GroupableEvidence): Instant => evidence.occurredEnd ?? evidence.occurredAt;

/**
 * Deterministic order: by start, then by end, then by id.
 *
 * The id tiebreak matters more than it looks. Two commits can share a second,
 * and without a total order the grouping of a rebased repository would depend
 * on which row the database returned first.
 */
function chronological(a: GroupableEvidence, b: GroupableEvidence): number {
  return (
    compareInstants(a.occurredAt, b.occurredAt) ||
    compareInstants(endOf(a), endOf(b)) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Whether a piece of evidence belongs to the stream a group has established.
 *
 * A null stream is compatible with anything, and that is load-bearing rather
 * than lenient. The Git collector deliberately records no branch — a commit
 * belongs to every branch that contains it, so recording one would be
 * arbitrary (M4). Treating null as a mismatch would put a commit and the
 * session that produced it into different units, which is precisely the
 * cross-source grouping Work Units exist to make possible.
 */
function streamsAgree(groupStream: string | null, candidate: string | null): boolean {
  return groupStream === null || candidate === null || groupStream === candidate;
}

/**
 * The open group a record should join, or null to start a new one.
 *
 * A record can be compatible with several groups — a commit carries no branch,
 * so it fits any of them. The tie is broken towards a named-stream match
 * first, then towards whichever group was active most recently, which is the
 * one the person was actually working on.
 */
function bestHost(
  groups: readonly OpenGroup[],
  record: GroupableEvidence,
  config: GroupingConfig,
): OpenGroup | null {
  let best: OpenGroup | null = null;
  let bestExact = false;
  const trunks = new Set(config.trunkStreams);

  for (const group of groups) {
    if (!streamsAgree(group.stream, record.stream)) continue;

    // A shared name only earns the generous tolerance when the name means
    // something. Two artifacts both on `main` share a default, not an
    // intention.
    const exact =
      group.stream !== null &&
      record.stream !== null &&
      group.stream === record.stream &&
      !trunks.has(group.stream);
    const toleranceMinutes = exact ? config.sameStreamGapMinutes : config.idleGapMinutes;
    const idleMillis = epochMillisOf(record.occurredAt) - epochMillisOf(group.end);
    if (idleMillis > toleranceMinutes * 60_000) continue;

    if (best === null || (exact && !bestExact) || (exact === bestExact && group.end > best.end)) {
      best = group;
      bestExact = exact;
    }
  }
  return best;
}

/**
 * `context-temporal@1`.
 *
 * Group evidence sharing a project within a bounded idle gap, splitting when
 * two different named streams meet, and admit the result only if it clears a
 * substance threshold.
 *
 * Deliberately simple and deliberately replaceable. It is a baseline to be
 * beaten by measurement, not a claim to have solved grouping.
 */
export function groupContextTemporal(
  evidence: readonly GroupableEvidence[],
  config: GroupingConfig = DEFAULT_GROUPING_CONFIG,
): readonly GroupCandidate[] {
  const byProject = new Map<string, GroupableEvidence[]>();
  for (const record of evidence) {
    const key = record.projectKey ?? UNATTRIBUTED;
    const bucket = byProject.get(key);
    if (bucket === undefined) byProject.set(key, [record]);
    else bucket.push(record);
  }

  const candidates: GroupCandidate[] = [];

  // Projects in name order so the output is stable however the store returned
  // rows. Only the ordinal suffix below actually depends on it, but a strategy
  // whose output order varies is one nobody can diff.
  for (const projectName of [...byProject.keys()].sort()) {
    const records = [...byProject.get(projectName)!].sort(chronological);
    const groups: OpenGroup[] = [];

    for (const record of records) {
      // Every group stays eligible, not just the most recent one. Somebody
      // alternating between two branches through an afternoon is doing two
      // pieces of work, and a single rolling group turns each switch into a
      // new unit — four units for two accomplishments, which is how the
      // evaluation corpus found this.
      const host = bestHost(groups, record, config);

      if (host === null) {
        groups.push({
          projectKey: record.projectKey,
          stream: record.stream,
          start: record.occurredAt,
          end: endOf(record),
          members: [record],
        });
        continue;
      }

      host.members.push(record);
      host.stream ??= record.stream;
      if (compareInstants(endOf(record), host.end) > 0) host.end = endOf(record);
    }

    const ordinals = new Map<string, number>();
    for (const group of groups) {
      candidates.push(toCandidate(group, config, ordinals));
    }
  }

  return candidates;
}

function toCandidate(
  group: OpenGroup,
  config: GroupingConfig,
  ordinals: Map<string, number>,
): GroupCandidate {
  const base = `${group.projectKey ?? UNATTRIBUTED}:${group.stream ?? '-'}:${group.start.slice(0, 10)}`;
  const seen = ordinals.get(base) ?? 0;
  ordinals.set(base, seen + 1);
  // A suffix only when a base key repeats, so the common case stays readable
  // and an added second unit cannot renumber the first.
  const groupingKey = seen === 0 ? base : `${base}#${seen + 1}`;

  // Time spent, not time elapsed. A group spanning three days may hold ninety
  // minutes of work, and a group spanning a working day may hold two.
  const activeMinutes = group.members.reduce(
    (total, member) =>
      total + (epochMillisOf(endOf(member)) - epochMillisOf(member.occurredAt)) / 60_000,
    0,
  );
  const commitKinds = new Set(config.commitKinds);
  const hasCommit = group.members.some((member) => commitKinds.has(member.kind));

  const signals = {
    activeMinutes,
    distinctArtifacts: group.members.length,
    hasCommit,
  };
  const admitted = meetsThreshold(signals, config.threshold);

  return {
    groupingKey,
    projectKey: group.projectKey,
    stream: group.stream,
    occurredAt: group.start,
    occurredEnd: group.end,
    sensitivity: maxSensitivity(group.members.map((member) => member.sensitivity)),
    members: group.members.map((member) => member.id),
    title: titleFor(group, config),
    admitted,
    reason: admitted
      ? reasonAdmitted(signals, config)
      : `below the substance threshold: ${Math.round(signals.activeMinutes)} active min, ` +
        `${signals.distinctArtifacts} artifact(s), ` +
        `${signals.hasCommit ? 'a commit that does not qualify alone' : 'no commit'}`,
  };
}

function reasonAdmitted(signals: SubstanceSignals, config: GroupingConfig): string {
  if (config.threshold.commitQualifiesAlone && signals.hasCommit) return 'contains a commit';
  if (signals.activeMinutes >= config.threshold.minActiveMinutes) {
    return `${Math.round(signals.activeMinutes)} minutes of work`;
  }
  return `touches ${signals.distinctArtifacts} artifacts`;
}

/**
 * A title taken from a member, never written.
 *
 * The strategy picks; it does not compose. Prose describing a group of
 * artifacts is interpretation, and interpretation belongs to enrichment where
 * it can be attributed to a model and reviewed (ADR-0002, ADR-0005). Until
 * then the most honest title available is one the person already wrote.
 *
 * The choice is the earliest non-commit member: work starts with someone
 * asking for something, and a commit subject describes the change rather than
 * the task. Members are already in chronological order here.
 */
function titleFor(group: OpenGroup, config: GroupingConfig): string {
  const commitKinds = new Set(config.commitKinds);
  const asked = group.members.find((member) => !commitKinds.has(member.kind));
  return (asked ?? group.members[0]!).title;
}
