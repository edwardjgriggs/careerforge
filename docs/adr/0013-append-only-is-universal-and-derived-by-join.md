# ADR-0013 — Append-only is universal, and suppression is derived by join

**Status:** Accepted · 2026-07-30
**Supersedes in part:** `Architecture.md` §1.2 (I2), §2.2, §5.3
**Relates to:** ADR-0001, ADR-0002
**Raised by:** M2 implementation

## Context

Writing the schema surfaced two contradictions that were invisible on paper. Both concern the
append-only model, and both would have been resolved by accident — badly — if implementation had
simply proceeded.

### Contradiction 1 — I2 names only four table groups

`Architecture.md` §1.2 states invariant I2 as:

> No `UPDATE` or `DELETE` against evidence, work-unit, enrichment, or provenance tables.

Gaps, claims, and assets are absent from that list. Meanwhile §5.3 defines a Gap with `status`,
`asked_count`, and `answered_by` — fields that plainly change as a user is asked, answers, or
declines. Read literally, gaps are mutable.

That is either an oversight or a deliberate exception. If deliberate, it is a bad one: an
invariant with a list of exempt tables is an invariant every contributor must memorise, and the
argument for exempting a fifth table will be exactly as good as the argument for the first four.
"Nothing is ever updated" is a rule people can hold; "nothing is updated except gaps, claims, and
assets" is a rule people get wrong.

### Contradiction 2 — `tombstoned_by` cannot be set

`Architecture.md` §2.2 puts `tombstoned_by` on the Evidence record, and §4.2 carries it into the
`evidence` table. Suppressing a record therefore means setting that column.

**Setting a column is an `UPDATE`.** The trigger enforcing I2 would reject it. The architecture
specified a schema whose own suppression mechanism its own invariant forbids.

The same applies to `work_units.tombstoned_by`, and to `enrichments.superseded_by`.

## Decision

**1. Append-only applies to every domain table, without exception.**

`evidence`, `work_units`, `work_unit_members`, `enrichments`, `enrichment_runs`,
`provenance_edges`, `claims`, `gaps`, `assets`, `tombstones`, and `identities` all reject `UPDATE`
and `DELETE` by trigger. There is no exempt list to remember.

State changes that look like mutation become new rows superseding old ones. A gap that is asked,
then answered, produces three rows and a complete history of the interaction — which the interview
engine wants anyway, since "we asked twice and they declined" is exactly the signal that should
stop it asking a third time.

**2. Suppression and supersession are never stored as a column on the record they affect.**

`tombstoned_by` is removed from `evidence` and `work_units`. `superseded_by` is removed from
`enrichments`.

Suppression is derived by joining to `tombstones`. Supersession is derived by looking for a newer
row whose `supersedes` points at this one. Both directions already existed in the schema — the
redundant reverse pointers were the only part that required mutation.

The domain anticipated this: `suppressedIds(tombstones)` (M1) already computes suppression from
the tombstone set rather than from a flag.

**3. `*_current` views are the only supported read surface.**

Base tables are effectively private. Every read path resolves supersession and suppression in one
place, so adding a read path cannot reintroduce the bug where a tombstoned record surfaces in an
exported resume.

## Consequences

**Gains**

- One rule, no exceptions, mechanically enforced. Impossible to violate accidentally, which is
  precisely the property this milestone exists to establish.
- Forward-pointing links only. A record is written once and never touched again, so no write ever
  needs to reach backwards into an existing row.
- Gap interaction history is preserved for free, and `asked_count` becomes an honest record of
  what happened rather than a counter someone remembered to increment.
- Concurrent writers cannot conflict on a domain row, because no domain row is ever written twice.
  This is the same property that makes sync a set union (ADR-0004), now holding universally.

**Accepted costs**

- More rows. A gap asked three times and then answered is five rows rather than one. Rows are
  small; the tables are indexed on the fields that matter.
- Every read must resolve current state. Centralised in the views, and cheap with the right index,
  but it is real work that a mutable schema would not do.
- The domain's gap transition helpers must mint new identifiers rather than returning a modified
  copy. Slightly wordier at the call site, and honest about what is happening.
- `Architecture.md` §2.2, §4.2, and §5.3 no longer match the implementation. They are corrected to
  match this ADR; the reasoning lives here.

## Alternatives considered

**Keep I2's narrow table list and let gaps, claims, and assets mutate.** Fewer rows, simpler
queries, and it matches the architecture as written. Rejected: it makes the project's central data
guarantee conditional, and a conditional guarantee is one contributors will get wrong. It also
reintroduces the silent-invalidation problem ADR-0001 exists to prevent — a claim points at a gap
whose status changed underneath it.

**Keep `tombstoned_by` but populate it at insert time only.** Would preserve the schema as
specified. Rejected as incoherent: a record cannot know at insert time that it will later be
suppressed, so the column would be permanently null and suppression would be derived by join
anyway — the column would be decoration.

**Allow `UPDATE` on a narrow allowlist of columns via trigger conditions.** Technically possible
in SQLite. Rejected: the trigger becomes a policy engine nobody can read, and "which columns are
mutable" is exactly the kind of knowledge that decays.

**Model gaps as fully derived state, recomputed from claims and answers each time.** Elegant, and
it removes a table. Rejected: `asked_count`, `declined`, and `last_asked_at` record what happened
between the user and the system, which cannot be recomputed from evidence. Declining to answer is
itself a fact worth keeping.

## Revisit if

- Row growth becomes a measured problem at realistic scale — measure before acting; a compaction
  pass over superseded chains is possible without changing this rule.
- A domain concept appears whose state genuinely has no meaningful history, making an append-only
  chain pure overhead. Even then, prefer a derived projection over an exception.
