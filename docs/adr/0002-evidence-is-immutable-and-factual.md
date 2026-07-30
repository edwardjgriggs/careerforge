# ADR-0002 — Evidence is immutable and factual

**Status:** Accepted · 2026-07-30
**Relates to:** `Vision.md` §2.1, §7 · `Architecture.md` §2
**Builds on:** ADR-0001

## Context

CareerForge generates claims a person puts on a resume, states in interviews, and submits in promotion packets. The two catastrophic failure modes are inference drift ("led a cross-functional initiative" from three commits) and invented metrics ("reduced deployment time 40%" from nothing).

Both have the same root cause: **AI-generated text becoming indistinguishable from observed fact.** Once a model-written summary occupies the same field as a source-authored one, no downstream consumer can tell them apart, and every claim built on it inherits an unmarked fabrication.

ADR-0001 establishes *how* records change. This ADR establishes *what may enter an Evidence row at all*.

## Decision

**An Evidence row is one atomic, factual, historical assertion normalized from exactly one source artifact. AI output can never occupy one.**

1. `evidence_class` is constrained by `CHECK` to `imported`, `derived`, or `user_confirmed`. There is no AI value.
2. AI output lives in the `enrichments` table (ADR-0005). The separation is structural — a table boundary, not a column value a bug could set wrongly.
3. The `summary` field holds **source-authored** text only: a commit message body, a meeting description, a course abstract. Never a model.
4. Evidence carries `natural_key` (identity) and `content_hash` (change detection). Re-collecting unchanged content is a no-op; changed content emits a new row superseding the prior one.
5. A user's answer to an interview question is `user_confirmed` Evidence — a human asserting a fact, not a model inferring one — and is reusable across every future asset.

`Vision.md` §7 names four evidence types including `ai_enrichment`. Three are Evidence rows; the fourth is an Enrichment row. The **user-facing four-way distinction is preserved exactly** — Evidence Explorer labels all four — while the fact/interpretation boundary becomes physically unbreakable.

## Consequences

**Gains**

- "Show me only what actually happened" is `SELECT * FROM evidence_current` — no filtering, no trust in a flag.
- A bug in the enrichment pipeline cannot contaminate the factual record. The worst case is bad interpretation, never corrupted history.
- Idempotent re-collection, which makes backfill overlapping incremental runs safe.

**Accepted costs**

- Two tables and a join where one table would be simpler.
- Collectors must produce a normalized `title` without AI help. Titles are therefore sometimes mechanical (a commit subject line). Correct: a mechanical true title beats an eloquent invented one.
- Users may want to edit an evidence title for clarity. That writes a `user_confirmed` correction row, not an in-place edit.

## Alternatives considered

**One table with `evidence_class` including `ai_enrichment`.** Fewer joins, and it matches the vision's original wording literally. Rejected: the fact/interpretation boundary would be enforced by a string column, so a single incorrect insert silently promotes a hallucination to a fact. The most important boundary in the product cannot rest on a value.

**Let AI write `summary`, flagged with `summary_is_ai`.** Better generated text immediately. Rejected: flags are lost on copy, join, and export. Every product that has tried marking AI text in-band has watched the marking separate from the text.

**Allow in-place edits to Evidence.** Simplest UX. Rejected by ADR-0001, and separately here: an evidence store a user can rewrite is not evidence.

## Revisit if

- Users consistently find mechanical titles unusable — the fix is better collector normalization, never AI.
- A source arrives where "one artifact" is genuinely ambiguous and the atomicity rule produces nonsense.
