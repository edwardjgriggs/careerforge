import type { Migration } from './types.js';

/**
 * Consent, and the audit trail of every egress decision.
 *
 * Append-only for a sharper reason than elsewhere: this is the record a user
 * consults when they want to know what left their machine and when. A table
 * that could be edited would be a table nobody should believe, and the whole
 * point of the choke point is that its history is checkable after the fact.
 *
 * Revoking is therefore a new row, not a deletion. "I revoked this in March"
 * stays answerable in December.
 */
export const migration0005: Migration = {
  version: 5,
  name: 'policy',
  up(db) {
    db.exec(`
      CREATE TABLE consent_grants (
        id             TEXT PRIMARY KEY,
        -- Null means the whole store. Grants are per project by design; there
        -- is deliberately no global override (ADR-0009).
        project_key    TEXT,
        provider_id    TEXT NOT NULL,
        max_sensitivity TEXT NOT NULL CHECK (max_sensitivity IN ('public','internal','confidential','restricted')),
        revoked        INTEGER NOT NULL DEFAULT 0,
        reason         TEXT,
        recorded_at    TEXT NOT NULL,
        supersedes     TEXT REFERENCES consent_grants(id)
      );

      CREATE TRIGGER consent_grants_no_update
        BEFORE UPDATE ON consent_grants
        BEGIN
          SELECT RAISE(ABORT, 'consent_grants is append-only: granting or revoking writes a new record (ADR-0013)');
        END;

      CREATE TRIGGER consent_grants_no_delete
        BEFORE DELETE ON consent_grants
        BEGIN
          SELECT RAISE(ABORT, 'consent_grants is append-only: revoke instead of deleting (ADR-0001)');
        END;

      CREATE INDEX ix_consent_lookup ON consent_grants(provider_id, project_key, id DESC);

      CREATE VIEW consent_grants_current AS
        SELECT g.* FROM consent_grants g
        WHERE NOT EXISTS (SELECT 1 FROM consent_grants s WHERE s.supersedes = g.id);

      CREATE TABLE policy_decisions (
        id              TEXT PRIMARY KEY,
        provider_id     TEXT NOT NULL,
        purpose         TEXT NOT NULL,
        allowed         INTEGER NOT NULL,
        max_sensitivity TEXT NOT NULL,
        project_keys    TEXT NOT NULL,
        item_count      INTEGER NOT NULL,
        -- Which named rules refused, as JSON. A decision recorded years ago
        -- must still be explicable, so the rule ids are versioned strings
        -- rather than references to code that may have moved.
        refusals        TEXT NOT NULL,
        redaction_profile TEXT NOT NULL,
        redaction_report  TEXT NOT NULL,
        -- The hash, never the payload. Keeping what was sent would make the
        -- audit trail the largest concentration of sensitive data in the
        -- store, which is precisely the thing being guarded.
        payload_hash    TEXT,
        payload_bytes   INTEGER NOT NULL DEFAULT 0,
        recorded_at     TEXT NOT NULL
      );

      CREATE TRIGGER policy_decisions_no_update
        BEFORE UPDATE ON policy_decisions
        BEGIN
          SELECT RAISE(ABORT, 'policy_decisions is append-only: the audit trail is not editable (ADR-0009)');
        END;

      CREATE TRIGGER policy_decisions_no_delete
        BEFORE DELETE ON policy_decisions
        BEGIN
          SELECT RAISE(ABORT, 'policy_decisions is append-only: the audit trail is not editable (ADR-0009)');
        END;

      CREATE INDEX ix_decisions_provider ON policy_decisions(provider_id, recorded_at);
    `);
  },
};
