# ADR-0006 — Work Units are the unit of accomplishment

**Status:** Accepted · 2026-07-30
**Relates to:** `Architecture.md` §3 · `docs/PreArchitecture-Findings.md` §1.4

## Context

Empirical measurement of 1,219 real AI coding sessions produced a decisive finding:

```
p50 session duration: 0.4 min      >5 min:   94 sessions (7.7%)
p99 session duration: 460 min      >2 hours: 40 sessions (3.3%)
```

**Over 90% of session files are sub-minute fragments** — resumes, forks, one-shot invocations, aborted starts. Git has the same shape from the other direction: a feature is forty commits, not one.

If one source artifact produced one asset-worthy record, CareerForge would generate thousands of meaningless entries and bury the ~8% that represent real work. The naive assumption — artifact equals accomplishment — is false in both directions.

Humans do not describe accomplishments at artifact granularity. Nobody says "I made commit `a3f9c2`."

## Decision

**A Work Unit is a cohesive unit of work spanning multiple Evidence records. It is the level at which assets are generated.**

1. **Membership is many-to-many** via an append-only join table carrying `role` (`primary`/`supporting`/`incidental`), `assigned_by` (`strategy`/`user`), and `confidence`. One commit can support two accomplishments; forcing exclusivity would require choosing which career story an artifact belongs to before anyone knows what the stories are.
2. **Grouping is a core responsibility, not a collector's.** Collectors emit a `grouping_hint`; the core groups. Two consequences: improving a strategy retroactively improves a decade of history, and plugin authors do not each invent their own clustering.
3. **Strategies are versioned and deterministic** (`context-temporal@1`). Same evidence plus same strategy version yields identical grouping on any machine — which is what lets sync converge without a coordinator (ADR-0004).
4. **`pinned` protects human decisions.** Once a user edits membership, re-running a strategy never touches that unit.
5. **Merge and split are append-only.** Merging emits a new unit superseding both originals; splitting emits two superseding one.
6. **Sensitivity is the maximum over members**, computed, never stored independently.
7. **A substance threshold gates admission** — duration, distinct artifacts, or presence of a commit. Thresholds are configuration, not constants, because they will be wrong at first.

## Consequences

**Gains**

- Assets are generated at the granularity humans actually describe work.
- The 92% noise floor is filtered structurally rather than by prompt engineering.
- Grouping quality improves for all history when the strategy improves.
- Sensible boundaries for enrichment input, which is what keeps token cost bounded.

**Accepted costs**

- An additional concept contributors must learn.
- Grouping quality is now a product-quality dimension of its own, with its own failure modes.
- Bad automatic grouping is *visible* to users in a way missing evidence is not — arguably a feature.
- `pinned` means the store carries permanently divergent hand-curated and machine-derived regions. Necessary: without it, improving the algorithm silently destroys curation, which is the fastest way to lose the trust of someone holding a decade of history here.

## Alternatives considered

**One Evidence = one asset candidate.** Simplest. Rejected by measurement: 92% of candidates would be noise.

**Collectors emit Work Units directly.** Collectors have the most source context. Rejected: every plugin author reinvents clustering, quality varies wildly, cross-source grouping (a commit *and* the session that produced it) becomes impossible, and improvements cannot be applied retroactively.

**AI-based grouping.** Likely higher quality. Rejected for the core path: it would make a foundational structure depend on AI, violating ADR-0005. Permitted later strictly as an *optional* strategy producing the same deterministic record shape.

**Exclusive one-to-many membership.** Simpler queries and a simpler UI. Rejected: real work genuinely supports multiple accomplishments.

## Revisit if

- `context-temporal@1` proves unusable after tuning against real data.
- Users pin so aggressively that automatic grouping is effectively unused — that is a signal the strategy is wrong, not that the concept is.
- A source arrives where `grouping_hint` cannot be produced meaningfully.
