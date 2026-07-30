# Grouping evaluation corpus

Hand-labelled examples of what a Work Unit should be, and a score for how close
`context-temporal@1` gets.

## Why this exists before any tuning

Grouping thresholds will be wrong at first — the implementation plan says so
outright. The question is how anyone would know when they get better.

Without a benchmark, tuning is a conversation about intuitions: someone raises
the idle gap, the output "looks better", and nobody can say whether last
month's output would still look better today. Every change becomes an argument
and every regression is invisible.

So the labels come first. Each case states what a person would call one piece
of work, the runner measures how close the strategy gets, and the score is
committed. A change that improves grouping raises the score and updates the
baseline in the same commit. A change that lowers it fails the build.

**The labels are the specification.** The strategy is one attempt at satisfying
them, and it is expected to be replaced.

## How a case is labelled

Each directory under `cases/` holds:

| File            | What it is                                                     |
| --------------- | -------------------------------------------------------------- |
| `evidence.json` | The input: evidence records, as a collector would emit them    |
| `expected.json` | The label: which records a person would call one piece of work |
| —               | The directory name states what the case is about               |

`expected.json` looks like this:

```jsonc
{
  "rationale": "Why a person would draw the boundaries this way.",
  "units": [["ev-1", "ev-2", "ev-3"]], // one array per expected Work Unit
  "excluded": ["ev-9"], // noise: below the substance floor
}
```

Labels are judgments about someone's working life, not facts derivable from the
data. They should be written by a person who would recognise the work, and the
rationale is there so a later disagreement is with a stated reason rather than
with a mystery.

## The score

Two numbers, because grouping fails in two independent ways.

**Pairwise F1** — for every pair of evidence records, did the strategy put them
together when the label says together, and apart when the label says apart?
Chosen over exact-cluster-match because it degrades gracefully: a unit that is
right except for one stray member should score better than one that is wrong
throughout, and exact match cannot express that.

**Admission accuracy** — of the records the label calls noise, how many were
correctly excluded, and how many real ones were wrongly dropped? A strategy can
achieve perfect F1 on what it admits while discarding most of a career.

Both are reported per case and in aggregate. Aggregate is what the baseline
asserts.

## Adding a case

1. Create a directory named for the judgment it encodes.
2. Write `evidence.json` — structurally faithful, textually synthetic. As with
   the session fixtures, real transcripts and real repository history are never
   committed.
3. Write `expected.json` **by hand, before running anything.** A label written
   after seeing the output is not a label, it is a transcript of the bug.
4. Run the eval. If the score drops, either the strategy is wrong or the label
   is — and deciding which is the entire point of having both.

## What a perfect score does not mean

The corpus currently scores 100%. That is the weakest possible reading of the
number: the labels were written first, the strategy failed three of them, and
the strategy was changed until it did not. A benchmark its author tuned against
measures whether the stated judgments are satisfied — nothing more.

It is not evidence that grouping is good. It is evidence that grouping does
what this corpus says, and that a future change which breaks any of it will be
caught.

The corpus is therefore expected to keep failing. **The most valuable case to
add is one the strategy gets wrong**, and the right time to add it is whenever
real output looks wrong: turn the disagreement into a labelled case, watch it
fail, then fix the strategy. A corpus that only ever passes has stopped being a
benchmark and become a regression test.

## Real data

`baseline.json` records the aggregate score this corpus currently produces.
The corpus is synthetic by necessity; `grouping-eval.test.ts` additionally
reports — without asserting — what the strategy does to whatever real evidence
is on the machine, so a distribution nobody imagined is visible.
