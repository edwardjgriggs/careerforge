# ADR-0027: An outcome must be observed, never inferred from the work that caused it

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M10
**Refines:** ADR-0007
**Changes:** the `outcome` branch of `evaluateSupport`, unchanged since M1

## Context

M1 defined what each claim type requires, and four of the five rules have held
without amendment through nine milestones:

```
action   >=1 Evidence or Work Unit
scope    >=1 Evidence carrying the asserted figure
role     >=1 user_confirmed Evidence          never inferred
metric   derived or user_confirmed            never model-generated
outcome  >=1 Evidence                         <- this one
```

The `outcome` rule was written with the reasoning that an outcome is "a
specific factual assertion about a result, so it needs evidence" — as opposed
to `action`, which a work unit alone can carry. That distinction is real and
the rule still got it wrong, because *which* evidence was never specified.

M10 built the first thing that generates outcome claims, and the invariant test
that walks every claim type against ordinary evidence caught it immediately: a
claim of *"eliminated the nightly memory alerts"* passed, supported by the
commit that changed the alerting code.

The commit is evidence that the change was made. It is not evidence that the
alerts stopped. Treating it as such is precisely the inference the product
refuses everywhere else — it is the same move as concluding somebody led the
work because they touched the config, and it is arguably the most common way a
résumé sentence becomes untrue while every individual fact in it stays true.

The rule survived nine milestones because nothing generated an outcome claim.
A predicate with no caller cannot be wrong in a way anybody notices.

## Decision

**An `outcome` claim requires evidence that observed the result.** Three ways
to satisfy it:

- a record whose kind observes an outcome — a release, a merge, a closed issue,
  a resolved incident;
- `derived` evidence, which is computed from the store rather than asserted;
- `user_confirmed` evidence, which is the person saying what changed.

Evidence of the work itself no longer counts.

`SupportNode` gains `recordsOutcome`, resolved by the caller for exactly the
reason `corroborating` is: whether a record observes a result depends on the
collector's kind vocabulary, which the domain deliberately does not interpret.
The domain states the rule; the adapter answers the question.

**The remedy changes with it.** The old refusal said "collect what shows the
result", which is advice a user usually cannot act on — no shipped collector
observes outcomes, so there is nothing to go and collect. The new one asks:
*"What actually changed as a result of this work?"* That is answerable today,
and answering it produces `user_confirmed` evidence that satisfies the rule.

## Consequences

**Good**

- The one remaining path by which activity could be dressed as impact is
  closed. All five claim types now refuse inference in the same way.
- The refusal is actionable. Under the old rule a user could not have made an
  unsupported outcome claim supportable; under the new one they answer a
  question.
- `outcome_not_evidenced` in the evidence assessment (ADR-0026) and the
  `resultBasis` flag on `star_candidate@1` (M9) now agree with the claim
  predicate. All three said the same thing; only two of them enforced it.

**Costs**

- Outcome claims are effectively unreachable without an interview answer,
  because no collector emits an outcome-shaped record. Bullets will say what
  was done and stop. That is the honest state of a coding-artifact corpus, and
  it is a strong argument for the collectors named in the backlog — a PR
  collector that records merges would make this rule reachable by observation.
- A domain rule changed after nine milestones of stability, which is exactly
  the kind of change the working principles are arranged to make deliberate.
  Hence this record.
- `recordsOutcome` is the second caller-resolved flag on `SupportNode`. A third
  would suggest the boundary is in the wrong place and the domain needs a
  richer view of evidence.

## Alternatives considered

**Leave it and let the assessment flag it.** `outcome_not_evidenced` already
appears on almost every asset, so a reader is warned. Rejected: a warning
beside a claim is not the same as refusing the claim, and this product's whole
position is that the refusal is the feature. A user reading their own bullet
will trust the sentence over the footnote.

**Require `user_confirmed` only, like `role`.** Simpler, and safe. Rejected: it
would refuse a genuine observation — a closed issue linked to the work is
better evidence of an outcome than somebody's recollection, and a rule that
cannot accept it discourages exactly the collectors worth building.

**Have the generator drop outcome claims instead.** No domain change, and the
fabrication tests would pass. Rejected: it would put the rule in one caller and
leave the predicate wrong for every future one. The domain is where "what may
be claimed" lives, and a rule enforced only in the generator is a rule the next
generator will not have.

**Introduce a distinct `impact` claim type with stricter rules.** Rejected as
scope creep that solves the problem by renaming it — the existing type is not
wrong, its rule was.

## Revisit if

- A collector begins emitting outcome-shaped evidence, at which point the
  practical effect of this rule changes substantially and the `OUTCOME_KINDS`
  list stops being aspirational.
- The list of outcome kinds needs to be extensible by collectors rather than
  fixed in the generator, which it will as soon as a third-party collector
  wants to declare one.
- A third caller-resolved flag appears on `SupportNode`, which would be the
  signal that the domain's view of evidence is too thin.
