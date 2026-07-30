# ADR-0003 — SQLite is canonical storage

**Status:** Accepted · 2026-07-30
**Relates to:** `Architecture.md` §4 · `docs/PreArchitecture-Findings.md` Part 2
**Paired with:** ADR-0004

## Context

The vision initially described storage as "SQLite + JSON + Markdown." That is three sources of truth. Within months they drift, and no contributor can say which is correct — a well-documented way for a project to rot.

Competing pressures: the product must be local-first and durable for a decade; provenance is a graph; analytics require aggregation; append-only semantics (ADR-0001) require transactions; and users must never feel their career history is trapped in a format they cannot read.

The plain-file instinct is not naive — it is the correct instinct about *durability*. It is simply the wrong answer for *truth*.

## Decision

**Exactly one SQLite database is canonical. Everything else is derived and regenerable.**

- `careerforge.db` (WAL mode) — canonical.
- `export/` JSON tree — derived, durable, syncable (ADR-0004).
- Markdown, PDF, DOCX, JSON Resume — rendered output, never storage.
- FTS5 search index — fully derived, rebuilt by command, never synced.
- Blobs — content-addressed, **outside the database**, prunable without data loss.

Rationale, in order of weight:

1. **Provenance is a multi-hop graph** (ADR-0007). Traversing it over a directory of Markdown files means writing a database badly, in application code, forever.
2. **Append-only requires transactional multi-row writes.** Files cannot provide this without inventing a journal.
3. **Analytics require aggregation.** "Which skills have gone dormant?" is a `GROUP BY` over years; over flat files it is a full corpus scan.
4. **Migrations require versioning.** `PRAGMA user_version` plus transactional DDL is the foundation of the automatic-migration promise (`Vision.md` §14).
5. **It fits the constraints already chosen.** Single file, no server, no daemon, embedded, excellent TypeScript support, and the most widely readable data format in existence for a user who wants to leave.

Blobs stay out of the database because one measured source produces ~4 GB/year (`PreArchitecture-Findings.md` §1.5). Evidence stores a content hash, a source reference, and a bounded excerpt.

## Consequences

**Gains**

- One place to look, one place to migrate, one place to test.
- Fast local search and analytics with no service and no network.
- Transactional integrity for append-only semantics.

**Accepted costs**

- A binary file users cannot read in a text editor. **This is the real objection, and ADR-0004 is its answer** — the JSON export exists precisely so canonical-ness never means captivity.
- Migrations are now a first-class engineering burden with a hard correctness bar.
- The database file cannot be synced directly (ADR-0004).

## Alternatives considered

**Markdown files as canonical.** Maximum transparency, Git-native, editable anywhere. Rejected: cannot express the provenance graph without inventing a private serialization; every query becomes a parse; `Vision.md` §1 already establishes that assets are generated views, so Markdown is inherently a *view*.

**JSON files as canonical with an in-memory index.** Human-readable and simple. Rejected: the index must be rebuilt on every start, cost grows linearly with a decade of history, and it is a database with extra steps and no transactions.

**Embedded document or graph database.** Better fit for the graph shape. Rejected: heavier dependency, far smaller contributor pool, and none approach SQLite's durability record or tooling ubiquity — which matters most for data meant to outlive the project.

**Postgres.** More capable. Rejected outright: requires a server, contradicting local-first (`Vision.md` §6).

## Revisit if

- The provenance graph outgrows recursive CTEs at realistic scale (measure with 10 years of synthetic data before acting).
- SQLite proves unreliable across the sync destinations users actually choose.
- Round-trip fidelity (invariant I5) cannot be maintained in practice.
