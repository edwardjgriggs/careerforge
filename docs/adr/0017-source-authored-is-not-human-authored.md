# ADR-0017: Source-authored is not human-authored

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M5

## Context

ADR-0002 says Evidence is factual and never model-authored. Until M5 that rule
was easy to keep, because it was enforced structurally: AI output lives in the
enrichment table and is physically incapable of occupying an Evidence row.

The AI Coding Session collector breaks that comfort. Its source is a transcript
of a conversation with a model, so **model-written text is inside the source
artifact**. Reading a field from the source is no longer sufficient evidence
that a human wrote it. Three cases appeared immediately, and all three are the
same mistake:

1. **`ai-title`** — a model-generated session title. Present on 7% of sessions
   and genuinely tidier than the raw prompt. Importing it would put model prose
   into `title`.

2. **`isCompactSummary`** — when a session is resumed, the first record is a
   `user` record whose content is *a model's summary of the previous
   conversation*. Nothing else marks it. Read naively it becomes the title and
   excerpt of the Evidence. Over 90% of transcripts are resumes or forks, so
   this is the common path.

3. **`promptSource: sdk`** — **1,110 of 1,198 collected sessions (93%)** were
   driven by an automation harness rather than typed by a person. Their
   "prompts" were composed by a program. Presented as an excerpt, they read as
   the user's problem statement; the timeline filled with 1,110 copies of
   *"Analyze this conversation and determine: does the assistant have more
   autonomous work to do RIGHT NOW?"*

None of these are model output CareerForge produced. All of them are text
CareerForge did not write and did not have to invent — which is exactly why
`imported` felt sufficient and was not.

The harm is specific. `excerpt` feeds claim generation, and an `action` claim
needs only evidence to be supported (ADR-0007). Machine-written text in
`excerpt` is therefore a direct path from a bot's prompt to a resume bullet
attributed to a person.

## Decision

**ADR-0002 asks who *wrote* the text, not where it was *read from*.**

A collector must not place text into a human-authorship field unless a person
authored it. Concretely, for Evidence:

| Field | Claim it makes | Rule |
|---|---|---|
| `title` | what this artifact is | may be derived from facts about the artifact |
| `excerpt` | words from the source | **must be human-authored, or null** |
| `summary` | a summary written at the source | must be source-authored and not model-written |

The session collector therefore:

- **Never imports `ai-title`.** The title comes from the person's own opening
  prompt.
- **Never treats a compact summary as a prompt.** `isCompactSummary` and
  `isVisibleInTranscriptOnly` records are excluded, as tool results and `isMeta`
  records already were.
- **Collects programmatic sessions, but does not quote them.** Where no human
  prompt exists, `excerpt` is `null` and `title` is a derived description —
  `Programmatic session in acme-api` — which describes the artifact instead of
  quoting a machine. The tools used, files touched, and commands run are all
  still recorded, because those are facts regardless of who asked.
- **Records authorship as data.** `promptAuthorship` is `human` or
  `programmatic`, alongside `humanPrompts` and `programmaticPrompts`, so
  downstream layers can filter on it rather than guess.

A derived title is not a violation. It is computed mechanically from facts, the
same way the Git collector computes `isMerge` — no model, no interpretation, no
claim beyond what the artifact shows.

## Consequences

**Good**

- The most valuable field in the product — a problem statement in the user's
  own words — means what it says.
- Programmatic sessions are preserved rather than dropped. This matters more
  than it looks: Claude Code deletes transcripts after 30 days by default, so
  anything not collected is gone permanently, not merely deferred.
- The rule generalises. Every future AI-adjacent source (Cursor, Copilot,
  Codex, a ChatGPT export) has the same shape, and the answer is now written
  down rather than re-litigated per collector.

**Costs**

- 93% of session evidence carries a derived title and no excerpt. The timeline
  is honest but repetitive until M6 groups it.
- `promptAuthorship` is a required attribute, so a future adapter for a tool
  without a comparable signal must decide what to report rather than omit it.
  That is intended: the question should be answered, not skipped.

## Alternatives considered

**Import `ai-title` because the source recorded it.** Rejected. "The source
wrote it down" is precisely the reasoning this ADR exists to reject, and
`ai-title` is the clearest case: a model wrote it, in a file, minutes ago.

**Skip programmatic sessions entirely.** Seriously considered — it would cut
1,198 records to 85, and those 85 are the ones a person actually drove. Rejected
because of the 30-day retention window: skipping is not deferral, it is
permanent loss of real work (files, commits, tools) whose only defect is that
nobody typed the prompt. Emitting them honestly costs nothing and keeps the
option open.

**Emit programmatic sessions with the machine prompt as the excerpt, and let
the UI filter on `promptAuthorship`.** Rejected. It makes correctness depend on
every downstream consumer remembering to filter, and the store's own guarantee
is that a field means what it claims.

**Mark them `derived` rather than `imported`.** Rejected. The evidence class
describes how the record was obtained — this one was read from a source, so it
is imported. Overloading the class to also mean "the title was templated" would
make the class answer two questions and neither clearly.

## Revisit if

- A source appears where machine-written and human-written text genuinely
  cannot be distinguished. The rule would then need a third authorship value —
  `unknown` — rather than a guess in either direction.
- M6 finds that programmatic sessions never contribute to a Work Unit worth
  showing. Their evidence class or kind may then deserve to differ from a
  human-driven session's, rather than being distinguished only by an attribute.
- Claim generation grows a rule that reads `excerpt` for any claim type where
  human authorship is not already required. The asymmetry in ADR-0007 assumed
  excerpts are the user's words; this ADR is what keeps that assumption true.
