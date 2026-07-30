# ADR-0001 — Append-only data model

**Status:** Accepted · 2026-07-30
**Relates to:** `Architecture.md` §1.2 (I2), §2.2, §4.2

## Context

CareerForge accumulates a decade of a person's professional history. Records are referenced by other records: enrichments cite evidence, claims cite enrichments and evidence, assets cite claims, work units group evidence.

In a mutable model, editing one evidence row silently invalidates every enrichment, claim, and asset derived from it. Nothing errors. The resume bullet still renders. It is simply no longer supported by what it says it is supported by — and there is no way to detect this after the fact.

Users legitimately need to correct mistakes and remove things. "Immutable" and "editable" appear contradictory, and the initial vision language contained exactly that contradiction.

## Decision

**Every domain table is append-only. `UPDATE` and `DELETE` are rejected at the database level by triggers, not by convention.**

Mutation is expressed as new rows:

- **Correction** — a new row with `supersedes` pointing at the prior row.
- **Deletion** — a `tombstones` row with `scope` of `hidden`, `redacted`, or `purged`.

All reads go through views that exclude superseded and tombstoned rows. Application code never touches base tables.

`scope = 'purged'` is the single exception where bytes are actually removed — required for leaked credentials and third-party personal data. The tombstone itself survives, so provenance remains explicable rather than silently dangling.

## Consequences

**Accepted costs**

- Storage grows monotonically. Acceptable: records are small, and blobs live outside the database (ADR-0003).
- Every read path needs the correct view. Mitigated by making base tables effectively private and testing that no query bypasses them.
- Two-step reasoning for contributors: "what is current" is a query, not a row.

**Gains**

- Downstream references can never be silently invalidated.
- Complete audit trail of how a person curated their own history.
- Undo is free.
- **Sync becomes a set union with no conflict resolution** (ADR-0004). This is the largest downstream benefit and it is not obvious at first glance.

## Alternatives considered

**Mutable rows with `updated_at`.** Simplest and most familiar. Rejected: silent invalidation of derived records is undetectable, and it makes distributed sync require a conflict-resolution strategy the project cannot afford to get wrong.

**Mutable rows plus a separate audit log.** Common enterprise pattern. Rejected: two sources of truth that drift, and the audit log is invariably incomplete because it is written by application code that can forget.

**Event sourcing with full projection rebuild.** Strictly more powerful. Rejected as over-engineering for a single-user local application: it imposes an event-schema versioning burden on every contributor for capability the product does not need.

## Revisit if

- Storage growth becomes a real problem for real users (measure before acting).
- A compliance requirement demands hard deletion beyond what `purged` provides.
- Contributor error rates show the view discipline is not holding despite tests.
