# ADR-0005 — AI is additive, never load-bearing

**Status:** Accepted · 2026-07-30
**Relates to:** `Vision.md` §2.3, §7 · `Architecture.md` §1.1, §7
**Depends on:** ADR-0002

## Context

CareerForge is an AI-powered platform whose most valuable asset is a decade of a user's professional history. Three pressures push against making AI foundational:

- **Privacy.** Enrichment is the only path by which work product leaves the machine. If AI is required, egress is required.
- **Cost.** Continuous enrichment of every collected artifact is financially unbounded; one measured source alone produces ~4 GB/year.
- **Durability.** Models, providers, prices, and terms change constantly. A store that cannot be read without a specific provider is hostage to that provider.

An architecture where AI is merely *intended* to be optional drifts into requiring it — one convenience call at a time, each individually reasonable.

## Decision

**AI is a separate, deferred, additive pipeline that no other layer may depend on. This is enforced by the dependency graph, not by intent.**

1. **Structural.** The domain layer imports no AI SDK and no HTTP client. Invariant I1 is a CI-enforced import-boundary lint rule. Enrichment depends on domain; **domain cannot depend on enrichment**, so "AI is optional" is a property of the build, not a promise.
2. **Collectors never call AI** (invariant I6). Their sole responsibility is normalizing a source into Evidence.
3. **Deferred batch, not eager.** Collection writes raw Evidence immediately and cheaply. Enrichment runs separately — on demand, on a schedule, or before generation.
4. **Fully functional without a key.** Collection, storage, search (FTS5), timeline, analytics over derived metrics, and export all work with no key and no network.
5. **Enrichments are additive and versioned** (ADR-0002). Re-running produces new rows; prior rows are superseded but remain queryable forever.
6. **Runs are reproducible.** `prompt_hash`, `params_hash`, `input_hash`, `model`, and `policy_decision_id` are recorded, so any output is re-derivable and auditable years later — including output from a model that no longer exists.
7. **The provider port is narrow.** It accepts a rendered prompt and a response schema and returns structured output. It knows nothing of Evidence, careers, or provenance. That narrowness is why local models are a first-class path rather than a degraded one.

## Consequences

**Gains**

- The privacy promise is architecturally supported: there is a code path — the default one — where nothing ever leaves.
- Contributors can build and test collectors, storage, and search with no API key. This meaningfully lowers the contribution barrier.
- Provider churn is contained to one adapter.
- `input_hash` gives free caching and honest staleness detection when Evidence is superseded.

**Accepted costs**

- Enrichment lag: freshly collected evidence is unenriched until a run happens. Acceptable — career assets are not real-time.
- Two-phase mental model for users and contributors.
- Some cross-layer conveniences are forbidden. This is the point.
- Analytics over *enriched* attributes require a key; analytics over *derived* metrics do not. This boundary must be visible in the UI or it will read as a bug.

## Alternatives considered

**Eager enrichment at ingest.** Always-fresh, simplest mental model. Rejected: continuous unbounded token spend, requires a key to be useful at all, and every collector inherits a dependency on the AI layer — the exact coupling this ADR exists to prevent.

**Lazy enrichment at generation time only.** Zero cost until use. Rejected: generation becomes slow and expensive precisely when the user is waiting, and analytics over unenriched evidence are impossible.

**AI-optional by convention, enforced in review.** Less machinery. Rejected: conventions erode. A single merged PR importing an AI client into domain permanently breaks a headline promise, and nobody notices until a user without a key files the bug.

## Revisit if

- Deferred enrichment measurably damages the first-run experience (the correct fix is a fast first pass, never eager coupling).
- Local models become good and cheap enough that the local/remote distinction stops mattering — even then, additivity holds.
