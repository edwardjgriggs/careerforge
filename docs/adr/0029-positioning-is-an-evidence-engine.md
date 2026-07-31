# ADR-0029: CareerForge is positioned as an evidence engine, not an AI platform

**Status:** Accepted
**Date:** 2026-07-31
**Milestone:** 0.2.0 launch
**Corrects:** Vision.md §1

## Context

Vision.md §1 opens: *"CareerForge is an **AI-powered Career Intelligence
Platform**."* That sentence is also the first line of the README, the `package.json`
description, and the CLI's help output. It is the first thing every reader of
this project encounters.

It is the wrong sentence, and the reason is not taste.

The product's thesis is that AI resume tools write confident claims about work
they cannot see, and that the fix is evidence with provenance and a refusal
when the evidence runs out. "AI-powered Career Intelligence Platform" is
indistinguishable from the marketing copy of the products that thesis rejects.
A reader deciding in three seconds what this repository is will file it under
the category it exists to argue against, and the argument never gets made.

This is not a hypothetical cost. The categories a reader might file this under
carry different objections and different ceilings:

| Filed as | What the reader then asks | Outcome |
|---|---|---|
| AI resume writer | "Does it hallucinate?" | The whole design is invisible; it looks like a worse competitor |
| Journaling / brag doc | "Do I have to maintain it?" | Collection being automatic is the answer, and never gets heard |
| Evidence engine | "What happens when the evidence is thin?" | The refusal is the answer, and it is the best thing here |

Only the third question is one this project wants to be asked, because it is
the only one whose answer is the architecture.

A second problem sits underneath the first. "AI-powered" makes AI load-bearing
in the description of a system in which ADR-0005 makes AI *additive* — the
domain layer cannot import a provider SDK, and CI runs the full suite with an
empty credential environment specifically so that "AI is never required" is a
test rather than a slogan. The headline contradicts the invariant.

## Decision

**CareerForge is described as a local-first evidence engine. The phrase
"AI-powered Career Intelligence Platform" is retired from every surface.**

The description is layered rather than singular, because four audiences file
things in four different folders and one sentence tuned for all of them is
tuned for none. All four are the same claim in different registers:

| Surface | Text |
|---|---|
| Hook — titles, tagline, social | It refuses to invent your accomplishments. |
| Definition — README, `package.json`, repository description | A local-first evidence engine for professional work. It collects what you actually did, and refuses to claim anything the evidence cannot support. |
| Technical — for readers who evaluate systems | Claim-level provenance and refusal-by-default, applied to a person's work history. |
| Human — for readers who evaluate tools | A system of record for the work you have actually done, so you do not have to remember it and nothing gets made up. |

**A refusal claim is never stated without its payoff adjacent.** "It will not
lie to you" is a negative promise, and a negative promise invites the reading
that the tool does *less* than the alternatives. It does less on purpose, and
the reason has to arrive in the same breath: because it refuses, what it does
say survives being asked about. Wherever the refusal appears, the sentence
after it says what that buys.

**Vision.md §1 is corrected to match**, per the process in CONTRIBUTING.md:
a frozen document is changed by an ADR that supersedes the decision in it, and
the reasoning lives here permanently.

## Consequences

**Good**

- The first sentence now does work that the rest of the project can pay off.
  A reader who arrives at "refuses to claim what the evidence cannot support"
  and then finds a `generate` command that deletes three of four proposed
  claims has had a promise kept, which is the cheapest trust there is.
- The description stops contradicting ADR-0005. Nothing in the positioning
  now implies AI is load-bearing, because it is not.
- "Evidence engine" is a phrase nobody owns, and the project has a working
  implementation of it rather than an aspiration.

**Costs**

- "Evidence engine" means nothing to a cold reader. It has no search volume and
  no existing demand, and category creation usually fails. It is therefore
  never used *first* — the hook does the interrupting, and the definition
  arrives once the reader is already curious.
- Dropping "AI" from the headline forgoes the search traffic attached to the
  term, which is real. The judgement is that traffic arriving through "AI
  resume" is traffic that will be disappointed by a tool that refuses to write
  one, and disappointed arrivals are worse than fewer arrivals.
- Four registers is four things to keep consistent. They are recorded in one
  table here so drift is visible rather than distributed.

**Neutral**

- ADR-0005's context paragraph still contains the old phrase. Accepted ADRs are
  not edited except for status and errors (docs/adr/README.md), and its
  argument does not depend on the wording. It stays as written.

## Alternatives considered

**Keep it and rely on the README body to correct the impression.** Rejected on
sequence: the body is read after the classification has already happened, by
the fraction of readers who did not bounce.

**"git log for your career."** Instantly comprehensible to the target audience,
and wrong in the way that matters. `git log` is complete and mechanical, and
this system's entire value is judgement about what evidence supports. It also
invites "so it is a git wrapper", which is a hard impression to undo.

**"The resume tool that refuses to write your resume."** Kept, but as a
*headline* rather than the definition. It is the strongest seven words
available and it performs the interrupt by itself, but it puts "resume" in the
frame and caps the perceived scope of a system that is not about resumes.

**Rename the project.** "Forge" means to falsify, which is an unfortunate
overlap for a tool whose purpose is refusing to fabricate. Rejected: the name
has thirteen milestones of documents and commits behind it, the joke is
survivable, and answering it plainly costs less than a rename.

## Revisit if

- The hook is measurably being misread — if the recurring first question from
  new readers is still "so it writes my resume with AI", the interrupt is not
  working and the words are wrong regardless of the argument here.
- The audience broadens past technical knowledge workers to the point where
  "evidence engine" excludes more readers than it attracts.
- A competitor adopts the evidence-and-refusal framing, at which point the
  differentiator moves from the framing to the enforcement and the description
  should follow it.
