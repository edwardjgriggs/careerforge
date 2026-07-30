# ADR-0015 — Evidence identity and evidence content are separate tables

**Status:** Accepted · 2026-07-30
**Relates to:** ADR-0001, ADR-0013 · `Architecture.md` §4.2 · `Vision.md` §6
**Raised by:** M2 implementation

## Context

Two requirements collide in the schema, and the collision is not visible until the DDL is written.

**Append-only must be absolute.** ADR-0013 established that every domain table rejects `UPDATE`
and `DELETE` by trigger, with no exempt list. The working principle for M2 is stronger still:
append-only behaviour should be *impossible to violate accidentally*.

**Some content must be destroyable.** `TombstoneScope` includes `redacted` (clear the content,
keep the record's existence) and `purged` (remove the bytes). These are not conveniences. A
session transcript can contain a pasted production credential or a third party's personal data,
and "we keep everything forever" is the wrong answer to both. `Vision.md` §6 promises the user
control over their own data.

A single `evidence` table cannot satisfy both. Removing an excerpt from a row is an `UPDATE`;
removing the row is a `DELETE`. The only ways out are to drop the triggers around a privileged
purge path — which is precisely the accidental-violation vector the milestone exists to
eliminate — or to write conditional triggers that permit certain column updates, which turns the
trigger into a policy engine nobody can read.

## Decision

**Evidence is stored as two tables: an immutable spine and a destroyable body.**

| `evidence` | `evidence_content` |
|---|---|
| id, schema version, collector, source URI | title |
| natural key, **content hash** | summary |
| kind, class, sensitivity | excerpt |
| subject, asserter | payload reference |
| occurred / recorded timestamps | attributes |
| project, workspace, stream | |
| grouping hint, supersedes, collector version | |

- **`evidence` rejects both `UPDATE` and `DELETE`, forever.** No exception, no privileged path,
  no trigger juggling. The historical fact that *something was collected, from here, at this
  time, with this content hash* is permanent.
- **`evidence_content` rejects `UPDATE` but permits `DELETE`.** Content is never edited in place —
  a correction is a new evidence row (ADR-0001) — but it can be destroyed on request.
- Redaction and purge delete the content row. The spine, the tombstone, and every provenance edge
  survive.

**The content hash is on the immutable side deliberately.** After a purge, CareerForge can still
prove what *was* collected without retaining it: the hash remains, so a claim's provenance stays
explicable — "evidence removed at user request" — instead of silently dangling.

The `*_current` views join the two and expose whether content is still present, so a caller can
tell "no excerpt was ever captured" from "the excerpt was purged".

## Consequences

**Gains**

- Append-only on the evidence spine is now unconditional and structurally unbreakable. There is
  no code path anywhere that can update or delete it, so no bug can create one.
- Redaction and purge need no privileged escape hatch and no trigger manipulation.
- Provenance survives destruction. A purged record still explains itself.
- A natural home for the redaction work in M8: policy operates on the content table.

**Accepted costs**

- Every evidence read joins two tables. Cheap — the join is on the primary key — but real, and it
  is one more thing to get right in every query. Centralised in the views (ADR-0013).
- Two inserts per collected artifact, inside one transaction.
- The mental model is slightly less obvious than "one row per piece of evidence", which is why
  this ADR exists.
- `Architecture.md` §4.2's single-table sketch no longer matches and is corrected.

## Alternatives considered

**Drop the triggers around a privileged purge path, then recreate them.** Keeps one table and is
straightforward to write. Rejected outright: it means a code path exists that disables the
project's central data guarantee, and a bug or an exception thrown mid-transaction could leave it
disabled. Exactly the accidental violation the milestone forbids.

**Conditional triggers permitting updates to specific columns.** Technically possible in SQLite.
Rejected: the trigger becomes unreadable policy, and "which columns are mutable" is knowledge that
decays with every schema change.

**Keep everything and never destroy content; rely on `hidden` only.** Simplest of all, and
preserves history perfectly. Rejected: a leaked credential or another person's personal data must
actually be removable. Refusing to delete is not a privacy stance, it is the absence of one.

**Store content only in the blob store, outside the database entirely.** Attractive — blobs are
already prunable (ADR-0003), and it would leave one table. Rejected for the searchable fields:
title, summary, excerpt, and attributes back FTS5 and analytics, and pushing them out of SQL would
mean rebuilding search over files, which is the mistake ADR-0003 declined to make. Large payloads
do stay in the blob store; only the searchable body lives here.

## Revisit if

- The join proves measurably costly on realistic corpora — measure before acting.
- A future requirement makes some part of the spine legitimately destroyable, which would mean
  reconsidering where the line falls rather than abandoning the split.
