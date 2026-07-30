# ADR-0020: An explanation separates grounds from interpretation

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M7
**Refines:** ADR-0002, ADR-0007

## Context

ADR-0007 established claim-level provenance and the rule that AI interpretation
can never be the sole support for a claim. That rule is about what may be
*written*. It says nothing about what is *shown*, and the two are not the same
problem.

Consider a résumé bullet an enrichment produced by synthesising six artifacts.
Every fact in the bullet traces to evidence, so the claim is legitimately
supported. The enrichment is also genuinely part of the bullet's history — it
is why the sentence is worded the way it is. Both belong in an honest account
of where the bullet came from.

Render them as one list of linked records and the account stops being honest.
A reader sees six citations and a seventh entry that looks like the others, and
has no way to tell that one of them is a model's reading rather than a thing
that happened. That is precisely the move by which every AI résumé tool
currently shipping launders a guess into a citation, and it would be worse here
because the surrounding rigour makes the list look trustworthy.

The user asking "why is this true?" is usually about to put the sentence in
front of a hiring manager. A partially-labelled answer is not good enough.

## Decision

**An explanation has two sections, and a node's section is decided by what it
is, not by how it was reached.**

| Section | Contains | Answers |
|---|---|---|
| `grounds` | observed, derived, stated, grouped | why is this true? |
| `interpretation` | interpreted | why is it worded this way? |

Supporting decisions:

1. **A vocabulary a reader can use without knowing the schema.**
   `ProvenanceClass` is `observed · derived · stated · grouped · interpreted`.
   It is a different axis from `ProvenanceNodeKind`, which says which table a
   record lives in. `stated` is separated from `observed` because the
   difference between "a collector saw this" and "you told us this" is the
   difference that decides whether a `role` claim may exist at all.

2. **The graph cannot express an enrichment as support.** `isWellFormed`
   rejects a `supports` edge from an enrichment, and a `CHECK` constraint
   rejects it in the database. Two guards, deliberately: the claim predicate
   already refuses interpretation-only support, but it permits a *mixed*
   support set, which would have put a model's reading into `grounds` beside a
   commit.

3. **The verdict is recomputed at explain time, never read from the claim
   row.** A stored verdict is a cached opinion. If supporting evidence has
   since been hidden or purged, the honest answer is the one the graph gives
   now — so a proof and the claim it explains cannot disagree.

4. **Suppressed records drop out and are counted, not named.** `withheld`
   reports how many supporting records can no longer be read. Naming them
   would defeat the purge that removed them; omitting the count silently would
   leave a sentence standing on evidence that is gone.

5. **Membership is derived, not duplicated.** `grouped_into` edges are
   synthesised from `work_unit_members` rather than written twice. Storing the
   same fact in two places is how the two come to disagree, which ADR-0013
   already settled for suppression.

6. **The walk is bounded and cycle-safe**, and says so when it stops early.
   Evidence Explorer sits on a UI path; a proof that silently truncates would
   be read as complete.

## Consequences

**Good**

- A reader can tell, at a glance and without documentation, which parts of an
  answer are facts and which are a model's reading.
- The separation survives contributors who have not read this file, because
  the database refuses the edge.
- Enrichment provenance is *preserved* rather than suppressed. Hiding the
  enrichment would have been the easy way to keep the sections clean, and it
  would have lost the answer to "why does it say it like that?"

**Costs**

- Two sections is more UI than one list, and every future renderer must
  implement both. That is the intended cost.
- `ProvenanceClass` is a second classification axis to learn alongside
  `EvidenceClass` and `ProvenanceNodeKind`. It earns its place by being the
  only one of the three a user ever sees.
- Recomputing the verdict makes `explain` a graph traversal rather than a row
  read. Bounded depth keeps it cheap; a store with pathological fan-out would
  need a cache, and that cache would need this ADR's warning attached.

## Alternatives considered

**One list, with a `class` field per entry.** Simplest, and what the schema
naturally suggests. Rejected: it makes correctness depend on every renderer
choosing to display the field prominently, and the failure mode is silent and
severe.

**Exclude enrichments from explanations entirely.** Keeps the proof clean by
deletion. Rejected: it discards a true and useful part of the record, and a
user who asks why a bullet is worded a particular way deserves an answer.

**Let the claim's stored `support_state` be the verdict.** One row read instead
of a traversal. Rejected: it goes stale the moment evidence is hidden, and a
stale "SUPPORTED" is the single most dangerous string this product could print.

**Write `grouped_into` edges at grouping time.** Would make the graph
self-contained. Rejected: membership already lives in `work_unit_members` with
its own role and confidence, and two homes for one fact is a drift waiting to
happen.

## Revisit if

- A node kind appears that is neither fact nor interpretation — an external
  attestation from a manager, say, which is stated but not by the subject.
  That would need a sixth class rather than being forced into `stated`.
- Explanation depth proves too shallow for a real provenance chain, which would
  argue for lazy expansion in the UI rather than a larger fixed bound.
- A renderer needs the proof as a graph rather than a tree — for example to
  show that one commit supports two different claims. The tree is a rendering
  choice, and the underlying edges already support the other reading.
