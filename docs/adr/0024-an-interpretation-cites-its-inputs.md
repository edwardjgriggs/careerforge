# ADR-0024: An interpretation cites its inputs, or it is discarded

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M9
**Refines:** ADR-0002, ADR-0020

## Context

M9 is the first milestone where a model produces output that reaches the store.
Everything before it — the choke point, the claim predicate, the provenance
graph — was arranged so that this moment would be safe. The remaining question
is narrow and specific: *when a model returns a confident statement, how do we
know it is about the records we sent?*

Structured output does not answer it. A JSON Schema constrains shape, and a
fluent, plausible, entirely invented capability has exactly the right shape.
The failure mode is not malformed data; it is well-formed data about work that
was never in front of the model.

This matters more here than in most applications. A hallucinated summary is
embarrassing. A hallucinated capability attached to somebody's career record
gets rehearsed, put on a résumé, and defended in an interview. The person
cannot tell it apart from the true items sitting beside it, because it looks
exactly like them.

The system also already knows the answer. The payload the policy engine
assembled carries `[evidence <id>]` markers. The set of records the model saw
is not a guess — it is a value.

## Decision

**Every returned item names the records it came from, and the citations are
checked against what was actually sent.**

The requirement lives in three places, deliberately:

```
the schema         `evidence` is a required field on every item
the instructions   "an item that cites a record you were not shown will be discarded"
the validator      checked against the payload the engine built
```

Schema alone would be conformance without meaning. Instructions alone would be
a request. The validator is the enforcement, and the other two exist so the
model is not being asked to fail.

Four rules follow:

1. **An item citing nothing survives nothing.** No `evidence` array, or an
   empty one, is `uncited` and dropped.

2. **An item whose every citation is unknown is dropped** as
   `fabricated_citation`. It may even be true; it is still unusable, because
   nothing in the store stands behind it.

3. **An item citing some real records and some invented ones survives, minus
   the inventions.** The partial case is the common one and the tempting one to
   drop whole. What the model said is grounded in something real, and the
   invented id simply does not travel into the graph.

4. **Discards are counted and reported, never silent.** A run that quietly
   threw away half its output while reporting success would be worse than one
   that failed. Unknown ids are surfaced separately, because many of them is a
   signal about the prompt rather than about the work unit.

**A run that returns nothing usable is recorded as `unusable` and never
cached**, so a bad answer does not become permanent by being remembered.

**Every interpretation starts unreviewed.** Review is recorded by superseding,
so accepting or rejecting one leaves what the model originally said queryable —
a review that erased the original would leave nothing to review against.

**Enrichment cannot write fact, and this is structural.** `@careerforge/enrich`
may not import the store or any database driver, enforced by lint. Results are
handed back to a caller. The only graph edges enrichment produces are
`interprets`, which the domain predicate and the database CHECK both refuse to
let carry support.

## Consequences

**Good**

- The cheapest available check on the one failure mode that matters here, and
  it costs the model almost nothing to comply with.
- Every interpretation can be shown beside the specific records it read rather
  than beside the whole work unit, which is what makes review tractable — a
  reviewer who must re-read forty records to judge one sentence will not.
- `unknown_citations` is a prompt-quality metric that arrives for free.
- The staleness question becomes answerable per interpretation: an item citing
  a record that has since been corrected is flagged, not silently kept.

**Costs**

- Output is smaller. A model that would have offered a synthesis across records
  it could not pin down returns nothing, and some of what is lost was true.
  Accepted: a true statement that cannot be traced is indistinguishable from an
  invented one, and this system's value is entirely in being able to tell them
  apart.
- More tokens per item, and a schema every future template must follow.
- A model that cites badly looks worse than one that cites nothing, which could
  push a future template author toward loosening the requirement. The tests are
  the counterweight.

## Alternatives considered

**Trust structured output.** Cheapest, and what most applications do. Rejected:
schema conformance is orthogonal to groundedness, and the failure it misses is
the only one that matters.

**Ask a second model to verify the first.** Popular, and would catch more than
citation checking does. Rejected for now: it doubles cost and egress, and it
answers a question about plausibility rather than about provenance. Citation
checking is mechanical, free, and total.

**Drop any item with a single bad citation.** Simpler rule. Rejected: it throws
away grounded statements over one bad id, and a model that cites four records
correctly and invents a fifth has still told you something true about the four.

**Record uncited items with a "low confidence" flag.** Rejected: a confidence
number on an ungrounded statement is a worse lie than the statement, because it
implies the system measured something.

**Compute citations ourselves by matching text back to records.** No model
cooperation needed. Rejected: fuzzy matching would manufacture provenance that
the model never claimed, which is the failure mode inverted rather than fixed.

## Revisit if

- A template needs items that legitimately span the whole unit rather than
  specific records — a summary, say — which would need a citation form meaning
  "all of it" rather than an exemption.
- Providers begin returning grounded spans natively, making the citation field
  redundant.
- `unknown_citations` stays high across prompts and models, which would suggest
  the payload's `[evidence <id>]` markers are hard to copy rather than that
  models are inventing.
