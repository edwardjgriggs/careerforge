import {
  createUlidFactory,
  deriveSensitivity,
  groupContextTemporal,
  instantFromEpochMillis,
  toInstant,
  CONTEXT_TEMPORAL_V1,
  DEFAULT_GROUPING_CONFIG,
  WORK_UNIT_SCHEMA_VERSION,
  type GroupCandidate,
  type GroupableEvidence,
  type GroupingConfig,
  type Instant,
  type MemberRole,
  type Platform,
  type Sensitivity,
  type UlidFactory,
  type WorkUnit,
  type WorkUnitId,
  type WorkUnitMember,
} from '@careerforge/domain';

import type { Db } from './migrations/index.js';

/**
 * Work Units, and the strategy runs that produce them.
 *
 * Everything here is append-only, which collapses five operations into one
 * shape. Regrouping, renaming, pinning, merging and splitting all write a new
 * unit that supersedes an old one — so undo is free, history is complete, and
 * there is no code path that can quietly lose how someone organised their own
 * career.
 */

export interface WorkUnitRow {
  readonly id: string;
  readonly schema_version: number;
  readonly title: string;
  readonly occurred_at: string;
  readonly occurred_end: string | null;
  readonly project_key: string | null;
  readonly stream: string | null;
  readonly sensitivity: string;
  readonly grouping_strategy: string;
  readonly grouping_key: string;
  readonly pinned: number;
  readonly recorded_at: string;
  readonly supersedes: string | null;
}

function toWorkUnit(row: WorkUnitRow): WorkUnit {
  return {
    id: row.id as WorkUnitId,
    schemaVersion: row.schema_version,
    title: row.title,
    occurredAt: toInstant(row.occurred_at),
    occurredEnd: row.occurred_end === null ? null : toInstant(row.occurred_end),
    projectKey: row.project_key,
    stream: row.stream,
    sensitivity: row.sensitivity as Sensitivity,
    groupingStrategy: row.grouping_strategy,
    groupingKey: row.grouping_key,
    pinned: row.pinned === 1,
    supersedes: row.supersedes as WorkUnitId | null,
  };
}

/** What a grouping run did, in terms a person can check. */
export interface GroupingReport {
  readonly strategy: string;
  /** Candidates the strategy proposed, before admission. */
  readonly proposed: number;
  /** Candidates that cleared the substance threshold. */
  readonly admitted: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Units a person has edited, left untouched. */
  readonly pinnedSkipped: number;
  /** Evidence records that reached no admitted unit. */
  readonly evidenceBelowThreshold: number;
  readonly units: readonly GroupCandidate[];
}

export interface GroupOptions {
  readonly config?: GroupingConfig;
  /** Report what would happen and write nothing. */
  readonly dryRun?: boolean;
}

export class WorkUnitStore {
  private readonly nextId: UlidFactory;

  constructor(
    private readonly db: Db,
    private readonly platform: Platform,
  ) {
    this.nextId = createUlidFactory(platform.clock, platform.entropy);
  }

  private now(): Instant {
    return instantFromEpochMillis(this.platform.clock());
  }

  /** Evidence in the shape a strategy needs, and nothing more. */
  groupableEvidence(): readonly GroupableEvidence[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.kind, e.sensitivity, e.occurred_at, e.occurred_end,
                e.project_key, e.stream, COALESCE(c.title, '') AS title
         FROM evidence_current e
         LEFT JOIN evidence_content c ON c.evidence_id = e.id
         ORDER BY e.occurred_at, e.id`,
      )
      .all() as {
      id: string;
      kind: string;
      sensitivity: string;
      occurred_at: string;
      occurred_end: string | null;
      project_key: string | null;
      stream: string | null;
      title: string;
    }[];

    return rows.map((row) => ({
      id: row.id as GroupableEvidence['id'],
      kind: row.kind,
      sensitivity: row.sensitivity as Sensitivity,
      occurredAt: toInstant(row.occurred_at),
      occurredEnd: row.occurred_end === null ? null : toInstant(row.occurred_end),
      projectKey: row.project_key,
      stream: row.stream,
      title: row.title,
    }));
  }

  /**
   * Run a grouping strategy over all current evidence.
   *
   * Idempotent: a second run over unchanged evidence writes nothing. A unit
   * whose membership or span has changed is superseded rather than edited, and
   * a unit a person has pinned is left exactly as they left it.
   */
  group(options: GroupOptions = {}): GroupingReport {
    const config = options.config ?? DEFAULT_GROUPING_CONFIG;
    const evidence = this.groupableEvidence();
    const candidates = groupContextTemporal(evidence, config);
    const admitted = candidates.filter((candidate) => candidate.admitted);

    const current = this.currentUnits();
    const existing = new Map(
      current.map((unit) => [`${unit.groupingStrategy} ${unit.groupingKey}`, unit]),
    );

    /**
     * Evidence a person has already placed by hand.
     *
     * Matching on the grouping key alone is not enough. Merging two units
     * writes a third with a key of its own, which leaves both original keys
     * unclaimed — so the next run helpfully recreates the two units the user
     * had just merged away. Curation is a decision about *evidence*, so
     * evidence is what has to be protected.
     */
    const curated = new Set<string>();
    for (const unit of current) {
      if (!unit.pinned) continue;
      for (const evidenceId of this.memberIds(unit.id)) curated.add(evidenceId);
    }

    // Decided first, applied second, so a dry run and a real run cannot drift
    // apart by being two implementations of the same rules.
    type Decision = 'create' | 'update' | 'unchanged' | 'pinned';
    const plan: { candidate: GroupCandidate; decision: Decision; previous: string | null }[] = [];

    for (const candidate of admitted) {
      const previous = existing.get(`${CONTEXT_TEMPORAL_V1} ${candidate.groupingKey}`);
      const touchesCurated = candidate.members.some((id) => curated.has(id));

      if (touchesCurated || previous?.pinned === true) {
        plan.push({ candidate, decision: 'pinned', previous: previous?.id ?? null });
      } else if (previous !== undefined && this.matches(previous, candidate)) {
        plan.push({ candidate, decision: 'unchanged', previous: previous.id });
      } else if (previous === undefined) {
        plan.push({ candidate, decision: 'create', previous: null });
      } else {
        plan.push({ candidate, decision: 'update', previous: previous.id });
      }
    }

    if (options.dryRun !== true) {
      this.db.transaction(() => {
        for (const step of plan) {
          if (step.decision === 'create' || step.decision === 'update') {
            this.insert(step.candidate, step.previous);
          }
        }
      })();
    }

    const tally = (decision: Decision): number =>
      plan.filter((step) => step.decision === decision).length;
    const created = tally('create');
    const updated = tally('update');
    const unchanged = tally('unchanged');
    const pinnedSkipped = tally('pinned');

    const grouped = new Set(admitted.flatMap((candidate) => candidate.members));

    return {
      strategy: CONTEXT_TEMPORAL_V1,
      proposed: candidates.length,
      admitted: admitted.length,
      created,
      updated,
      unchanged,
      pinnedSkipped,
      evidenceBelowThreshold: evidence.filter((record) => !grouped.has(record.id)).length,
      units: candidates,
    };
  }

  /** Whether a stored unit already says exactly what the candidate says. */
  private matches(unit: WorkUnit, candidate: GroupCandidate): boolean {
    if (
      unit.title !== candidate.title ||
      unit.occurredAt !== candidate.occurredAt ||
      unit.occurredEnd !== candidate.occurredEnd ||
      unit.sensitivity !== candidate.sensitivity ||
      unit.projectKey !== candidate.projectKey ||
      unit.stream !== candidate.stream
    ) {
      return false;
    }
    // Both sorted: stored membership comes back in id order and a candidate
    // lists members chronologically. Comparing them raw would report a change
    // on every run for any unit whose members are not already in id order.
    const stored = this.memberIds(unit.id);
    const proposed = [...candidate.members].sort();
    return stored.length === proposed.length && stored.every((id, index) => id === proposed[index]);
  }

  private insert(candidate: GroupCandidate, supersedes: string | null): WorkUnitId {
    const id = this.nextId() as string as WorkUnitId;
    const now = this.now();

    this.db
      .prepare(
        `INSERT INTO work_units (
           id, schema_version, title, occurred_at, occurred_end, project_key, stream,
           sensitivity, grouping_strategy, grouping_key, pinned, recorded_at, supersedes
         ) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      )
      .run(
        id,
        WORK_UNIT_SCHEMA_VERSION,
        candidate.title,
        candidate.occurredAt,
        candidate.occurredEnd,
        candidate.projectKey,
        candidate.stream,
        candidate.sensitivity,
        CONTEXT_TEMPORAL_V1,
        candidate.groupingKey,
        now,
        supersedes,
      );

    for (const [index, evidenceId] of candidate.members.entries()) {
      // The earliest artifact is what the unit is about; the rest support it.
      // A cheap heuristic, and honest about being one — `confidence` is what a
      // reviewer sees when deciding whether to trust automatic grouping.
      this.addMember(id, evidenceId, index === 0 ? 'primary' : 'supporting', 'strategy', 0.8, now);
    }

    return id;
  }

  /**
   * Attach a record to a unit the user has already decided it belongs to.
   *
   * For interview answers. An answer settles a gap that names its work unit,
   * so membership is known rather than inferred — but until this existed it
   * only took effect on the next `group` run, which meant answering a question
   * and immediately regenerating produced the same bullet as before. The user
   * had done everything right and nothing changed, which is the worst possible
   * response to somebody engaging with the interview.
   *
   * `assigned_by = 'user'` because it is: the grouping strategy did not put it
   * here and must not claim credit for it.
   */
  attachAnswer(workUnitId: string, evidenceId: string): void {
    const existing = this.db
      .prepare(`SELECT 1 FROM work_unit_members WHERE work_unit_id = ? AND evidence_id = ?`)
      .get(workUnitId, evidenceId);
    if (existing !== undefined) return;

    this.addMember(
      workUnitId,
      evidenceId,
      'supporting',
      'user',
      null,
      instantFromEpochMillis(this.platform.clock()),
    );
  }

  private addMember(
    workUnitId: string,
    evidenceId: string,
    role: MemberRole,
    assignedBy: 'strategy' | 'user',
    confidence: number | null,
    recordedAt: Instant,
  ): void {
    this.db
      .prepare(
        `INSERT INTO work_unit_members
           (work_unit_id, evidence_id, role, assigned_by, confidence, recorded_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(workUnitId, evidenceId, role, assignedBy, confidence, recordedAt);
  }

  /**
   * Write a new unit superseding an existing one.
   *
   * The single primitive behind renaming, pinning, merging and splitting. Each
   * of those is "a person decided something", and the append-only model says a
   * decision is a new record, never an edit to an old one (ADR-0001).
   */
  private supersede(
    sources: readonly WorkUnit[],
    changes: {
      readonly title?: string;
      readonly members: readonly string[];
      readonly pinned: boolean;
      readonly groupingKey?: string;
    },
  ): WorkUnitId {
    const id = this.nextId() as string as WorkUnitId;
    const now = this.now();
    const first = sources[0]!;

    const spans = sources.map((unit) => unit.occurredAt).sort();
    const ends = sources.map((unit) => unit.occurredEnd ?? unit.occurredAt).sort();
    const sensitivity = deriveSensitivity(sources.map((unit) => unit.sensitivity));

    this.db
      .prepare(
        `INSERT INTO work_units (
           id, schema_version, title, occurred_at, occurred_end, project_key, stream,
           sensitivity, grouping_strategy, grouping_key, pinned, recorded_at, supersedes
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        WORK_UNIT_SCHEMA_VERSION,
        changes.title ?? first.title,
        spans[0]!,
        ends[ends.length - 1]!,
        first.projectKey,
        first.stream,
        sensitivity,
        first.groupingStrategy,
        changes.groupingKey ?? first.groupingKey,
        changes.pinned ? 1 : 0,
        now,
        // A merge supersedes two units and the column holds one. The rest are
        // recoverable through membership and recorded_at; a full many-to-many
        // supersession graph is a bigger change than merge alone justifies.
        first.id,
      );

    for (const [index, evidenceId] of changes.members.entries()) {
      this.addMember(id, evidenceId, index === 0 ? 'primary' : 'supporting', 'user', null, now);
    }
    return id;
  }

  /**
   * Mark a unit as curated, so no strategy may rewrite it.
   *
   * Pinning is itself a supersede, which means "when did I pin this" is
   * answerable and unpinning is just another record.
   */
  pin(workUnitId: string, pinned = true): WorkUnitId {
    const unit = this.requireCurrent(workUnitId);
    return this.supersede([unit], { members: this.memberIds(unit.id), pinned });
  }

  /** Rename a unit. A person's words replace a strategy's pick, and pin it. */
  rename(workUnitId: string, title: string): WorkUnitId {
    const unit = this.requireCurrent(workUnitId);
    return this.supersede([unit], { title, members: this.memberIds(unit.id), pinned: true });
  }

  /** Two units become one. Reversible: both originals stay on record. */
  merge(firstId: string, secondId: string, title?: string): WorkUnitId {
    const first = this.requireCurrent(firstId);
    const second = this.requireCurrent(secondId);
    if (first.id === second.id) throw new Error('Cannot merge a work unit with itself.');

    const members = [
      ...new Set([...this.memberIds(first.id), ...this.memberIds(second.id)]),
    ].sort();

    return this.db.transaction(() => {
      const merged = this.supersede([first, second], {
        ...(title === undefined ? {} : { title }),
        members,
        pinned: true,
        groupingKey: `${first.groupingKey}+merged`,
      });
      // The second original is superseded by a pointer the column cannot hold,
      // so it is tombstoned instead: same effect on reads, and the join that
      // resolves current state already accounts for it (ADR-0013).
      this.db
        .prepare(
          `INSERT INTO tombstones (id, target_kind, target_id, scope, reason, recorded_at)
           VALUES (?, 'work_unit', ?, 'hidden', ?, ?)`,
        )
        .run(this.nextId(), second.id, `merged into ${merged}`, this.now());
      return merged;
    })();
  }

  /** One unit becomes two. Membership is partitioned, never duplicated. */
  split(workUnitId: string, intoFirst: readonly string[]): readonly WorkUnitId[] {
    const unit = this.requireCurrent(workUnitId);
    const all = new Set(this.memberIds(unit.id));

    const left = [...intoFirst].sort();
    for (const id of left) {
      if (!all.has(id)) throw new Error(`Evidence ${id} is not a member of ${workUnitId}.`);
    }
    const right = [...all].filter((id) => !left.includes(id)).sort();
    if (left.length === 0 || right.length === 0) {
      throw new Error('A split must leave evidence on both sides.');
    }

    return this.db.transaction(() => [
      this.supersede([unit], { members: left, pinned: true }),
      this.supersede([unit], {
        members: right,
        pinned: true,
        groupingKey: `${unit.groupingKey}#split`,
      }),
    ])();
  }

  private requireCurrent(workUnitId: string): WorkUnit {
    const row = this.db.prepare(`SELECT * FROM work_units_current WHERE id = ?`).get(workUnitId) as
      WorkUnitRow | undefined;
    if (row === undefined) {
      throw new Error(`No current work unit ${workUnitId}. It may have been superseded already.`);
    }
    return toWorkUnit(row);
  }

  currentUnits(projectKey?: string): readonly WorkUnit[] {
    const rows =
      projectKey === undefined
        ? (this.db
            .prepare(`SELECT * FROM work_units_current ORDER BY occurred_at DESC, id DESC`)
            .all() as WorkUnitRow[])
        : (this.db
            .prepare(
              `SELECT * FROM work_units_current WHERE project_key = ?
               ORDER BY occurred_at DESC, id DESC`,
            )
            .all(projectKey) as WorkUnitRow[]);
    return rows.map(toWorkUnit);
  }

  /** A bounded slice for interactive readers such as the Evidence Explorer. */
  currentUnitsPage(limit: number, offset: number): readonly WorkUnit[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_units_current
         ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset))) as WorkUnitRow[];
    return rows.map(toWorkUnit);
  }

  /** Member counts for a page of units in one query. */
  memberCounts(workUnitIds: readonly string[]): ReadonlyMap<string, number> {
    if (workUnitIds.length === 0) return new Map();
    const placeholders = workUnitIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT work_unit_id, COUNT(*) AS n FROM work_unit_members
         WHERE work_unit_id IN (${placeholders}) GROUP BY work_unit_id`,
      )
      .all(...workUnitIds) as { work_unit_id: string; n: number }[];
    return new Map(rows.map((row) => [row.work_unit_id, row.n]));
  }

  byId(id: string): WorkUnit | null {
    const row = this.db.prepare(`SELECT * FROM work_units WHERE id = ?`).get(id) as
      WorkUnitRow | undefined;
    return row === undefined ? null : toWorkUnit(row);
  }

  memberIds(workUnitId: string): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT evidence_id FROM work_unit_members WHERE work_unit_id = ? ORDER BY evidence_id`,
      )
      .all(workUnitId) as { evidence_id: string }[];
    return rows.map((row) => row.evidence_id);
  }

  members(workUnitId: string): readonly WorkUnitMember[] {
    const rows = this.db
      .prepare(`SELECT * FROM work_unit_members WHERE work_unit_id = ? ORDER BY evidence_id`)
      .all(workUnitId) as {
      work_unit_id: string;
      evidence_id: string;
      role: string;
      assigned_by: string;
      confidence: number | null;
      recorded_at: string;
    }[];

    return rows.map((row) => ({
      workUnitId: row.work_unit_id as WorkUnitId,
      evidenceId: row.evidence_id as WorkUnitMember['evidenceId'],
      role: row.role as MemberRole,
      assignedBy: row.assigned_by as WorkUnitMember['assignedBy'],
      confidence: row.confidence,
      recordedAt: toInstant(row.recorded_at),
    }));
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM work_units_current`).get() as { n: number })
      .n;
  }
}
