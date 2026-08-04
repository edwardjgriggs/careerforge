import {
  createUlidFactory,
  instantFromEpochMillis,
  toInstant,
  type Instant,
  type Platform,
  type Refusal,
  type Sensitivity,
  type UlidFactory,
} from '@careerforge/domain';

import type { Db } from './migrations/index.js';

/**
 * What the user has allowed, and what was decided because of it.
 *
 * The policy engine is pure and knows nothing about SQL; this is where its
 * inputs come from and where its decisions go. Keeping the two apart means the
 * rules can be tested exhaustively with no database anywhere near them, and it
 * means this file has no opinions of its own about what should be permitted.
 */

export interface StoredGrant {
  readonly id: string;
  readonly projectKey: string | null;
  readonly providerId: string;
  readonly maxSensitivity: Sensitivity;
  readonly revoked: boolean;
  readonly reason: string | null;
  readonly recordedAt: Instant;
}

/** Persistence shape kept local so the store does not depend on policy. */
export interface PolicyDecisionRecord {
  readonly allowed: boolean;
  readonly providerId: string;
  readonly purpose: string;
  readonly maxSensitivity: Sensitivity;
  readonly projectKeys: readonly string[];
  readonly itemCount: number;
  readonly refusals: readonly Refusal[];
  readonly payload: string;
  readonly redaction: { readonly profile: string };
  readonly payloadHash: string | null;
}

interface GrantRow {
  id: string;
  project_key: string | null;
  provider_id: string;
  max_sensitivity: string;
  revoked: number;
  reason: string | null;
  recorded_at: string;
  supersedes: string | null;
}

const toGrant = (row: GrantRow): StoredGrant => ({
  id: row.id,
  projectKey: row.project_key,
  providerId: row.provider_id,
  maxSensitivity: row.max_sensitivity as Sensitivity,
  revoked: row.revoked === 1,
  reason: row.reason,
  recordedAt: toInstant(row.recorded_at),
});

export class ConsentStore {
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

  /**
   * The grant the engine should apply, or null.
   *
   * A project-specific grant wins over a store-wide one, so narrowing consent
   * for one client never has to be expressed as a hole in a broader
   * permission.
   */
  lookup(projectKey: string | null, providerId: string): StoredGrant | null {
    const specific =
      projectKey === null
        ? undefined
        : (this.db
            .prepare(
              `SELECT * FROM consent_grants_current
               WHERE provider_id = ? AND project_key = ? ORDER BY id DESC LIMIT 1`,
            )
            .get(providerId, projectKey) as GrantRow | undefined);
    if (specific !== undefined) return toGrant(specific);

    const wide = this.db
      .prepare(
        `SELECT * FROM consent_grants_current
         WHERE provider_id = ? AND project_key IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(providerId) as GrantRow | undefined;
    return wide === undefined ? null : toGrant(wide);
  }

  /** Allow a provider up to a level, for one project. Supersedes any prior. */
  grant(input: {
    projectKey: string | null;
    providerId: string;
    maxSensitivity: Sensitivity;
    reason?: string;
  }): string {
    return this.write({ ...input, revoked: false, reason: input.reason ?? null });
  }

  /**
   * Withdraw a grant.
   *
   * A new record rather than a deletion, so "I revoked this in March" stays
   * answerable in December. The level is carried forward so the record shows
   * what was withdrawn, not merely that something was.
   */
  revoke(projectKey: string | null, providerId: string, reason?: string): string {
    const existing = this.lookup(projectKey, providerId);
    return this.write({
      projectKey,
      providerId,
      maxSensitivity: existing?.maxSensitivity ?? 'public',
      revoked: true,
      reason: reason ?? null,
    });
  }

  private write(input: {
    projectKey: string | null;
    providerId: string;
    maxSensitivity: Sensitivity;
    revoked: boolean;
    reason: string | null;
  }): string {
    const previous = this.db
      .prepare(
        `SELECT id FROM consent_grants_current
         WHERE provider_id = ? AND ((project_key IS NULL AND ? IS NULL) OR project_key = ?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(input.providerId, input.projectKey, input.projectKey) as { id: string } | undefined;

    const id = this.nextId() as string;
    this.db
      .prepare(
        `INSERT INTO consent_grants
           (id, project_key, provider_id, max_sensitivity, revoked, reason, recorded_at, supersedes)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.projectKey,
        input.providerId,
        input.maxSensitivity,
        input.revoked ? 1 : 0,
        input.reason,
        this.now(),
        previous?.id ?? null,
      );
    return id;
  }

  list(): readonly StoredGrant[] {
    const rows = this.db
      .prepare(`SELECT * FROM consent_grants_current ORDER BY provider_id, project_key`)
      .all() as GrantRow[];
    return rows.map(toGrant);
  }

  /** The full history for one key, including revocations. */
  history(projectKey: string | null, providerId: string): readonly StoredGrant[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM consent_grants
         WHERE provider_id = ? AND ((project_key IS NULL AND ? IS NULL) OR project_key = ?)
         ORDER BY id`,
      )
      .all(providerId, projectKey, projectKey) as GrantRow[];
    return rows.map(toGrant);
  }

  /**
   * Record what was decided.
   *
   * Every evaluation, allowed or refused. A trail containing only the
   * permitted calls would answer "what left?" and not "what was attempted?",
   * and the second question is the one a user asks after a scare.
   */
  recordDecision(decision: PolicyDecisionRecord): string {
    const id = this.nextId() as string;
    this.db
      .prepare(
        `INSERT INTO policy_decisions
           (id, provider_id, purpose, allowed, max_sensitivity, project_keys, item_count,
            refusals, redaction_profile, redaction_report, payload_hash, payload_bytes, recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        decision.providerId,
        decision.purpose,
        decision.allowed ? 1 : 0,
        decision.maxSensitivity,
        JSON.stringify(decision.projectKeys),
        decision.itemCount,
        JSON.stringify(decision.refusals),
        decision.redaction.profile,
        JSON.stringify(decision.redaction),
        decision.payloadHash,
        decision.payload.length,
        this.now(),
      );
    return id;
  }

  decisionCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM policy_decisions`).get() as { n: number }).n;
  }

  recentDecisions(limit = 20): readonly {
    id: string;
    providerId: string;
    purpose: string;
    allowed: boolean;
    maxSensitivity: string;
    refusalRules: readonly string[];
    recordedAt: string;
  }[] {
    const rows = this.db
      .prepare(`SELECT * FROM policy_decisions ORDER BY id DESC LIMIT ?`)
      .all(limit) as {
      id: string;
      provider_id: string;
      purpose: string;
      allowed: number;
      max_sensitivity: string;
      refusals: string;
      recorded_at: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      purpose: row.purpose,
      allowed: row.allowed === 1,
      maxSensitivity: row.max_sensitivity,
      refusalRules: (JSON.parse(row.refusals) as { rule: string }[]).map((r) => r.rule),
      recordedAt: row.recorded_at,
    }));
  }
}
