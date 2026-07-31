# ADR-0025: The model proposes claims, and the sentence is composed afterwards

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M10
**Refines:** ADR-0002, ADR-0007, ADR-0024

## Context

M10 is where CareerForge finally writes the thing it exists to write, and the
whole architecture has been arranged so that this step is safe. The remaining
question is narrow: **in what order do generation and verification happen?**

The obvious order is the wrong one. Ask a model for a résumé bullet, get a
sentence, decompose the sentence into claims, check each claim, and remove the
ones that fail. Every step there is reasonable and the combination is not,
because two things go wrong at the seams.

**Decomposing prose is guessing.** Working out what a sentence asserts, and
which characters carry each assertion, is exactly the fuzzy-matching problem
this project refuses elsewhere — M9 declined to parse prose into structure on
the grounds that "prose parsing is where a résumé generator quietly starts
inventing". A decomposition that is 95% right produces spans that point at the
wrong words, and an explanation that highlights the wrong words is worse than
one that highlights none: it says something confident and false about which
part of the bullet the evidence covers.

**Removing a claim from a finished sentence is surgery.** Cutting "led the
rewrite of" out of "Led the rewrite of the transcript pipeline across 40 files"
leaves either a broken sentence or a rewritten one, and rewriting means asking
a model to say it more weakly. That is the industry's standard move — "helped
lead", "contributed to leading" — and it keeps the impression while discarding
the accountability. It is the failure mode this product exists to avoid, and
the naive ordering leads straight to it.

## Decision

**The model returns typed, cited assertions. It never returns a bullet.**

```
1. propose    typed, cited assertions          resume_bullet@1
2. resolve    citations → real records         suppressed and unknown dropped
3. check      each assertion → evaluateSupport unchanged since M1
4. ask        each failure → a Gap             not a softer sentence
5. compose    survivors → one sentence         spans exact by construction
6. describe   supporting records → assessment  see ADR-0026
```

Three consequences, each load-bearing:

1. **A failed claim's words are never placed.** There is no code path from a
   dropped claim to the rendered text, so the guarantee is mechanical rather
   than diligent. Nothing has to notice and remove anything.

2. **No hedging is expressible.** Composition joins surviving clauses with
   `, ` and `and`. There is no step that could soften a claim, because there is
   no step between the check and the output at all.

3. **Spans are exact by construction.** The renderer records each clause's
   offset as it places it, so `text.slice(start, end)` is the claim, always. A
   test asserts it, and it is a property rather than a measurement.

**Composition is deliberately plain.** `a, b, and c` — no transitions, no
subordination, no attempt at rhythm. Prose that reads well is prose somebody
shaped, and a shaping step is another place for an unsupported assertion to
appear. A slightly stiff sentence that is demonstrably true beats a graceful
one that is not.

**The write path checks again.** `AssetStore.record` puts every surviving claim
through `recordClaim`, which re-evaluates support against the database. The
generator works from records handed to it; the store is the only thing that
sees what is actually there. A claim that passed in memory and fails against
the store throws, and nothing is written.

**An empty bullet is a real outcome.** When nothing survives, no asset is
written — an asset with no text is something a user would find later and wonder
about — but the questions *are* recorded. In that case the questions are the
entire product of the run.

## Consequences

**Good**

- The fabrication-resistance tests run against hand-built evidence with no
  database, no provider, and no chance of an incidental pass. Removing the
  support check makes 15 of 28 fail.
- The claim type is stated by the model rather than inferred from grammar, so
  "led the rewrite" is judged as a `role` claim because it was labelled one —
  not because a regular expression noticed a verb.
- Explanations are exact. `careerforge explain` highlights the characters the
  evidence actually covers.
- A future generator — a local model, a template, a person — plugs into the
  same pipeline, because the contract is a list of typed claims rather than a
  prose style.

**Costs**

- The bullets are plainer than a marketing tool's. That is the stated
  preference and it is still a cost: some users will want more polish than a
  claim-joined sentence gives them.
- The model must label claim types correctly. A `role` claim mislabelled as an
  `action` would pass the wrong check — the prompt says so in as many words,
  and it remains the weakest link in the chain.
- Two support evaluations, one in the generator and one in the store. The
  duplication is deliberate and does mean a rule could be strengthened in one
  place and not the other; the store's is authoritative.

## Alternatives considered

**Generate prose, decompose, then check.** The obvious design. Rejected: see
above — the decomposition is guesswork and the removal step is surgery that
ends in hedging.

**Generate prose and reject the whole bullet if any claim fails.** No surgery,
no hedging, and much simpler. Rejected: it throws away the supported claims
along with the unsupported one, so a bullet with four good claims and one
invented percentage produces nothing. Users would regenerate until the model
stopped volunteering metrics, which trains the wrong behaviour.

**Let the model return both claims and a rendering, and use its rendering when
nothing was dropped.** Better prose in the common case. Rejected: it makes the
guarantee conditional, and a conditional guarantee is one somebody will
eventually meet on the wrong branch. It also means two renderings to explain
spans against.

**Have a second model pass rewrite the surviving claims into fluent prose.**
Rejected for now — it reintroduces exactly the unverifiable step this ADR
removes. If it is ever added it must be constrained to preserve every claim
substring, and the check for that is the same one `applyEdit` already uses.

## Revisit if

- Users consistently rewrite the joined sentence in ways that preserve every
  claim substring, which would mean the composition rule is too rigid and the
  style exemplars now say how.
- A claim type appears that cannot be expressed as a standalone clause, which
  would break the join.
- Mislabelled claim types turn out to be common in practice, which would argue
  for a validation pass that checks the label against the clause rather than
  trusting it.
