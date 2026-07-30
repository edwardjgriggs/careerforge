# ADR-0018: Curation is protected by evidence, not by grouping key

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M6
**Refines:** ADR-0006

## Context

ADR-0006 says: *"Once a user edits membership, re-running a strategy never
touches that unit."* The obvious implementation follows the identity a strategy
uses. `context-temporal@1` derives a stable `grouping_key` for each unit, a
re-run matches candidates to stored units by that key, and a key belonging to a
pinned unit is skipped.

That is correct for renaming and for regrouping. It is wrong for merge and
split, and the failure is worse than it first appears.

Merging two units writes a third with a grouping key of its own. Both original
keys are now unclaimed, so the next run finds no unit for either, and
faithfully **recreates the two units the user had just merged away** — beside
the merged one, which is itself untouched. The store ends up with three units
covering the same evidence, and the user's decision has been reversed by a
command they were told was safe to re-run.

A test caught this on the first run of `careerforge group` after a merge. It
would otherwise have been found by a user, in the form of their curation
quietly undoing itself.

The general shape: a grouping key is a *strategy's* idea of identity. Curation
is a statement about *evidence*. Protecting the former does not protect the
latter, because a strategy is free to change its own keys and merge and split
exist precisely to disagree with them.

## Decision

**A grouping strategy must not create a unit containing evidence that already
belongs to a pinned unit.**

A run computes the set of evidence ids held by pinned current units, and skips
any candidate intersecting it. The grouping-key check is kept as well, because
it catches the direct case cheaply, but membership is the rule that decides.

Consequences that follow directly:

- Merge and split mark their results pinned. They are decisions, so they
  qualify by definition.
- A candidate that mixes curated and uncurated evidence is skipped whole. The
  alternative — creating it with the curated members included — would place the
  same evidence in a hand-made unit and a machine-made one, which is legal
  under many-to-many membership and is exactly the resurrection this prevents.
- Grouping is reported honestly: skipped candidates appear in the run as
  `pinnedSkipped`, so a user who wonders why new evidence did not group can see
  that their own earlier decision is why.

## Consequences

**Good**

- The promise in ADR-0006 is now true for every operation, not most of them.
- The rule is stated in terms a user would recognise: *evidence you have
  already placed by hand stays where you put it.* Grouping keys are an
  implementation detail and should never have been what protection depended on.
- It holds for future strategies for free. A replacement for
  `context-temporal@1` with entirely different keys inherits the protection,
  because the protection does not mention keys.

**Costs**

- New evidence that genuinely belongs with curated evidence will not be added
  automatically; the user must add it. That is the correct trade — the
  alternative is a system that edits hand-made groupings — but it means
  curation has an ongoing cost, and a UI that makes adding a member easy is now
  more important than it was.
- Aggressive pinning shrinks what automatic grouping can do. ADR-0006 already
  names that as a signal the strategy is wrong rather than the concept.

## Alternatives considered

**Record every grouping key a merged unit absorbed.** Keeps key-matching as the
mechanism; a merged unit would claim both originals' keys. Rejected: it makes
units carry a growing list of historical keys, it still fails when a strategy
changes how it derives keys, and it answers a question about evidence with a
statement about strategy internals.

**Refuse to run a strategy at all once anything is pinned.** Trivially correct
and useless — one curated unit would freeze grouping for an entire career.

**Let recreated units stand and de-duplicate in the UI.** Rejected outright.
The store would hold a claim the user had explicitly rejected, and every
consumer would need to know to ignore it. A store whose contents are only
correct after filtering is not correct.

**Tombstone the originals on merge and treat that as protection.** The
originals *are* tombstoned, and it is not sufficient: tombstoning suppresses
the old rows, but nothing stops the strategy creating brand-new rows for the
same keys on the next run.

## Revisit if

- A strategy appears that legitimately needs to add members to a curated unit —
  for example one operating on explicit user intent rather than heuristics.
  That would need a way to distinguish "the user placed this" from "the user
  merely accepted this".
- Users report that skipping a whole candidate loses too much, which would
  argue for admitting the uncurated remainder as its own unit rather than
  discarding it.
- Membership gains its own supersession chain, at which point removing a member
  becomes expressible and "pinned" may be too blunt an instrument.
