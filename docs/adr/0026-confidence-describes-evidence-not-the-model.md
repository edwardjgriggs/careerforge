# ADR-0026: Confidence describes the evidence, never the model

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M10
**Refines:** ADR-0002, ADR-0007

## Context

Every generated asset raises the same question from whoever reads it next:
*how much should I trust this?* CareerForge already answers a harder version of
that question per claim — `careerforge explain` walks the proof — but a
consumer scanning fifty bullets, or a future export format, or the Evidence
Explorer, needs an answer that fits on one line.

The industry answer is a model confidence score. It is available for free, it
looks quantitative, and it is worthless here. A confidence number describes the
model's estimate of its own output, which means a fluent invention scores high
and a terse truth resting on one commit scores high too. Neither number tells
you whether the sentence belongs on a résumé. Worse, presenting one *as*
evidence quality would undo the distinction the whole product is built on: it
would put a model's opinion in the position reserved for fact.

There is a real answer available, and it is already in the store. How many
independent sources back this? Did the person confirm any of it? Was an outcome
ever observed, or only activity? What had to be left out?

## Decision

**Every asset carries an assessment of its supporting evidence, computed from
the provenance graph, in which no model has any input.**

Two parts, because one word is not enough and a paragraph is too much:

**A grade** — `asserted` < `observed` < `confirmed` < `corroborated`. Four
named values rather than a score, because a number invites arithmetic that
means nothing: the distance between `observed` and `corroborated` is not a
quantity, and averaging two assets' grades produces a fiction.

**Signals** — a closed union of named findings, each carrying its own sentence
and a polarity. `multiple_independent_sources`, `user_confirmed`,
`activity_only`, `outcome_not_evidenced`, `thin_evidence`,
`support_superseded`, and the rest. Like `Remedy` (ADR-0022), the union is
closed so a new way for evidence to be strong or weak cannot be added without
deciding how to say it to a person.

Four rules worth stating:

1. **Independent agreement outranks a single confirmation.** A person's own
   answer is authoritative about their role and their numbers — that is why
   `evaluateSupport` demands it — but two unrelated sources recording the same
   work is a stronger claim about the world, and a consumer reasoning about
   quality should be told which they have. Source independence is counted by
   *collector*: two commits in one repository are one source saying something
   twice.

2. **It describes what survived, not what was available.** A bullet resting on
   two of forty records is backed by two. Counting the other thirty-eight would
   flatter it.

3. **What was left out is part of the assessment.** `droppedClaimTypes` records
   the claim types the evidence could not carry. Without it, an asset with no
   metric because none could be supported reads identically to one where
   nobody tried.

4. **It does not gate generation.** What may be *claimed* is already decided by
   `evaluateSupport`, a hard rule about individual assertions. This is a
   description of the whole, for a consumer to reason with. Letting it veto
   generation would duplicate the claim predicate badly and hide the real
   reason a bullet is thin — which is that the underlying work was not
   recorded.

**Stored and recomputed.** The assessment is written beside the asset, because
a consumer reading it in a year needs to know what the evidence looked like
when the words were written. It is also recomputed on read, because evidence
moves: records get corrected, questions get answered, sources get tombstoned.
When the two disagree, both are shown. A stored assessment presented as current
would be the same failure M7 rejected for support verdicts (ADR-0020) — a
judgement that cannot disagree with reality because nobody asks it to.

**Withdrawn evidence is reported, not silently subtracted.** The recomputation
reads support through the base `evidence` table rather than `evidence_current`,
because the view already excludes tombstoned rows — which would make a
withdrawal look like a record that was never cited. The counts would fall and
nothing would say why.

## Consequences

**Good**

- A consumer can reason about evidence quality independently of the generated
  text, which is the point: the sentence and its warrant are separable.
- `outcome_not_evidenced` is true of almost every asset this milestone can
  produce, because no shipped collector observes what changed in the world.
  Saying so on every bullet is uncomfortable and correct.
- The grade is a column, so "show me everything resting on a single
  unconfirmed source" is a query rather than a scan.
- The assessment is deterministic and pure, so a stored one can be compared to
  a fresh one by value.

**Costs**

- Four grades will feel coarse to somebody who wants ranking. That is
  deliberate; the moment it becomes a number, somebody averages it.
- `THIN_EVIDENCE_BELOW` is an honest threshold nobody has measured, marked as
  such in the source. It should eventually be derived from a corpus the way
  grouping's parameters were (ADR-0019).
- Recomputing on read costs a query per asset. Acceptable at the scale a
  personal career store operates at, and worth revisiting for a list of
  hundreds.

## Alternatives considered

**Model confidence.** Free, familiar, and precisely wrong. Rejected: it
measures the model, and a fluent invention scores as well as a terse truth.

**A numeric score computed from the evidence.** More expressive than four
grades and still model-free. Rejected: a number implies a scale that supports
comparison and arithmetic, and neither is meaningful. "0.72" invites a
threshold; `corroborated` invites reading the signals.

**Compute it on read only, storing nothing.** Always current, never stale.
Rejected: a consumer needs to know what the evidence looked like when the words
were written, and an export that carries only today's assessment cannot answer
that after the store has moved on.

**Store it only, never recompute.** Cheaper, and the request was for it to be
recorded. Rejected: it would be silently wrong the moment somebody corrected a
record, and silently wrong is worse than absent — a stale assessment reads
exactly like a fresh one.

**Let a low grade block generation.** Rejected: it duplicates the claim
predicate badly, and it hides the real problem. A thin bullet is a signal that
the work was not recorded, and the useful response is to collect more or answer
a question — not to be refused with no explanation.

## Revisit if

- A collector begins emitting outcome-shaped evidence, which would make
  `outcome_evidenced` reachable and change what a good grade looks like.
- Source independence needs to be finer than per-collector — two Git remotes
  are arguably two sources, and one monorepo is arguably not two.
- Consumers start needing to compare assets across people or teams, where an
  ordinal grade stops being enough and the pressure for a score returns.
- The signal union grows past the point where a person can read the whole list,
  which would argue for grouping signals rather than listing them.
