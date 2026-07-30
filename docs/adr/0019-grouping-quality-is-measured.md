# ADR-0019: Grouping quality is measured against a labelled corpus

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M6

## Context

ADR-0006 established that grouping thresholds are configuration because they
will be wrong at first. It did not say how anyone would know when they became
right.

Grouping has a property that most of this codebase does not: **there is no
correct answer derivable from the data.** Whether three days on a branch is one
accomplishment or three is a judgment about someone's working life. A test can
assert that grouping is deterministic, that it is idempotent, that sensitivity
propagates — and every one of those can pass while the output is useless.

Without a benchmark, tuning becomes a conversation about intuitions. Somebody
widens the idle gap, the output "looks better", and nobody can say whether last
month's output would still look better today. Every change is an argument and
every regression is invisible.

The risk is not hypothetical. This milestone changed the strategy four times,
and each change was an improvement in one respect and a plausible regression in
another.

## Decision

**`eval/grouping` holds hand-labelled cases, and the aggregate score is
committed. A change that lowers it fails the build.**

- Each case is evidence plus the units a person would recognise, plus a written
  rationale for the judgment.
- **Labels are written before the strategy is run against them.** A label
  written after seeing output is not a label; it is a transcript of the
  behaviour, including the bugs.
- Two scores, because grouping fails two independent ways: **pairwise F1** for
  whether the boundaries are right, and **admission accuracy** for whether the
  right things were kept. A single blended number lets one hide inside the
  other.
- `baseline.json` is the committed score. Improving grouping means raising it
  and updating the baseline in the same commit; a deliberate trade means saying
  so there.
- The corpus is synthetic — structurally faithful, textually invented — for the
  same reason the session fixtures are (ADR-0017 and `Vision.md` §6). Real
  career evidence does not go in a public repository.

**The labels are the specification. The strategy is one attempt at satisfying
them.**

## Consequences

**Good**

- It worked immediately. Written before tuning, the corpus failed three of
  eight cases on the first run and each failure was a real defect: interleaved
  branches produced four units for two accomplishments, a feature spanning
  three days split into three, and a day of aborted starts was admitted as an
  accomplishment because merging noise created apparent substance.
- Two further defects were found by running against a real store, turned into
  labelled cases, and fixed: proximity chaining a month of work into one unit
  of 839 artifacts, and a trunk branch being mistaken for a statement of
  intent.
- Every default in `DEFAULT_GROUPING_CONFIG` now has a case behind it. None
  were chosen because output looked better.
- A future strategy — including the AI-based one ADR-0006 permits — is
  comparable to this one on the same measure rather than on a demo.

**Costs**

- A perfect score means only that the stated judgments are satisfied. The
  corpus currently scores 100%, which is the weakest possible reading of the
  number: its author tuned against it. This is written into `eval/grouping/README.md`
  so nobody mistakes it for evidence that grouping is solved.
- The corpus needs to keep growing, and the most valuable case to add is always
  one the strategy gets wrong. A corpus that only ever passes has stopped being
  a benchmark and become a regression test.
- Labels can be wrong, and a wrong label is worse than no label because it is
  enforced. The rationale field exists so a disagreement is with a stated
  reason rather than with a mystery.

## Alternatives considered

**Tune against real data by eye.** What would have happened by default, and
what the milestone notes in `IMPLEMENTATION_PLAN.md` anticipated. Rejected:
real data is the right place to *find* problems and the wrong place to *decide*
them, because it cannot be committed, cannot be shared with a contributor, and
gives a different answer on every machine.

**Assert unit counts against real data.** Cheap, and it catches the
catastrophic case — 1,200 units, or one. Rejected as a benchmark: it is
satisfied by any strategy that produces a plausible number of wrong units. It
survives as a sanity check in the milestone acceptance criteria, which is the
right weight for it.

**Cluster-level exact match instead of pairwise F1.** Simpler to explain.
Rejected: it cannot distinguish a unit that is right except for one stray
member from one that is wrong throughout, and that difference is most of what
tuning is about.

**No benchmark; rely on user feedback after release.** The honest version of
doing nothing. Rejected because grouping quality degrades silently — a user
sees units that are subtly wrong and concludes the product is not for them,
without ever filing the report that would have explained why.

## Revisit if

- The corpus stops finding defects, which would mean it has been overfitted and
  needs cases drawn from a different working style than its author's.
- A strategy needs judgments the pairwise metric cannot express — hierarchical
  units, or overlapping membership, where "together or apart" is not a complete
  question.
- Real labelled data becomes available that can be committed, for example
  contributed by users who consent to publishing a redacted sample. That would
  be strictly better than synthetic cases and should replace them.
