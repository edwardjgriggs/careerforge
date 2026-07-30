# ADR-0021: The person is a source; the interview is not a collector

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M7

## Context

`IMPLEMENTATION_PLAN.md` calls the interview a "Manual Interview collector",
and the shape is tempting: it produces Evidence, so it looks like every other
producer of Evidence, and implementing `CollectorPort` would let it inherit the
conformance suite for free.

It does not fit, and forcing it would damage the contract it was borrowing.

`CollectorPort` promises `discover`, `collect(scope, cursor)`, backfill,
determinism, idempotency, and interruption safety. None of those mean anything
here. There is nothing to discover — the questions come from gaps already in
the store. There is no cursor, because a person is not a log with a position.
Backfill is incoherent: you cannot replay somebody's memory. And determinism is
exactly wrong — asking the same question twice should produce whatever the
person says the second time, and the conformance suite would assert the
opposite.

The deeper problem is what happens to the conformance suite. Eight checks that
every collector must pass are only meaningful if passing them means something.
Add an implementation that satisfies them vacuously — `discover` returning an
empty list, a cursor that is always null, `collect` yielding nothing — and the
suite's guarantee weakens for every real collector that comes after.

## Decision

**The interview produces Evidence without being a `CollectorPort`.**

`InterviewEngine` takes a gap and an answer, and writes `user_confirmed`
evidence with `collectorId: 'interview'`, `kind: 'interview.answer'`, in the
same transaction as the gap transition and the `answers` edge.

Two things this keeps:

- **The person is a source.** Their answer is Evidence like any other, carries
  a collector id like any other, and is reusable by every future asset. Nothing
  about the evidence model is special-cased.
- **`collect` remains one idea.** A collector reads a source that exists
  independently of CareerForge and can be read again. That is what the
  conformance suite tests, and it stays true.

Supporting decisions:

- **Identity is the question, not the answer.** The natural key is
  `interview://<work-unit>/<gap-type>`, so answering the same question again
  supersedes rather than recording a second opinion about one fact — the same
  correction semantics a re-collected artifact gets (ADR-0001).
- **The answer is placed at the work it describes**, not at the moment of
  typing. A résumé orders by when work happened.
- **No model, ever.** Gaps are raised by rule from a failed support predicate,
  and questions come from templates. The interview must work for a user who
  never enables AI, which is why `QUESTION_TEMPLATES` is a table of functions
  rather than a prompt. Tested explicitly, because this is easy to lose later.

## Consequences

**Good**

- The conformance suite keeps meaning what it says.
- The interview is free to have the shape it actually needs — pending
  questions, answer, decline — instead of a shape borrowed from log readers.
- It is the clearest demonstration in the codebase that AI is optional: the
  path that turns an unsupported `role` claim into a supported one involves no
  provider at all.

**Costs**

- Evidence can now be produced by something that is not a `CollectorPort`, so
  "where does evidence come from?" has two answers instead of one. Mitigated by
  both writing through the same `EvidenceStore.emit` and obeying the same
  identity rules.
- The interview has no conformance suite of its own. Its guarantees are covered
  by ordinary tests, which is weaker than a shared contract and appropriate
  while there is one implementation.
- `IMPLEMENTATION_PLAN.md` says "collector". This ADR is the correction.

## Alternatives considered

**Implement `CollectorPort` anyway.** Free conformance coverage, and the plan
already used the word. Rejected: every method would be a stub, and stubbed
conformance is worse than none because it makes the suite look more thorough
than it is.

**Widen `CollectorPort` so interactive sources fit** — optional `discover`,
nullable cursors, a `deterministic: false` capability. Rejected as designing an
abstraction around its second implementation, and the second implementation is
not really a collector. The M4 principle applies: keep it simple until several
real cases justify the generalisation.

**Have the interview write Evidence directly, bypassing `EvidenceStore`.**
Rejected outright. Identity, supersession, and content hashing would then have
two implementations, and the second would be the one nobody tests.

**Make the interview a `CollectorPort` whose scope is a work unit.** The
closest fit, and worth taking seriously: gaps for a unit are discoverable and a
run could emit whatever has been answered. Rejected because it inverts the
interaction — the collector would emit answers already given rather than
gathering new ones, which is a reporting API wearing a collector's interface.

## Revisit if

- A second interactive source appears — importing a performance review the user
  pastes in, or a manager's attestation. Two implementations would justify a
  shared contract, and it would be a different one from `CollectorPort`.
- A collector needs to ask a question mid-collection, which would mean the two
  ideas are less separate than this decision assumes.
- The conformance suite grows optional sections, at which point the reason for
  keeping the interview out of it weakens considerably.
