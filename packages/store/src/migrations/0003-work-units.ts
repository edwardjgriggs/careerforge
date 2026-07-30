import type { Migration } from './types.js';

/**
 * Work Units: the level at which humans describe accomplishments.
 *
 * Append-only like everything else, which shapes the whole design. A unit is
 * never edited — regrouping, merging, splitting, pinning and renaming all
 * write a new unit that supersedes the old. Membership is therefore immutable
 * too: a member row belongs to a unit id, and a unit id never changes meaning.
 *
 * That is what makes merge and split free to undo. The history of how someone
 * organised their own career is kept for the same reason the evidence is.
 */
export const migration0003: Migration = {
  version: 3,
  name: 'work-units',
  up(db) {
    db.exec(`
      CREATE TABLE work_units (
        id                TEXT PRIMARY KEY,
        schema_version    INTEGER NOT NULL,
        title             TEXT NOT NULL,
        occurred_at       TEXT NOT NULL,
        occurred_end      TEXT,
        project_key       TEXT,
        stream            TEXT,
        -- Always the maximum over members. Stored so a unit can be read
        -- without a join, derived so it can never disagree with them.
        sensitivity       TEXT NOT NULL,
        grouping_strategy TEXT NOT NULL,
        grouping_key      TEXT NOT NULL,
        -- Set once a person edits membership. Strategies must never clear it.
        pinned            INTEGER NOT NULL DEFAULT 0,
        recorded_at       TEXT NOT NULL,
        supersedes        TEXT REFERENCES work_units(id)
      );

      CREATE TRIGGER work_units_no_update
        BEFORE UPDATE ON work_units
        BEGIN
          SELECT RAISE(ABORT, 'work_units is append-only: write a superseding record instead (ADR-0001)');
        END;

      CREATE TRIGGER work_units_no_delete
        BEFORE DELETE ON work_units
        BEGIN
          SELECT RAISE(ABORT, 'work_units is append-only: write a tombstone instead (ADR-0001)');
        END;

      -- Membership carries its own provenance, so it is a record rather than
      -- an array on the unit: many-to-many, because one commit can support two
      -- accomplishments (ADR-0006).
      CREATE TABLE work_unit_members (
        work_unit_id  TEXT NOT NULL REFERENCES work_units(id),
        evidence_id   TEXT NOT NULL REFERENCES evidence(id),
        role          TEXT NOT NULL,
        assigned_by   TEXT NOT NULL,
        -- Null whenever a person made the call. People do not emit confidences.
        confidence    REAL,
        recorded_at   TEXT NOT NULL,
        PRIMARY KEY (work_unit_id, evidence_id)
      );

      CREATE TRIGGER work_unit_members_no_update
        BEFORE UPDATE ON work_unit_members
        BEGIN
          SELECT RAISE(ABORT, 'work_unit_members is append-only: supersede the unit instead (ADR-0001)');
        END;

      CREATE TRIGGER work_unit_members_no_delete
        BEFORE DELETE ON work_unit_members
        BEGIN
          SELECT RAISE(ABORT, 'work_unit_members is append-only: supersede the unit instead (ADR-0001)');
        END;

      CREATE INDEX ix_work_units_key ON work_units(grouping_strategy, grouping_key);
      CREATE INDEX ix_work_units_project ON work_units(project_key, occurred_at);
      CREATE INDEX ix_members_evidence ON work_unit_members(evidence_id);

      -- The only supported read surface. Superseded and tombstoned units are
      -- excluded by join rather than by a reverse pointer (ADR-0013).
      CREATE VIEW work_units_current AS
        SELECT u.*
        FROM work_units u
        WHERE NOT EXISTS (
            SELECT 1 FROM work_units s WHERE s.supersedes = u.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM tombstones t
            WHERE t.target_kind = 'work_unit' AND t.target_id = u.id
          );
    `);
  },
};
