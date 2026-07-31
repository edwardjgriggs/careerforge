# CareerForge — Implementation Plan (Proof of Thesis)

**Status:** Ready to execute
**Date:** 2026-07-30
**Scope:** `Vision.md` §11 Proof of Thesis only
**Governed by:** `Architecture.md` (frozen) · `docs/adr/` (extensible)

---

## Working agreement

1. **One milestone at a time.** Each ends with the project building, tests passing, and the CLI runnable.
2. **Never broken between milestones.** Any commit on the default branch can be checked out, installed, and run.
3. **Acceptance criteria are binary.** Each is demonstrable by a command or a passing test. No criterion is a judgment call.
4. **Vision and Architecture are frozen.** A change to either requires an ADR. Discovering that architecture is wrong is a *success* of this process — record it, do not quietly deviate.
5. **Tests are written with the milestone**, not after. Invariants get tests before the code they constrain.
6. **No milestone is "done" until its invariants are enforced in CI**, not merely respected.

### Complexity scale

| | Meaning |
|---|---|
| **S** | One focused session |
| **M** | Two to three sessions |
| **L** | A week of evenings; contains real unknowns |
| **XL** | Should have been split; justified explicitly if used |

### Deviation from the suggested milestone list

The original list placed the OpenAI provider immediately after the provenance graph. **The Policy Engine (M8) must land before any provider**, because invariant I3 requires every outbound call to pass through it. Building a provider first would mean writing an egress path with no enforcement and retrofitting the choke point afterward — precisely the sequence that leaves privacy promises unenforced. One milestone added; nothing else reordered.

---

## Dependency graph

```
M0 bootstrap
 └─ M1 domain
     └─ M2 store
         └─ M3 evidence persistence + export/rebuild
             ├─ M4 collector host + Git          ──┐
             │   └─ M5 AI session collector        │
             │       └─ M6 work unit grouping  ────┤
             └─ M7 provenance graph  ──────────────┤
                                                   ▼
                                          M8 policy engine
                                                   │
                                          M9 OpenAI provider
                                                   │
                                          M10 resume bullet generation
                                                   │
                                          M11 Evidence Explorer
                                                   │
                                          M12 CLI polish + release
```

**First user-visible value: M4.** `careerforge collect` produces real evidence from real repositories. Everything before it is scaffolding, and it is worth reaching M4 quickly.

---

## M0 — Repository bootstrap

**Complexity: M** · **Depends on: nothing**

### Goal
A repository a stranger can clone, install, build, and test in under five minutes — with the architectural invariants enforced from the first commit rather than retrofitted.

### Deliverables
- Own Git repository, with clean history (`Vision.md` §15.3).
- TypeScript monorepo per `Architecture.md` §11: `domain`, `store`, `policy`, `collect`, `enrich`, `generate`, `protocol`, `cli`, `ui`.
- Build, test, lint, format, typecheck. Strict TypeScript.
- **Import-boundary lint rule** enforcing invariant I1 (`domain` imports no adapter, no HTTP, no AI SDK) and I3 (`policy` is the only package permitted an HTTP client).
- CI on Linux, macOS, Windows.
- `careerforge --version` and `careerforge doctor` (environment checks only).
- `LICENSE` (Apache 2.0), `NOTICE`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `TRADEMARK.md`.
- `docs/adr/` moved in; `Vision.md`, `Architecture.md`, `docs/PreArchitecture-Findings.md` moved in.

### Acceptance criteria
- [ ] `git clone && npm install && npm test` succeeds on a clean machine.
- [ ] `npx careerforge doctor` reports Node version, platform, and config path.
- [ ] CI green on all three platforms.
- [ ] A PR importing `node:http` into `domain` **fails CI**.
- [ ] A PR importing an HTTP client outside `policy` **fails CI**.
- [ ] `SECURITY.md` states a private disclosure path.

### Tests
- Boundary-lint tests: fixture PRs that must fail (negative tests for I1 and I3).
- Smoke test: CLI entry point runs and exits 0.

### Notes
Windows is the primary development platform and the least-tested target in most OSS. **Windows CI from commit one**, not added later.

---

## M1 — Domain models

**Complexity: M** · **Depends on: M0**

### Goal
The vocabulary of the system as pure, I/O-free, AI-free types with their invariants expressed as testable functions.

### Deliverables
- `Evidence`, `WorkUnit`, `WorkUnitMember`, `Enrichment`, `Claim`, `Gap`, `Asset`, `ProvenanceEdge`, `Tombstone`, `Identity`.
- Enums: `EvidenceClass`, `Sensitivity`, `ClaimType`, `GapType`, `Relation`, `TombstoneScope`.
- ULID generation.
- `natural_key` and `content_hash` derivation — pure, deterministic.
- Sensitivity ordering and `max()` over a set.
- **Claim support rules** (`Architecture.md` §5.2) as a pure predicate: given a claim type and a support set, is it satisfied?
- `AttributeSpec` validation: scalars, dates, string arrays only — nested objects rejected.

### Acceptance criteria
- [ ] `domain` has zero runtime dependencies beyond a ULID implementation.
- [ ] `natural_key` is stable across processes and platforms for identical input.
- [ ] `content_hash` is order-independent for semantically identical payloads.
- [ ] Claim support predicate rejects a `role` claim supported only by `imported` evidence.
- [ ] Claim support predicate rejects a `metric` claim supported only by an enrichment.
- [ ] Nested-object attributes are rejected with a clear error.

### Tests
- Property test: `natural_key` determinism across 1,000 generated inputs.
- Table-driven tests for every claim type × support combination, including the two career-ending cases from ADR-0007.
- Sensitivity `max()` over all subsets.
- Snapshot test on the domain package's dependency list — a new dependency requires a deliberate update.

### Notes
The claim support predicate is the mechanical form of "AI may not assert what isn't there." It is tested here, in a pure function, long before any AI exists.

---

## M2 — SQLite store

**Complexity: L** · **Depends on: M1**

### Goal
A migratable, append-only database where mutation is impossible by construction.

### Deliverables
- SQLite adapter with WAL.
- Migration runner: forward-only, numbered, transactional, `PRAGMA user_version`, automatic pre-migration backup, refusal to open a newer schema.
- Migration `0001`: all tables from `Architecture.md` §4.2.
- **Triggers rejecting `UPDATE` and `DELETE`** on every domain table (invariant I2).
- `*_current` views excluding superseded and tombstoned rows.
- FTS5 tables plus `careerforge reindex`.
- `careerforge doctor` extended: schema version, integrity check, table counts.

### Acceptance criteria
- [ ] `careerforge init` creates a database at the configured path.
- [ ] `UPDATE evidence SET title='x'` **raises**, from SQL and from application code.
- [ ] `DELETE FROM evidence` **raises**.
- [ ] Opening a database with a higher `user_version` fails with an actionable message.
- [ ] A migration that throws leaves the database byte-identical to before.
- [ ] A backup file exists in `backups/` after any migration.
- [ ] `careerforge reindex` rebuilds FTS5 from base tables.

### Tests
- Trigger tests: every table rejects `UPDATE` and `DELETE`.
- Migration failure test: inject a throwing migration; assert full rollback and intact backup.
- Version-guard test: hand-set `user_version` higher; assert refusal.
- Round-trip: write → read through `*_current` views.
- **Fixture-migration harness** — the mechanism that will run for every future migration, built now with `0001` as its first case.

### Notes
The fixture-migration harness is the highest-leverage artifact in this milestone. Every future migration inherits it, and `Vision.md` §14's promise depends on it existing before it is needed.

---

## M3 — Evidence persistence, export, and rebuild

**Complexity: L** · **Depends on: M2**

### Goal
Evidence can be stored, corrected, tombstoned, exported, and fully reconstructed — with round-trip fidelity proven in CI.

### Deliverables
- `StorePort`: `emit`, `query`, `supersede`, `tombstone`.
- Idempotent emit via `UNIQUE (natural_key, content_hash)`.
- Change detection: differing `content_hash` emits a superseding row.
- `careerforge export` — JSON tree per `Architecture.md` §4.5, sorted keys, year/month partitioning, `manifest.json`.
- `careerforge rebuild` — reconstruct the database from `export/`.
- Blob store: content-addressed `put`/`get`, outside the database.
- `careerforge search <query>` over FTS5.
- `careerforge timeline [--from --to]`.

### Acceptance criteria
- [ ] Emitting identical evidence twice produces exactly one row.
- [ ] Emitting changed content produces two rows; `evidence_current` returns one.
- [ ] A tombstoned record is absent from `evidence_current`, `search`, `timeline`, and `export`.
- [ ] **`export` → `rebuild` → `export` produces byte-identical output** (invariant I5).
- [ ] Export is idempotent: re-running without changes rewrites nothing.
- [ ] `search` and `timeline` work with **no API key and no network**.
- [ ] `scope='purged'` removes payload bytes while retaining the tombstone.

### Tests
- **Round-trip property test with 10,000 synthetic records** — the I5 CI gate.
- Idempotency: 100 repeated emits → 1 row.
- Tombstone leak test: assert absence across *every* read path, including export. Add a new read path, add it here.
- Blob dedup: identical content stored twice → one blob.
- Export determinism: two runs → identical bytes.

### Notes
The tombstone leak test grows with the codebase. It is the guard against a suppressed record eventually surfacing in an exported resume.

---

## M4 — Collector host and Git collector

**Complexity: L** · **Depends on: M3**

### Goal
**First real value.** Point CareerForge at real repositories and get real, provenanced evidence.

### Deliverables
- `CollectorPort` per `Architecture.md` §6.1. In-process host only; out-of-process deferred.
- Cursor persistence per `(collector_id, scope)`.
- `CollectionReport`: seen, emitted, skipped by reason, unknown types.
- **Collector conformance suite** (`Architecture.md` §6.4) — shared, run against every collector.
- Git collector: `kind: git.commit`; attributes repo, sha, branch, files changed, insertions, deletions, coauthors, merge flag; `grouping_hint` = repo + branch + ISO week; `default_sensitivity: confidential`.
- `careerforge collect [--collector git] [--scope <path>]`.

### Acceptance criteria
- [ ] `careerforge collect --collector git --scope <repo>` emits evidence from real history.
- [ ] Full backfill of a 1,000-commit repository completes and is idempotent on re-run.
- [ ] Interrupting mid-collection and resuming produces no gaps and no duplicates.
- [ ] A repository with merge commits, coauthors, and non-UTF-8 messages does not throw.
- [ ] The Git collector passes all seven conformance tests.
- [ ] `careerforge timeline` displays collected commits.
- [ ] Collectors hold no store handle (invariant I6) — enforced by type.

### Tests
- Conformance suite: idempotency, backfill/incremental agreement, interruption safety, tolerance, purity, determinism, manifest honesty.
- Git fixtures: empty repo, single commit, merges, coauthors, non-UTF-8, detached HEAD, submodules.
- Interruption: kill at N%, resume, compare against uninterrupted run.

### Notes
The conformance suite matters more than the Git collector. It is the contract every future collector — including third-party ones — is held to, and it is what lets a contributor write a collector without reading the rest of the codebase.

---

## M5 — AI Coding Session collector

**Complexity: L** · **Depends on: M4**

### Goal
Collect the differentiating source, under the three mandatory constraints from `docs/PreArchitecture-Findings.md`.

### Deliverables
- AI Coding Session collector, Claude Code adapter.
- `required_fields`: `type`, `timestamp`, `sessionId`, `cwd`, `message.content`. Everything else optional (ADR-0010).
- `kind: session.fragment`; one Evidence per file. **No grouping decisions** — that is M6.
- Extraction: opening user prompt verbatim, tool sequence, file paths touched, git commands observed, skill/tool attribution.
- `default_sensitivity: restricted`.
- Excerpts and hashes only; raw transcripts referenced, never copied.
- `grouping_hint` = `cwd` + `gitBranch` + temporal bucket.

### Acceptance criteria
- [x] Collects from a real `~/.claude/projects` tree without throwing. *(1,214 transcripts, 1,198 emitted, 3.5 s)*
- [x] Unknown record types are skipped silently and counted in the `CollectionReport`. *(via the `drift` channel — ADR-0016)*
- [x] Truncated final lines, invalid JSON lines, and unknown `version` values do not fail the run.
- [x] All emitted evidence defaults to `restricted`.
- [x] Raw transcript bytes are **never** copied into the database or `export/`. *(asserted against a planted credential)*
- [x] Passes the conformance suite. *(eight checks as of M4, not seven)*
- [x] A 32 MB session file is processed with bounded memory (streaming, not full read).

### Tests
- Fixtures for every observed record type, plus three synthetic unknown types.
- Corruption: truncated file, invalid JSON mid-file, empty file, zero-record file.
- Version tolerance: fixtures spanning the observed 12+ versions plus a fabricated future version.
- Memory ceiling test against a large synthetic file.
- Assert no raw payload in DB or export.

### Notes
Measured: 1,219 files, 328 MB, 30 days, **0 parse failures**. Streaming is mandatory — the largest observed file is 32 MB, and a naive `readFileSync` over a full corpus is a memory failure waiting for a heavy user.

Subagent transcripts are absent from these files (`isSidechain` true on 0 of 57,206 records). Investigating `~/.claude/tasks/` is **out of scope** here; logged as open item.

### What implementation found

Three things the survey could not have known, each of which changed the design:

1. **Claude Code deletes transcripts after 30 days by default** (`cleanupPeriodDays`, unset). The corpus boundary is exactly 30.0 days. Evidence therefore points at a file that will not exist next month, which is why the transcript hash is stored and why nothing is dropped on the assumption that it can be re-collected later.
2. **93% of transcripts were driven by a program, not typed** (`promptSource: sdk`, 1,110 of 1,198). Their prompts read as problem statements and are not. See ADR-0017.
3. **A resumed session opens with a model-written summary filed as a `user` record** (`isCompactSummary`). Read naively it becomes the title of the evidence. Found by the drift channel on the first real run, not by fixtures.

Two ADRs came out of this milestone: **ADR-0016** (drift is reported, not just tolerated) and **ADR-0017** (source-authored is not human-authored).

### Carried forward to M6

- Programmatic sessions are collected with a derived title and no excerpt. Whether they belong in a Work Unit at all, or deserve a distinct kind, is a grouping decision.
- 16 transcripts contained no prompt of any kind and were skipped. Expected; recorded here so the number is known rather than assumed.

---

## M6 — Work Unit grouping

**Complexity: M** · **Depends on: M5**

### Goal
Turn a stream of artifacts into units of work a human would recognize as accomplishments.

### Deliverables
- `context-temporal@1`: group by `project_key` + `stream` within a bounded idle gap.
- Substance threshold: duration, distinct artifacts, or presence of a commit. **Configuration, not constants.**
- Append-only membership with `role`, `assigned_by`, `confidence`.
- `pinned` semantics: re-running never modifies a user-edited unit.
- Merge and split as append-only supersede operations.
- Sensitivity computed as `max()` over members.
- `careerforge group [--strategy context-temporal@1] [--dry-run]`.
- `careerforge units [--project <key>]`.

### Acceptance criteria
- [x] Grouping over real collected data produces a plausible unit count — **not ~1,200**. *(74 units from 1,204 records)*
- [x] Sub-minute fragments below threshold are excluded.
- [x] Re-running is deterministic: identical evidence + strategy → identical units.
- [x] Re-running never modifies a `pinned` unit — nor recreates what a merge removed (ADR-0018).
- [x] A unit containing one `restricted` member is `restricted`.
- [x] Merge produces one unit superseding two; split produces two superseding one; both are reversible via supersede history.
- [x] `--dry-run` shows the outcome without writing.

### Tests
- Determinism: group twice, compare.
- Pinning: pin, re-run with changed thresholds, assert untouched.
- Threshold sweep against real data, asserting the noise floor is excluded.
- Cross-source grouping: a commit and the session that produced it land in one unit.
- Sensitivity propagation.

### Notes
Thresholds will be wrong initially. `--dry-run` plus configuration-not-constants is what makes tuning cheap. This is the milestone most likely to need a second pass after seeing real output — expect it, and do not treat it as failure.

### What implementation found

The labelled corpus in `eval/grouping` was built **before** any tuning (ADR-0019), and it earned its place immediately. Five defects, three found by the corpus and two by running against a real store:

1. **Interleaved branches produced four units for two accomplishments.** A single rolling group made every branch switch a new unit. Fixed by keeping several groups open at once.
2. **A feature spanning three days split into three.** Fixed by separating gap tolerance for a shared named stream from bare proximity.
3. **A day of aborted starts was admitted as an accomplishment**, because merging noise created apparent substance. Fixed by replacing elapsed duration with *active* duration in `SubstanceSignals` — five twenty-second fragments span ten hours and contain under two minutes of work.
4. **Proximity chained a month of work into one unit of 839 artifacts.** Proximity is transitive: a tolerance wide enough to bridge one night bridges every night. Fixed by shortening the bare-proximity gap to 6 hours.
5. **A trunk branch was mistaken for a statement of intent.** `main`, `master` and a detached `HEAD` are where work lands when nobody said anything. Fixed with a configurable `trunkStreams` list.

Every default in `DEFAULT_GROUPING_CONFIG` now has a labelled case behind it.

Two ADRs: **ADR-0018** (curation is protected by evidence, not by grouping key — merging two units otherwise let the next run recreate them) and **ADR-0019** (grouping quality is measured).

### Carried forward

- **No source-based Work Unit types.** A unit is a coherent piece of work regardless of which collector saw the evidence, and the corpus asserts it (`programmatic-and-human-together`). If data later shows programmatic sessions need different treatment, that is an ADR, not an assumption.
- The largest real unit is 136 programmatic sessions across two days. Bounded and honest, but a candidate for a future labelled case if it proves wrong.
- Unit titles are the earliest human prompt in the unit, which is sometimes as thin as "Yep". Better titles are enrichment's job (M9+), not a strategy's — a strategy picks, it does not compose.

---

## M7 — Provenance graph

**Complexity: M** · **Depends on: M3** *(parallel with M4–M6)*

### Goal
The graph that makes Evidence Explorer possible and makes unsupported claims impossible.

### Deliverables
- `provenance_edges` with typed relations, append-only.
- `claims` with `claim_type`, `span`, `support_state`, `metric_source`.
- `gaps` with `gap_type`, `question`, `status`, `asked_count`, `answered_by`.
- **Claim support enforcement** wired to the M1 predicate (invariant I4).
- Bounded reverse traversal: claim → support set, resolved to display records labelled by class.
- Gap deduplication against existing `user_confirmed` evidence.
- Manual Interview collector: consumes open gaps, writes `user_confirmed` evidence plus an `answers` edge.
- `careerforge interview [--unit <id>]`.
- `careerforge explain <claim-id>`.

### Acceptance criteria
- [x] A claim with zero `supports` edges **cannot be persisted** — hard failure, not a warning.
- [x] A `role` claim supported only by `imported` evidence is rejected.
- [x] A `metric` claim supported only by an enrichment is rejected — and the graph cannot express the edge at all (ADR-0020).
- [x] `careerforge explain <claim>` returns the full support set with class labels in bounded time.
- [x] Answering a gap creates `user_confirmed` evidence reusable by other units.
- [x] A `declined` gap is never re-raised for the same unit.
- [x] An answered question is never asked again.

### Tests
- Negative tests for every rejected claim/support combination.
- Traversal depth bound: assert no unbounded walk on a UI path.
- Gap dedup: pre-seed an answer, assert the gap is not raised.
- Decline persistence across runs.
- Answer reuse across two units.

### Notes
Depends only on M3, so it can proceed in parallel with the collector track. Interview works without any AI — gaps are emitted by rule, not by model. Worth confirming that independence explicitly here, because it is easy to lose later.

### What implementation found

The milestone was scoped as traversal and turned out to be about **presentation**, which is where the guarantee actually lives.

1. **Traversal alone is not a proof.** A single list of linked records lets a model's reading sit beside a commit looking like the same kind of thing. Explanations now have two sections — `grounds` and `interpretation` — and section membership is decided by what a node *is*, not by which edge reached it. See ADR-0020.
2. **The graph could express what the predicate forbade.** `evaluateSupport` rejects interpretation-*only* support but permits a mixed set, so an enrichment could have entered `grounds` beside real evidence. `isWellFormed` and a `CHECK` constraint now both refuse a `supports` edge from an enrichment.
3. **A stored verdict goes stale.** Hiding the only supporting evidence left the claim reading `SUPPORTED`. The verdict is now recomputed from the graph on every explain, and suppressed records are counted as `withheld` rather than silently dropped.
4. **Membership was invisible to the graph.** Work units held members in `work_unit_members` and nothing linked them, so a proof could not reach source evidence through a unit. `grouped_into` edges are derived by join rather than written twice (ADR-0013).

**The interview is not a `CollectorPort`** (ADR-0021), despite the wording above. Nothing to discover, no cursor, and determinism is exactly wrong for asking a person a question — implementing the interface would have added a vacuous pass to the conformance suite and weakened it for every real collector.

### Carried forward

- Enrichment tables landed here rather than in M9, because testing "an enrichment may explain but never support" needs a real enrichment row. M9 adds the provider, not the schema.
- `corroborating` is recorded on the support edge, since only the party building the edge can know whether evidence carries a claim's asserted value. M10 is what will set it.

---

## M8 — Policy engine

**Complexity: L** · **Depends on: M6, M7**

### Goal
The egress choke point — built **before** anything can make a remote call.

### Deliverables
- `policy` package as the sole holder of an HTTP client (invariant I3, lint-enforced).
- Sensitivity resolution: `max()` over all inputs to a request.
- Consent store keyed on `(project_key, provider_id, max_sensitivity)`.
- Deterministic redaction: private keys, certificate blocks, cloud/vendor token formats, connection strings, `Authorization` headers, `.env` assignments, high-entropy strings in credential contexts, emails, paths containing usernames.
- Versioned redaction profiles (`default@1`).
- `RedactionReport` and **mandatory payload preview**.
- Append-only `PolicyDecision` records.
- `careerforge consent list|grant|revoke`.
- `careerforge preview --unit <id> --provider <id>`.

### Acceptance criteria
- [x] `restricted` evidence is refused to a non-local provider **by default**.
- [x] No global override exists — grants are per project.
- [x] Redaction removes every credential pattern in the fixture corpus (21 cases).
- [x] `careerforge preview` shows the exact bytes that would be transmitted — including when refused, because that is how consent is decided.
- [x] Every simulated egress writes a `PolicyDecision`.
- [x] A PR importing an HTTP client outside `policy` **fails CI**.
- [x] Revoking a grant immediately blocks subsequent requests.
- [x] Redaction is deterministic: same input + profile → same output.

### Tests
- Credential corpus: AWS/GCP/Azure keys, GitHub/Slack tokens, PEM blocks, JDBC/ODBC strings, `.env` files, bearer headers.
- **False-positive corpus**: ordinary code and prose that must survive unredacted.
- Consent matrix: every (sensitivity × provider-locality × grant-state) combination.
- Determinism across runs and platforms.
- Audit completeness: N simulated calls → N `PolicyDecision` rows.

### Notes
**This is the milestone that makes the privacy promise real.** It ships before any provider exists, so there is never a window in which egress is possible without enforcement.

The false-positive corpus matters as much as the credential corpus: redaction that destroys legitimate content makes enrichment useless and trains users to disable it.

### What implementation found

**The false-positive corpus earned its place immediately.** It caught the secret-assignment rule redacting `const accessToken = await auth.exchange(code)` — ordinary code that *mentions* a token rather than containing one. A name is not a secret; the rule now requires the value to look like a literal.

Two smaller ones: the idempotence self-check reported false residuals because `Authorization: [redacted]` still matches the authorization-header rule (the right property is that a second pass changes nothing, not that no rule fires), and a JSON `"client_secret": "..."` escaped because the pattern did not allow the closing quote before the colon.

**Every refusal now names its rule and its remedy** (ADR-0022), applied to claim support as well as policy — the principle is not specific to egress. `Remedy` is a closed union, so adding a refusal without deciding what a user could do about it is a compile error.

The engine is pure: consent arrives through an injected lookup and decisions are handed back to be persisted, so the whole consent matrix is tested with no database and no network anywhere near it.

### Carried forward

- Providers are declared but none can be called. The choke point ships first, so there is no release in which egress is possible without enforcement — M9 adds a provider behind it.
- An unknown provider is treated as **remote**. Guessing "local" would fail open, and this is the one place where failing open is unacceptable.
- The residual class — client names in prose, personnel discussion — is **not** solved and is stated plainly in `preview` output rather than implied away.

Residual risk — client names in prose, personnel discussion — is **not** solved here and must be stated plainly in user-facing copy (ADR-0009). Overstating redaction is worse than having none.

---

## M9 — OpenAI provider and enrichment

**Complexity: M** · **Depends on: M8** · **Status: complete**

### Goal
Optional, versioned, reproducible enrichment behind the policy gate.

### Deliverables
- [x] `ProviderPort`: rendered prompt + response schema → structured output. No knowledge of Evidence or careers.
- [x] OpenAI adapter.
- [x] `enrichment_runs` with `prompt_hash`, `params_hash`, `input_hash`, `model`, `policy_decision_id`, token usage.
- [x] Enrichment types: `skills`, `technologies`, `star_candidate`.
- [x] Versioned prompt templates (`skills@1`), frozen by a committed lockfile.
- [x] `input_hash` caching; staleness computed at read time from the evidence.
- [x] `careerforge enrich [--unit <id>] [--type <t>] [--dry-run]`, plus `careerforge interpretations` as the review surface.

### Acceptance criteria
- [x] Enrichment without a configured key fails with an actionable message — **and every other command still works**.
- [x] Every provider call passes through `policy`; bypass is impossible by construction.
- [x] Re-running with identical inputs makes **no** API call (cache hit).
- [x] Re-running after superseding an input produces a new enrichment; the prior remains queryable.
- [x] Enrichment **never** writes to `evidence` — asserted by lint, by manifest, and by test.
- [x] `--dry-run` shows the prompt and the redacted payload without calling.
- [x] A run recorded a year ago is fully reconstructible from its stored hashes.

### Tests
- [x] Recorded-fixture provider: full pipeline tested with **zero network access in CI**.
- [x] Cache: identical inputs → one call across ten runs.
- [x] Staleness: supersede an input, assert the dependent enrichment is flagged.
- [x] Isolation: assert no write to `evidence` from the enrichment path.
- [x] **Full-suite run with no API key configured** — everything except enrichment passes.

### Notes
CI must never require an API key. A recorded-fixture provider is the mechanism, and it also gives contributors a way to work on enrichment without spending money — which materially affects who can contribute.

### What implementation found

**The OpenAI adapter belongs in `policy`, not in `enrich`.** The obvious home for an OpenAI client is the package that wants to call OpenAI, and that arrangement has one fatal property: the caller assembles the request body, so the caller decides what goes on the wire and the policy engine becomes something you are expected to remember to consult. Putting the adapter behind the choke point inverts it. A `ProviderCall` carries a `PolicyDecision`, not a payload, and the body is assembled inside `policy` from `decision.payload`. There is no parameter through which unapproved bytes could be sent — bypass is not discouraged, it is unspellable.

**`model` and `resolved_model` had to be separate columns.** What was asked for and what answered are different facts. An alias like `gpt-5` advancing to a newer snapshot is one of the most common real causes of a changed interpretation, and it is completely invisible if only the request is recorded. `explainDifference` reports it as its own dimension, `model_build`, and the first hand-run against a real store produced exactly that output: *"You asked for llama3.1 both times, and the provider answered with llama3.1:8b-instruct-q4 then llama3.1:8b-instruct-q8. The model was upgraded underneath you."*

**Model nondeterminism needed to be a named answer.** When every recorded dimension matches and the output still differs, the cause is the model, and returning an empty difference list while the user looks at two different answers would teach them to stop trusting the record. `model_nondeterminism` says so.

**An enrichment run cannot be inserted as `running` and updated to `completed`** — the tables are append-only. That turned out to be the right shape rather than a limitation to work around: `policy_decisions` records that egress was *permitted*, written before the call; `enrichment_runs` records what *came back*, written after it. A crashed call leaves a decision with no run, which truthfully describes what happened instead of a row claiming a status nobody observed.

**Staleness is computed at read time, not stored.** A flag written at run time is wrong the moment somebody corrects a record, and silently wrong is worse than absent — a résumé built from a stale interpretation reads exactly like one built from a fresh one.

**The first run against a real store found a payload bug.** The session collector derives its title from the first prompt, so the naive `title + excerpt` sent the same sentence twice. It cost tokens on every call and, worse, repetition reads as emphasis to a model: the duplicated sentence would have been weighted above the work it described.

**Two ADRs came out of the milestone.** ADR-0023 makes a prompt a versioned artifact frozen by lockfile — editing a published template fails the build, because every run record naming it claims that text ran. ADR-0024 makes an interpretation cite its inputs or be discarded; the citations are checked against the payload the engine actually built, and an item citing a record that was never sent does not reach the store.

### Carried forward

- Templates exist for `skills`, `technologies`, and `star_candidate` only. `leadership` is deliberately unimplemented — shipping a weak prompt for the claim type most likely to end a career would be worse than shipping none.
- `star_candidate` carries a `resultBasis` flag distinguishing a result stated in the evidence from one the model inferred. Nothing consumes it yet; M10 must refuse to build a bullet on `not_evidenced`.
- Review state exists on every enrichment and is written by superseding, but there is no `careerforge review` command yet. The store method is there and tested.
- `CAREERFORGE_CASSETTE` swaps in the recorded provider. There is no recording mode yet — cassettes are hand-built or captured from a dry run.
- No live provider call has been made. Every path is verified against recorded fixtures and against a real store; the first real API call will be somebody's, not CI's.

---

## M10 — Resume bullet generation

**Complexity: L** · **Depends on: M9** · **Status: complete**

### Goal
The output that proves the thesis: an evidence-backed resume bullet whose every assertion is traceable.

### Deliverables
- [x] Generation pipeline: Work Unit → proposed claims → support resolution → gap emission → composition.
- [x] `assets` with `review_state`, a revision chain, `edited_by`, and a stored evidence assessment.
- [x] Claim decomposition into typed claims with spans — returned by the model, never parsed from prose.
- [x] Gap emission for unsupportable claims.
- [x] Review gate enforced **in the export path**, not the UI.
- [x] Style exemplar capture on user edit.
- [x] Claim-set comparison distinguishing a *wording* edit from a *factual* edit.
- [x] Markdown exporter, carrying the evidence grade with each bullet.
- [x] `careerforge generate resume-bullet --unit <id>`, `careerforge review <asset-id>`, `careerforge assets`.
- [x] **Evidence assessment** on every asset: a grade and named signals derived from the provenance graph.

### Acceptance criteria
- [x] Generating from a real Work Unit produces a bullet with ≥1 supported claim.
- [x] A bullet containing an unsupported `role` or `metric` claim **is not produced** — the claim becomes a gap instead.
- [x] Every claim resolves to ≥1 provenance edge (invariant I4).
- [x] Exporting a `draft` asset is **refused**. So is exporting a `rejected` one.
- [x] A user edit creates a new asset in the revision chain; the original remains.
- [x] An edit changing a claim (not wording) is refused and routed to the interview engine.
- [x] Answering an emitted gap and regenerating produces a measurably stronger bullet.
- [x] No generated asset modifies any evidence row.

### Tests
- [x] Golden-path: fixture unit → expected claim structure.
- [x] Fabrication resistance: 28 cases. Disabling the support gate fails 15 of them.
- [x] Metric resistance: no numeric claim without derived or confirmed support.
- [x] Review gate: every `review_state` against the export path.
- [x] Edit classification: wording edit vs factual edit.
- [x] End-to-end: gap → answer → regenerate → strengthened bullet, verified by hand against a real store.

### Notes
**The fabrication-resistance tests are the most important in the project.** They are the executable form of the promise the product is built on. If they pass, CareerForge does what it claims; if they are weak, nothing else matters.

### What implementation found

**The model must not return prose.** The obvious pipeline — generate a bullet, decompose it, check the claims, remove the failures — is wrong at both seams. Decomposing prose is guesswork, and every span it gets slightly wrong makes an explanation point at the wrong words; removing a claim from a finished sentence is surgery that ends in hedging, which is how "led the migration" becomes "helped lead the migration" and keeps the impression while discarding the accountability. So `resume_bullet@1` returns typed, cited assertions and the sentence is composed afterwards from the survivors (ADR-0025). A failed claim's words are never placed, so there is nothing to notice and strip out, and spans are exact by construction.

**Four claim rules were fine and one was wrong.** The `outcome` rule had accepted any evidence since M1, which meant a commit could support "eliminated the nightly memory alerts" — the change is not evidence of its consequence. It survived nine milestones because nothing generated an outcome claim; a predicate with no caller cannot be wrong in a way anybody notices. An outcome must now be observed, computed, or confirmed (ADR-0027).

**`isExportable` was a denylist over a set that had drifted.** The domain listed `draft | reviewed | exported`; the database permitted `draft | reviewed | rejected`. `!== 'draft'` was correct against the first and waved `rejected` straight through — an asset a person read and turned down was exportable. Invisible until an asset row existed to export. It is an allowlist now, and a test asserts the domain and the schema agree on the vocabulary.

**Reviewing an asset detached it from its own evidence.** Review writes a superseding row; the claims stay on the row they were recorded against. Reading support from the current row found nothing, so an accepted bullet exported as *"asserted — 0 records"* with its evidence one hop away. Claims resolve through the revision chain now — sound precisely because a factual edit is refused, so a chain always asserts the same things.

**The CLI classified every edit as a rewording.** It passed the existing claim texts back as the new ones, so `classifyEdit` compared a list to itself. The claim set after an edit is derived in the store now, by substring survival, and no caller can supply it.

**An answer did not reach its work unit until the next `group` run.** Found by hand-running the loop: answering the role question and regenerating produced the identical bullet. The user had done everything right and nothing changed, which is the worst possible response to somebody engaging with the interview. An answer settles a gap that names its work unit, so membership is known — it is attached at answer time.

**The assessment had to read through the base evidence table.** `evidence_current` already excludes tombstoned rows, so a withdrawal looked like a record that was never cited: the counts fell and nothing said why. The assessment's job is to *report* the withdrawal, so it has to be able to see it.

### Carried forward

- No shipped collector emits outcome-shaped evidence, so `outcome_not_evidenced` is true of essentially every asset and outcome claims are unreachable without an interview answer. That is the honest state of a coding-artifact corpus, and the strongest argument yet for a PR or issue collector.
- `THIN_EVIDENCE_BELOW` is an honest threshold nobody has measured. It should be derived from a corpus the way grouping's parameters were (ADR-0019).
- Composition is `a, b, and c` with no shaping. Deliberate, and the place users are most likely to push back.
- Style exemplars are captured but nothing consumes them yet; the generator does not receive them as few-shot examples.
- `careerforge generate` deliberately does not cache. A bullet depends on evidence, answers, and withdrawals that do not change the run fingerprint.

---

## M11 — Evidence Explorer

**Complexity: L** · **Depends on: M10** · **Status: complete**

### Goal
The screenshot that sells the project — a screen that answers *why does CareerForge believe this?* and *what evidence would make it stronger?*

### Deliverables
- [x] Local web UI served by the CLI (`careerforge ui`), reading the same stores the CLI does.
- [x] Bullet view with **claim spans marked and individually selectable**.
- [x] Click a claim → its support set, each item labelled by class — the four-way distinction from `Vision.md` §7 shown literally, in words rather than class names.
- [x] **Missing Information panel, interactive** — answering a question inline writes evidence and re-renders.
- [x] Sensitivity indicators on every evidence item.
- [x] **Strengthening paths**: each improvement carries the grade it would produce and the claim types it would unlock, ranked by what it would actually change.

### Acceptance criteria
- [x] `careerforge ui` opens a browser to a generated bullet.
- [x] Every claim is individually selectable and resolves to its support set.
- [x] Support items are visibly labelled by class.
- [x] Missing Information lists open questions and answering one updates the page without a restart.
- [x] The UI binds to localhost only — asserted against the listening socket *and* against the absence of any option to change it.
- [x] Everything on the screen functions **with no API key**.
- [x] Sensitivity is visible on every evidence item.

### Tests
- [x] Render tests for claim marking, class labelling, and grade presentation across all four grades.
- [x] Integration: question answered → evidence written → page reflects it.
- [x] Binding test: the listening address is loopback, and the source contains no host option.
- [x] Empty-state test: a fresh install renders a useful screen, not a blank one.

### Notes
The empty-state test is not cosmetic. `Vision.md` §4 makes backfill the acquisition model, and a sparse database must be **visibly full of answerable questions** rather than visibly empty. This is where cold start is won or lost.

### What implementation found

**"What would make this stronger?" needed to be a domain concept, not a UI list.** The naive version is a list of open questions, which is a to-do list: it says what is missing without saying what any of it is worth, so somebody looking at four questions cannot tell that answering one turns a bullet from unusable into publishable while answering another changes nothing they can see. Because `assessEvidence` is pure and total, the same function that grades the evidence now can grade it *as it would be* — so every improvement carries a computed effect, and the ranking is part of the answer.

**Answering a question does not improve the statement, and saying otherwise would be a lie.** The first version of the integration test asserted the grade rose from `observed` to `corroborated` after an interview answer. It does not, and it should not: the words on screen still rest on the records they were generated from. Answering strengthens the *evidence*; the *sentence* only improves when regenerated. The Explorer now says exactly that, at the top of the list — *"Regenerate — your answer is not in this statement yet"* — rather than showing an improved grade above unchanged text.

**The first real screenshot found two things tests could not.** The "regenerate" prompt fired on every asset with *"8 record(s) here are not used by this statement"*, because a bullet never cites every record in its unit — which is normal, and neither a problem nor news. It now triggers only on evidence recorded *after* the statement. And showing one claim's proof at a time left most of the answer to question one off screen and half the page empty; every proof renders now, with the selected one brought forward rather than revealed.

**Listening is not sending** (ADR-0028). `node:http` exports two unrelated capabilities that share a module: `createServer` accepts a connection and cannot originate one, `request` can. Only the second moves evidence off the machine, so only the second stays banned in `packages/ui`. The bind host is a constant rather than an option, because a flag that exposes a career database to a local network is a flag somebody eventually sets on advice from a forum post.

### Carried forward

- Timeline and search views are not in the Explorer; both work at the CLI. The two questions took the whole screen, and adding navigation would have made it the graph viewer this milestone set out not to build.
- Regeneration is a printed command rather than a button. Generating needs a provider and consent, and putting an egress-triggering button on a read-only page deserves its own thinking.
- The page reloads after an answer rather than patching. An answer changes the grade, the signals, and the ranking of every remaining improvement; patching one panel would leave the rest quietly stale, which on this screen means quietly wrong.
- No screenshot is committed. The Explorer is worth one in the README before release (M12).

---

## M12 — CLI polish and first release

**Complexity: M** · **Depends on: M11** · **Status: complete**

### Goal
A stranger completes the fifteen-minute Proof of Thesis experience without assistance.

### Deliverables
- [x] Complete command surface, with `tour` added as the way in.
- [x] `careerforge doctor` covering environment, schema, integrity, collectors, consent, provider configuration, and export freshness.
- [x] Consistent errors with actionable next steps, enforced by test rather than by review.
- [x] `README.md` with the four-command demo and a documentation index.
- [x] `docs/` — install, first run, the privacy model, writing a collector.
- [x] **Pre-1.0 release** (`0.1.0`), with the plugin protocol explicitly marked unstable.
- [x] Release workflow with checksums.
- [x] **A guided tour** that teaches why the system works the way it does, not which commands exist.

### Acceptance criteria
- [x] A clean machine reaches a generated bullet using only the README — and `careerforge tour` gets there with no API key at all.
- [x] The four-command demo works exactly as documented.
- [x] `careerforge doctor` diagnoses each of: no store, no collectors, no key, no consent, stale export, schema drift.
- [x] Every command has `--help` with a usage line and an example.
- [x] Every error names a next step; usage errors exit 2 and runtime failures exit 1.
- [x] README states plainly that the plugin protocol is unstable pre-1.0.

### Tests
- [x] **Fresh-machine end-to-end in CI** on all three platforms: the tour runs from a clean checkout with no credentials.
- [x] Doctor tests: each failure mode, asserting the diagnosis and its fix.
- [x] Help-coverage test over the whole command surface.
- [x] Tour tests: sandbox isolation, determinism across runs, and that each of the eight ideas is actually demonstrated.

### Notes
The fresh-machine CI test is what prevents "works on my machine" — the most common way an OSS project loses its first hundred users on a platform the maintainer does not run.

### What implementation found

**The tour had to run the shipped commands, not narrate a script.** Every step calls the same function the CLI calls, against a real store. A demonstration that cannot fail is a marketing asset; this one breaks when the product breaks, which is the only version worth shipping. It is now also the fresh-machine CI test on all three platforms — the most complete end-to-end coverage in the project, and it arrived as a side effect of writing the thing honestly.

**The recorded provider refused halfway through, correctly.** Step 5 regenerates after an interview answer, and the answer joins the work unit — so the payload changes and the recording no longer matches. That is the recorded provider declining to guess, exactly as designed (ADR-0024), and the fix was for the tour to have an answer ready for the payload as it now stands rather than to weaken the matching. The cassette is built by reading the payload back through the same function `preview` uses, so a fixture cannot drift from what generation actually sends.

**The first fixtures were wrong in a way only running it showed.** Six records spread across two days grouped into *two* units, so the narration claimed something false and the demo ran against the smaller one. Timestamps now fall inside one working day, and the tour picks the largest unit rather than the first — positional selection would silently demonstrate a stray fragment if that ever stopped being true.

**Doctor must not call an empty store a failure.** An empty store and a broken installation look identical from outside, and reporting "no collector has run" as `fail` tells somebody their installation is broken when it is complete. Every new check is a warning with a next step, and a test asserts a fresh machine produces no failures at all.

**A missing API key is a warning too.** AI is additive (ADR-0005); seventeen of the twenty commands work without one. Reporting its absence as a failure would contradict the architecture in the first thing a new user runs.

### Carried forward

- The tour is text. A recorded terminal session in the README would carry it further, and is a release-marketing task rather than an engineering one.
- No screenshot of Evidence Explorer is committed. Worth one before announcing.
- Outcome-shaped evidence remains the highest-value missing collector: it is the only thing standing between the product and outcome claims that are reachable by observation rather than only by interview.

---

## Deferred from Proof of Thesis

Each has a defined seam and requires **no schema migration** to add.

| Deferred | Seam already in place |
|---|---|
| Out-of-process plugins | `CollectorPort` + `protocol` package (M0, M4) |
| Capability enforcement | Grants declared in manifests; unenforced in-process |
| Sync | `export/` + ULIDs + append-only tables (M3) |
| More providers | `ProviderPort` (M9) |
| More exporters | `ExporterPort` (M10) |
| More collectors | `CollectorPort` + conformance suite (M4) |
| Analytics | Read-only queries over existing tables |
| Multi-party evidence | `subject_id` / `asserted_by` present from M1 |
| Desktop shell | Web UI is the foundation (M11) |

---

## Open items carried into implementation

| # | Item | Surfaces at |
|---|---|---|
| 1 | Outcome-shaped evidence for non-developers (`Vision.md` §15.4) | After M12 — a product problem, not an architecture one |
| 2 | Local-model pre-screen for non-deterministic redaction | M8 (deferred within) |
| 3 | Subagent transcript recovery from `~/.claude/tasks/` | M5 (explicitly out of scope) |
| 4 | `context-temporal@1` threshold values | M6 — requires real-data tuning |
| 5 | Repository placement | M0 |

---

## Definition of done for Proof of Thesis

A stranger installs CareerForge, points it at a repository and their AI session history, answers a few questions, and generates a resume bullet whose supporting evidence they can inspect — **and says *"I've never seen anything like this."***

Everything in this plan serves that sentence. Anything that does not is out of scope.
