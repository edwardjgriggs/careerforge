# CareerForge — Architecture

**Status:** Frozen. Changed only by an ADR that supersedes the relevant section.
**Date:** 2026-07-30
**Depends on:** `Vision.md` (frozen), `docs/PreArchitecture-Findings.md`

This document specifies **how** CareerForge fulfills the vision. It does not revisit product philosophy. Where a decision is constrained by a vision promise, that promise is cited rather than re-argued.

Contents are ordered by permanence — the things that are expensive to change come first.

| § | Layer | Changeability |
|---|---|---|
| 1 | Layering and invariants | Fixed |
| 2 | **Evidence schema** | **Immutable after 1.0** |
| 3 | Work Units | Immutable after 1.0 |
| 4 | Storage, migration, export | Schema migratable; export format near-frozen |
| 5 | Provenance graph | Immutable after 1.0 |
| 6 | Collectors | Contract frozen at 1.0; implementations free |
| 7 | Enrichment | Additive; freely versioned |
| 8 | Assets and generation | Freely changeable |
| 9 | Plugin protocol | Frozen at 1.0 under semver |
| 10 | Policy and egress enforcement | Internal; freely changeable |
| 11 | Module layout and boundaries | Internal |
| 12 | Proof of Thesis cut | — |

---

## 1. Layering and Invariants

### 1.1 Dependency direction

```
┌──────────────────────────────────────────────────────────┐
│  Interfaces        CLI  ·  Local Web UI                  │
├──────────────────────────────────────────────────────────┤
│  Application       generation · interview · analytics    │
├──────────────────────────────────────────────────────────┤
│  Domain            Evidence · WorkUnit · Provenance      │  ← no I/O, no AI
├──────────────────────────────────────────────────────────┤
│  Ports             CollectorPort · ProviderPort ·        │
│                    ExporterPort · StorePort              │
├──────────────────────────────────────────────────────────┤
│  Adapters          SQLite · JSON export · plugin host ·  │
│                    AI providers · exporters              │
└──────────────────────────────────────────────────────────┘
```

Dependencies point **inward only**. The domain layer imports nothing from adapters, performs no I/O, and has no knowledge that AI exists. This is what makes `Vision.md` §2.3 ("AI is never required") structurally true rather than merely intended: the AI layer cannot be a dependency of the store because the dependency graph forbids it.

### 1.2 Enforced invariants

These are checked in CI, not merely documented. A pull request violating one fails to build.

| # | Invariant | Enforcement |
|---|---|---|
| **I1** | Domain layer imports no adapter, no network, no AI SDK | Import-boundary lint rule |
| **I2** | No `UPDATE` or `DELETE` against evidence, work-unit, enrichment, or provenance tables | SQLite triggers reject them; test asserts rejection |
| **I3** | Every outbound network call from enrichment passes through the Policy Engine | Single choke-point module; lint bans direct HTTP imports elsewhere |
| **I4** | Every claim in a generated asset resolves to ≥1 provenance edge | Generation refuses to emit an unsupported claim; test asserts |
| **I5** | The database is reconstructible from `export/` with byte-identical logical content | Round-trip property test in CI |
| **I6** | Collectors are pure with respect to the store: they emit records, they never write | `CollectorPort` returns data; has no store handle |

### 1.3 Identity and time

Two temporal fields exist on every record and are never conflated:

- **`occurred_at`** — when the work happened in the real world. Sourced from the artifact. Drives all career reasoning, timelines, and analytics.
- **`recorded_at`** — when CareerForge learned of it. Drives sync, incremental collection, and audit.

Backfill (`Vision.md` §4) is exactly the case where these diverge by years. Any query that means "what did I do last quarter" uses `occurred_at`; any query that means "what changed since last sync" uses `recorded_at`.

**IDs are ULIDs** — lexicographically sortable, timestamp-prefixed, collision-free without coordination. Sortability matters because sync merges two append-only logs and ordering must be reconstructible without a central authority.

---

## 2. The Evidence Schema

**This is the most permanent artifact in the project.** `Vision.md` §14 commits to freezing it at 1.0 and to prioritizing its compatibility above developer convenience.

### 2.1 What Evidence is

An **Evidence** record is one atomic, factual, historical assertion about the subject's work, normalized from exactly one source artifact.

It is **not**: an interpretation, a summary written by AI, a generated asset, or a mutable object.

### 2.2 The record

```jsonc
{
  "id":              "01J8X...",        // ULID, immutable
  "schema_version":  1,

  // ── Identity & idempotency ──────────────────────────────
  "collector_id":    "git",             // stable collector namespace
  "source_uri":      "git://<repo-id>/commit/<sha>",
  "natural_key":     "sha256(collector_id + '\u0000' + source_uri)",
  "content_hash":    "sha256(canonical source payload)",

  // ── Classification ──────────────────────────────────────
  "kind":            "git.commit",      // namespaced, collector-owned
  "evidence_class":  "imported",        // imported | derived | user_confirmed
  "sensitivity":     "confidential",    // public | internal | confidential | restricted

  // ── Subject (multi-party forward compatibility) ─────────
  "subject_id":      "self",            // identity this evidence is ABOUT
  "asserted_by":     "self",            // identity that ASSERTS it

  // ── Time ────────────────────────────────────────────────
  "occurred_at":     "2026-07-18T14:02:11Z",
  "occurred_end":    null,              // non-null for spans
  "recorded_at":     "2026-07-30T09:11:04Z",

  // ── Context / scoping ───────────────────────────────────
  "context": {
    "project_key":   "careerforge",     // consent & scoping unit
    "workspace":     "C:/…/CareerForge",
    "stream":        "feat/evidence-schema"   // branch, client, engagement
  },

  // ── Content ─────────────────────────────────────────────
  "title":           "Add tolerant JSONL parser",
  "summary":         null,              // source-authored only; NEVER AI
  "excerpt":         "…bounded extract actually used as evidence…",
  "payload_ref":     "blob:sha256-…",   // nullable; blob store, outside DB
  "attributes":      { /* collector-defined, typed, queryable */ },

  // ── Grouping ────────────────────────────────────────────
  "grouping_hint":   "careerforge:feat/evidence-schema:2026-W30",

  // ── Append-only lineage ─────────────────────────────────
  "supersedes":      null,              // evidence.id this corrects
  "tombstoned_by":   null,              // tombstone.id suppressing this

  // ── Provenance of collection itself ─────────────────────
  "collector_version": "1.4.0",
  "source_format_version": "2.1.220"    // observed, never branched on
}
```

### 2.3 Field decisions that are load-bearing

**`natural_key` — idempotent re-collection.** Collectors run repeatedly and backfill overlaps incremental runs. Without a natural key, every run duplicates history. The key is derived, not stored by the collector, and is `UNIQUE` in the database. Re-collecting an unchanged artifact is a no-op.

**`content_hash` — change detection without mutation.** A git commit never changes; a calendar event does. When a re-collected artifact's `content_hash` differs, the collector emits a **new** Evidence row with `supersedes` pointing at the prior one. Nothing is updated in place (I2), and the change itself becomes visible history.

**`summary` is never AI-written.** It holds a summary *authored at the source* — a commit message body, a meeting description, a course abstract. AI summaries are Enrichments (§7). Allowing AI text into an Evidence field would collapse the fact/interpretation boundary that `Vision.md` §7 depends on, invisibly and irreversibly.

**`excerpt` + `payload_ref`, never bulk payload.** Measured volume is ~4 GB/year from one source (`PreArchitecture-Findings.md` §1.5). The database holds a bounded excerpt; full payloads live in a content-addressed blob directory that is prunable without data loss, because `content_hash` and `source_uri` allow re-fetch.

**`subject_id` and `asserted_by` exist from day one.** Both are `"self"` for the entire single-user lifetime of the product. They cost two columns now and make peer attestation, manager confirmation, and references (`Vision.md` §13) a *feature* rather than a *migration of every historical row*. This is the cheapest forward-compatibility decision available and the most expensive one to skip.

**`sensitivity` is on the row, not the source.** Session transcripts from a client project and from a personal project have identical provenance but different exposure rules. Row-level classification is what makes per-project consent (`PreArchitecture-Findings.md` §3) enforceable.

**`attributes` is a typed, queryable bag — not a dumping ground.** Collectors declare an attribute schema in their manifest. Values are scalars, dates, or string arrays. Nested objects are rejected: they cannot be indexed, cannot be analyzed, and become a private format nobody else can consume.

### 2.4 `evidence_class` and the fourth type

`Vision.md` §7 names four types: `derived`, `user_confirmed`, `imported`, `ai_enrichment`.

Three are Evidence rows. **`ai_enrichment` is a row in the `enrichments` table**, not in `evidence`.

This is a structural refinement, not a change in meaning. The user-facing four-way distinction is preserved exactly — Evidence Explorer labels all four — but the factual/interpretive boundary becomes enforced by table separation rather than by a column value that a bug could set wrongly. **AI output is physically incapable of occupying an Evidence row.** All four are nodes in one provenance graph (§5), so the distinction remains visible everywhere it matters.

### 2.5 Extensibility without schema change

New sources add new `kind` values and new `attributes`, never new columns. `kind` is namespaced by collector (`jira.issue`, `servicenow.change`, `cursor.session`), so a third-party plugin can define kinds without coordination and without touching core.

**Adding a column to `evidence` after 1.0 requires a migration and is expected to be rare.** The schema is designed so that the common case — supporting a new source — requires none.

---

## 3. Work Units

### 3.1 Why they exist

Measured: **over 90% of AI session files are sub-minute fragments; ~8% represent substantive work** (`PreArchitecture-Findings.md` §1.4). Git has the same shape — a feature is forty commits, not one. Emitting one asset-worthy record per artifact would bury real accomplishments under noise.

A **Work Unit** is a cohesive unit of work spanning multiple Evidence records. It is the level at which humans describe accomplishments, and therefore the level at which assets are generated.

### 3.2 The record

```jsonc
{
  "id":             "01J8Y…",
  "schema_version": 1,
  "title":          "Evidence schema and tolerant parser",   // derived or user-set
  "occurred_at":    "2026-07-14T09:00:00Z",
  "occurred_end":   "2026-07-19T17:40:00Z",
  "context":        { "project_key": "careerforge", "stream": "feat/evidence-schema" },
  "sensitivity":    "confidential",       // = MAX over members, never less
  "grouping_strategy": "context-temporal@1",
  "grouping_key":   "careerforge:feat/evidence-schema:2026-W30",
  "pinned":         false,                // true once a human edits membership
  "supersedes":     null,
  "tombstoned_by":  null
}
```

Membership is a separate append-only table so it can carry its own provenance:

```jsonc
{
  "work_unit_id": "01J8Y…",
  "evidence_id":  "01J8X…",
  "role":         "primary",    // primary | supporting | incidental
  "assigned_by":  "strategy",   // strategy | user
  "confidence":   0.86,         // null when assigned_by = user
  "recorded_at":  "…"
}
```

### 3.3 Design decisions

**Many-to-many, not one-to-many.** One commit can support two accomplishments. Forcing exclusivity would require choosing which career story an artifact belongs to at collection time, before anyone knows what the stories are.

**Grouping is a versioned, re-runnable strategy — not a collector responsibility.** Collectors emit a `grouping_hint`; the core groups. Two consequences: grouping improves retroactively for all historical evidence when a strategy improves, and plugin authors do not each invent their own clustering.

**`pinned` protects human decisions.** Re-running a strategy never alters a Work Unit a human has edited. Without this, improving the grouping algorithm silently destroys curation — the single fastest way to lose a user's trust in a system holding a decade of their history.

**Sensitivity is the maximum over members, never the minimum or the average.** A Work Unit containing one restricted artifact is restricted. Computed, never stored independently.

**Merges and splits are append-only.** Merging emits a new Work Unit superseding both originals; splitting emits two superseding one. History of how the user organized their own career is preserved, and undo is free.

**Grouping is deterministic and reproducible.** `grouping_strategy` is versioned (`context-temporal@1`). Given the same evidence and the same strategy version, grouping is identical on any machine — which is what allows sync to converge without a coordinator.

### 3.4 Proof of Thesis strategy: `context-temporal@1`

Group Evidence sharing `context.project_key` and `context.stream` within a bounded idle gap; admit the resulting unit only if it clears a substance threshold (duration, distinct artifacts touched, or presence of a commit). Deliberately simple, deliberately replaceable. Thresholds are configuration, not constants in code, because they will be wrong at first and must be tunable without a release.

---

## 4. Storage, Migration, and Export

Resolved in `PreArchitecture-Findings.md` Part 2; specified here.

### 4.1 Layout

```
~/.careerforge/
├── careerforge.db          # SQLite (WAL) — CANONICAL
├── blobs/                  # content-addressed, prunable, outside DB
│   └── sha256/ab/cd/abcd…
├── export/                 # DERIVED — durable, diffable, the sync unit
│   ├── manifest.json       # export_format_version, counts, checksums
│   ├── evidence/YYYY/MM/<ulid>.json
│   ├── work-units/<ulid>.json
│   ├── enrichments/<ulid>.json
│   ├── provenance/<ulid>.json
│   ├── assets/<ulid>.json
│   └── identities/<id>.json
├── backups/                # pre-migration snapshots
└── config/                 # settings, consent grants, plugin registry
```

### 4.2 Core tables

```sql
-- Append-only. Triggers reject UPDATE and DELETE (invariant I2).
CREATE TABLE evidence (
  id                    TEXT PRIMARY KEY,       -- ULID
  schema_version        INTEGER NOT NULL,
  collector_id          TEXT NOT NULL,
  source_uri            TEXT NOT NULL,
  natural_key           TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  evidence_class        TEXT NOT NULL
                          CHECK (evidence_class IN
                            ('imported','derived','user_confirmed')),
  sensitivity           TEXT NOT NULL
                          CHECK (sensitivity IN
                            ('public','internal','confidential','restricted')),
  subject_id            TEXT NOT NULL DEFAULT 'self',
  asserted_by           TEXT NOT NULL DEFAULT 'self',
  occurred_at           TEXT NOT NULL,          -- ISO-8601 UTC
  occurred_end          TEXT,
  recorded_at           TEXT NOT NULL,
  project_key           TEXT,
  workspace             TEXT,
  stream                TEXT,
  title                 TEXT NOT NULL,
  summary               TEXT,                   -- source-authored only
  excerpt               TEXT,
  payload_ref           TEXT,
  attributes            TEXT NOT NULL DEFAULT '{}',   -- JSON
  grouping_hint         TEXT,
  supersedes            TEXT REFERENCES evidence(id),
  tombstoned_by         TEXT,
  collector_version     TEXT NOT NULL,
  source_format_version TEXT,
  UNIQUE (natural_key, content_hash)
);

CREATE INDEX ix_evidence_occurred     ON evidence(occurred_at);
CREATE INDEX ix_evidence_project_time ON evidence(project_key, occurred_at);
CREATE INDEX ix_evidence_kind         ON evidence(kind);
CREATE INDEX ix_evidence_grouping     ON evidence(grouping_hint);
CREATE INDEX ix_evidence_natural      ON evidence(natural_key);

-- Suppression without deletion.
CREATE TABLE tombstones (
  id          TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,      -- evidence | work_unit | enrichment | asset
  target_id   TEXT NOT NULL,
  reason      TEXT,
  scope       TEXT NOT NULL       -- hidden | redacted | purged
                CHECK (scope IN ('hidden','redacted','purged')),
  recorded_at TEXT NOT NULL
);
```

Every read path goes through views that exclude tombstoned and superseded rows. **Application code never queries base tables directly** — that is how a tombstone eventually leaks into an exported resume.

```sql
CREATE VIEW evidence_current AS
SELECT e.* FROM evidence e
WHERE e.tombstoned_by IS NULL
  AND NOT EXISTS (SELECT 1 FROM evidence s WHERE s.supersedes = e.id
                                             AND s.tombstoned_by IS NULL);
```

`UNIQUE (natural_key, content_hash)` delivers idempotency: unchanged re-collection is a no-op insert; changed content inserts a new row that supersedes.

**`scope = 'purged'`** is the one case where bytes are actually removed — required for credentials or third-party personal data that must not persist. The tombstone survives so provenance stays explicable ("evidence removed at user request") rather than silently dangling.

### 4.3 Search

FTS5 virtual tables over `title`, `summary`, `excerpt`, and enrichment text. **Fully derived** — dropped and rebuilt by `careerforge reindex`, never synced, never backed up. Search must work with zero AI (`Vision.md` §2.3), so FTS5 is the primary search path and semantic search is a later, optional addition — never a replacement.

### 4.4 Migrations

1. Forward-only, numbered `0001_…`, `0002_…`. No down-migrations.
2. `PRAGMA user_version` is the sole authority.
3. Each migration runs in one transaction — full success or full rollback.
4. Automatic timestamped backup to `backups/` before any migration; retained until the next clean start.
5. **A migration that cannot complete automatically halts and explains.** Never silent, never lossy, never partial (`Vision.md` §14).
6. Opening a database with `user_version` newer than the binary is refused with a clear message — a stale install must never corrupt a synced store.
7. **Every migration ships with a test that migrates a real fixture database from the prior version.** An untested migration is the fastest route to breaking the one promise that matters.

### 4.5 Export format

The export is a **separate, more stable contract than the database schema**. `manifest.json` carries `export_format_version`, and it changes far less often than `user_version`.

- One JSON file per record, named by ULID, pretty-printed with **sorted keys** so diffs are minimal and reviewable.
- Partitioned by `occurred_at` year/month so a decade of history does not become one unmanageable directory.
- Blobs are **not** exported by default; `payload_ref` hashes are. Blob export is opt-in per project, because that is where the sensitive bulk lives.
- `careerforge export` is idempotent: unchanged records produce byte-identical files, so a sync target sees no churn.

**`careerforge rebuild` reconstructs the canonical database from `export/`.** Invariant I5 asserts round-trip fidelity in CI. This is what makes SQLite an index rather than a jail.

### 4.6 Sync (deferred, constrained now)

Sync is out of Proof of Thesis (`Vision.md` §11). Two decisions are made now because they constrain the schema:

- **Sync operates on `export/`, never on `careerforge.db`.** Live SQLite over cloud sync corrupts; binary files do not merge.
- **Convergence without a coordinator is possible because every table is append-only and every ID is a ULID.** Merging two exports is a set union. Conflicts are impossible for records; the only conflict class is competing supersede chains, resolved by ULID ordering with both branches retained.

---

## 5. The Provenance Graph

This layer is what makes Evidence Explorer possible and what enforces `Vision.md` §7 ("every claim traceable"). It is the second-most permanent structure after Evidence.

### 5.1 Model

Nodes are typed and heterogeneous:

| Node | Table | Nature |
|---|---|---|
| Evidence | `evidence` | Fact |
| Work Unit | `work_units` | Grouping of facts |
| Enrichment | `enrichments` | AI interpretation |
| User Answer | `evidence` (`user_confirmed`) | Human-asserted fact |
| Claim | `claims` | One assertion inside an asset |
| Asset | `assets` | Generated artifact |

Edges are append-only and typed:

```sql
CREATE TABLE provenance_edges (
  id          TEXT PRIMARY KEY,
  from_kind   TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_kind     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  relation    TEXT NOT NULL
                CHECK (relation IN
                  ('supports','derived_from','grouped_into',
                   'interprets','answers','contradicts','supersedes')),
  weight      REAL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX ix_prov_from ON provenance_edges(from_kind, from_id);
CREATE INDEX ix_prov_to   ON provenance_edges(to_kind, to_id);
```

### 5.2 Claims — the unit of accountability

A generated asset is not verified as a whole. **Each assertion inside it is a `Claim` with its own support set.**

```jsonc
{
  "id":            "01J9A…",
  "asset_id":      "01J9B…",
  "text":          "Implemented Intune compliance policies for 50+ users",
  "span":          [0, 61],          // offset into the asset's rendered text
  "claim_type":    "action",         // action | scope | outcome | metric | role
  "support_state": "supported",      // supported | unsupported | contested
  "metric_source": "user_confirmed"  // null | derived | user_confirmed
}
```

**Invariant I4: generation refuses to emit a claim with zero `supports` edges.** This is not a validation warning — it is a hard failure at generation time. It is the mechanism, rather than the intention, behind "the AI may not assert what isn't there" (`Vision.md` §7).

`claim_type` exists because failure modes differ by type. A `role` claim ("led") and a `metric` claim ("40%") are the two that end careers when fabricated (`PreArchitecture-Findings.md`, `Vision.md` §7). They carry stricter support requirements than an `action` claim:

| `claim_type` | Minimum support |
|---|---|
| `action` | ≥1 Evidence or Work Unit |
| `scope` | ≥1 Evidence with a matching `attributes` value |
| `role` | ≥1 `user_confirmed` Evidence — **never inferred** |
| `metric` | `derived` (computed) or `user_confirmed` — **never model-generated** |
| `outcome` | ≥1 Evidence, or `user_confirmed` |

### 5.3 Gaps — missing information as first-class data

The "Missing Information" panel (`Vision.md` §5) is not UI garnish. It is a queryable table, and it is the engine of the interview loop.

```jsonc
{
  "id":            "01J9C…",
  "work_unit_id":  "01J8Y…",
  "gap_type":      "metric",         // metric | role | scope | outcome | context
  "question":      "Approximately how many users were affected?",
  "rationale":     "A scope claim would strengthen this bullet.",
  "status":        "open",           // open | answered | declined | stale
  "answered_by":   null,             // evidence.id of the user_confirmed answer
  "asked_count":   1,
  "last_asked_at": "2026-07-30T…"
}
```

**Gaps are deduplicated against existing `user_confirmed` Evidence before being raised.** `Vision.md` §7 requires that CareerForge never ask the same question twice; `asked_count` and `status = 'declined'` make that enforceable rather than aspirational. A declined gap is never re-raised for the same Work Unit.

Answering a gap writes a `user_confirmed` Evidence row plus an `answers` edge. **The answer is reusable across every future asset** — this is the mechanism by which the system gets smarter with use.

### 5.4 Explaining a claim

Evidence Explorer's core query is a bounded reverse traversal from a Claim across `supports` and `interprets` edges, resolving each node to a display record labelled by its class — the four-way distinction from `Vision.md` §7 surfaced literally in the UI. Depth is bounded; there is no unbounded graph walk on a UI path.

---

## 6. Collectors

### 6.1 Contract

```typescript
interface CollectorManifest {
  id: string;                     // stable namespace, e.g. "git"
  version: string;                // semver
  api_version: string;            // plugin protocol version
  kinds: string[];                // evidence kinds emitted, namespaced by id
  attribute_schema: Record<string, AttributeSpec>;
  capabilities: {
    backfill: boolean;            // can replay history
    incremental: boolean;         // can resume from a cursor
    watch: boolean;               // deferred; declared now
  };
  default_sensitivity: Sensitivity;
  required_grants: Grant[];       // paths, hosts, scopes — §9.3
  required_fields: string[];      // tolerant-parsing declaration — §6.3
}

interface CollectorPort {
  describe(): CollectorManifest;
  discover(scope: Scope): Promise<SourceRef[]>;         // e.g. repos, projects
  collect(scope: Scope, cursor: Cursor | null):
    AsyncIterable<EvidenceDraft | CursorAdvance>;
}
```

`CollectorPort` has **no store handle** (invariant I6). Collectors emit drafts; the core assigns IDs, computes `natural_key`, applies policy, and persists. A collector cannot write to the database, cannot bypass sensitivity classification, and cannot skip the policy engine — by construction, not by review.

### 6.2 Backfill is a first-class mode, not a special case

`Vision.md` §4 makes retroactive ingestion the acquisition model. Therefore `collect()` with `cursor = null` means *"replay everything you can see"*, and every collector must implement it. A collector that can only watch the present is incomplete and fails its contract test.

Cursors are collector-defined opaque strings, persisted per `(collector_id, scope)`, and advanced only via an explicit `CursorAdvance` yield — so an interrupted run resumes without gaps and without duplicates.

### 6.3 Tolerant parsing is a platform rule

Measured: **12+ source schema versions in a 30-day window** (`PreArchitecture-Findings.md` §1.2). Therefore:

1. A collector declares `required_fields` — the narrow set it genuinely depends on.
2. Records missing a required field are **skipped and counted**, never fatal.
3. Unknown record types, unknown fields, and unknown source versions are **ignored silently**.
4. `source_format_version` is recorded as provenance; **branching on it requires a documented, confirmed break.**
5. A parse failure on one record never fails a run.

Every run emits a `CollectionReport` (records seen, emitted, skipped by reason, unknown types encountered). Skipped-record trends are how format drift is detected before users report it.

### 6.4 Contract test suite

One shared conformance suite runs against every collector, in-tree or third-party — the mechanism behind "a contributor shouldn't need to understand the entire codebase" (`Vision.md` §10):

| Test | Asserts |
|---|---|
| Idempotency | Two identical runs produce zero net new rows |
| Backfill/incremental agreement | Full backfill ≡ incremental runs over the same window |
| Interruption safety | Killed mid-run, resumed, produces no gaps or duplicates |
| Tolerance | Corrupted, truncated, and unknown-version fixtures do not throw |
| Purity | No writes, no unauthorized network, no unauthorized paths |
| Determinism | Same input → identical `natural_key` and `content_hash` |
| Manifest honesty | Emitted kinds and attributes match the declared schema |

### 6.5 Proof of Thesis collectors

**Git** — walks local repositories. `kind: git.commit`. Attributes: repo, sha, branch, files changed, insertions, deletions, coauthors, merge flag. `grouping_hint` from repo + branch + ISO week. Backfill is the full log. Sensitivity default `confidential`.

**AI Coding Session** (Claude Code adapter) — the constraints from `PreArchitecture-Findings.md` are contractual:

- Reads `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
- `required_fields`: `type`, `timestamp`, `sessionId`, `cwd`, `message.content`. Everything else optional.
- Emits `kind: session.fragment` per file, and `grouping_hint` from `cwd` + `gitBranch` + temporal bucket. **It does not decide what a Work Unit is** — grouping is core's job (§3.3).
- Extracts: the opening user prompt (verbatim, the STAR *Situation*), tool sequence, file paths touched, git commands observed, skill/tool attribution.
- `default_sensitivity: "restricted"` — the highest in the product. Transcripts contain pasted credentials, uncommitted file contents, and client identifiers.
- Stores excerpts and hashes only; raw transcripts are referenced, never copied (4 GB/year measured).
- Named for the concept, not the vendor: a Cursor or Codex adapter emits the same kinds.

**Manual Interview** — not a source reader. It consumes open `Gaps` (§5.3) and writes `user_confirmed` Evidence with an `answers` edge. `kind: interview.answer`. Sensitivity inherited from the Work Unit that raised the gap.

---

## 7. Enrichment

### 7.1 Position

Enrichment is a **separate pipeline** that reads Evidence and Work Units and writes Enrichments. It never writes Evidence, never modifies anything, and is never a dependency of collection, storage, search, timeline, or export (`Vision.md` §2.3, invariant I1).

### 7.2 Record

```jsonc
{
  "id":            "01J9D…",
  "run_id":        "01J9E…",
  "target_kind":   "work_unit",
  "target_id":     "01J8Y…",
  "enrichment_type": "skills",   // skills | technologies | impact | leadership
                                 // | keywords | star_candidate | summary
  "value":         { /* typed, schema per enrichment_type */ },
  "confidence":    0.82,
  "superseded_by": null,
  "recorded_at":   "…"
}
```

```jsonc
// enrichment_runs — reproducibility
{
  "id":              "01J9E…",
  "provider_id":     "openai",
  "model":           "…",
  "params_hash":     "sha256(temperature, top_p, …)",
  "prompt_template": "skills@3",
  "prompt_hash":     "sha256(rendered prompt)",
  "input_ids":       ["01J8X…", "01J8Z…"],
  "input_hash":      "sha256(ordered input content hashes)",
  "policy_decision_id": "01J9F…",       // §10 — what was permitted to leave
  "redaction_profile":  "default@2",
  "started_at": "…", "completed_at": "…",
  "token_usage": { "in": 0, "out": 0 },
  "status": "completed"
}
```

### 7.3 Decisions

**Enrichments are never overwritten.** Re-running produces new rows; prior rows are marked `superseded_by` but remain queryable (`Vision.md` §5). "How did my resume read before I switched models?" is answerable forever.

**`input_hash` gives free caching and honest invalidation.** Identical inputs, template, and model produce no new call. When Evidence is superseded, dependent enrichments become stale and are flagged — not silently reused.

**Runs are reproducible.** Storing `prompt_hash`, `params_hash`, and `input_hash` makes any output re-derivable and auditable. This is what allows a user to answer "why does it say this?" about output produced a year ago by a model that no longer exists.

**Providers are a narrow port.** `ProviderPort` accepts a rendered prompt plus a response schema and returns structured output. It has no knowledge of Evidence, careers, or provenance. That narrowness is why Ollama, LM Studio, and future providers are interchangeable, and why a local model is a first-class path rather than a degraded one.

**Enrichment operates on Work Units, not raw corpora.** Measured volume makes whole-corpus enrichment financially impossible and privacy-hostile. Inputs are excerpts from a bounded Work Unit, post-redaction.

---

## 8. Assets and Generation

### 8.1 Assets are materialized views with history

`Vision.md` §1 holds that assets are generated views, not stored facts. Concretely: an asset row is a **generation record** — reproducible from its provenance, carrying its inputs, and never a source of truth. Deleting every asset loses nothing but compute.

```jsonc
{
  "id":            "01J9B…",
  "asset_type":    "resume_bullet",   // resume_bullet | star_story | portfolio
                                      // | interview_answer | review_summary
  "work_unit_id":  "01J8Y…",
  "run_id":        "01J9E…",
  "rendered_text": "Implemented Intune compliance policies for 50+ users…",
  "review_state":  "draft",           // draft | reviewed | exported
  "revision_of":   null,              // prior asset.id when user-edited
  "edited_by":     null               // null | 'user'
}
```

### 8.2 The review gate

`Vision.md` §5 places the only human gate at the asset layer. Enforced mechanically: **exporters reject any asset whose `review_state` is `draft`.** The gate lives in the export path, not in the UI, so a CLI user, a scripted run, and a future desktop app all inherit it.

### 8.3 Style feedback loop

A user edit creates a new asset row with `revision_of` set and `edited_by = 'user'`. The `(before, after)` pair is a **style exemplar**.

Exemplars are used as few-shot examples in later generation — **never as training data, never leaving the machine except under the same policy gate as any other egress, and never modifying Evidence** (`Vision.md` §7). The loop teaches phrasing, not facts. An edit that changes a *claim* rather than *wording* is detected by claim-set comparison and routed to the interview engine as a correction, because that is a factual disagreement, not a stylistic one.

---

## 9. Plugin Protocol

`Vision.md` §12: the protocol is the platform. It is frozen at 1.0 under semver.

### 9.1 Transport

JSON-RPC 2.0 over stdio. Newline-delimited. Plugin is a child process; core is the client.

Chosen because it is language-agnostic (the vision requirement), needs no ports or sockets, works identically on Windows/macOS/Linux, is trivially debuggable by piping fixtures, and is proven at scale by MCP. **Plugins are never loaded in-process** (`Vision.md` §8) — a crashing or malicious plugin cannot take down the host or read the store.

### 9.2 Lifecycle

```
core → initialize { api_version, host_version, granted_capabilities }
plugin → initialized { manifest }
core → collect { scope, cursor }
plugin → …stream of evidence.draft notifications…
plugin → collect.complete { cursor, report }
core → shutdown
```

Version negotiation happens in `initialize`. A plugin declaring an unsupported `api_version` is refused with a clear message rather than failing later in an unrelated way.

### 9.3 Capabilities

The manifest declares grants; the user approves them at install; the core enforces them. **A plugin cannot perform an ungranted operation, because it does not perform operations at all** — it requests them, and the core is the policy enforcement point (`Vision.md` §8).

```jsonc
"required_grants": [
  { "type": "fs.read",       "paths": ["~/.claude/projects"] },
  { "type": "evidence.read", "kinds": ["git.commit"] },
  { "type": "evidence.write","kinds": ["session.fragment"] },
  { "type": "net",           "hosts": ["api.example.com"] },
  { "type": "egress",        "categories": ["excerpt"] }
]
```

Grants are **viewable, revocable, and scopeable to specific projects or paths** after install (`Vision.md` §8). Every granted-capability use is written to an append-only audit log, so "what has this plugin actually done?" is answerable.

`egress` is a distinct grant from `net`: a plugin may need network access to *fetch* without being permitted to *send local evidence*. Conflating them is how a collector quietly becomes an exfiltration path.

### 9.4 Host API surface

Deliberately minimal. Every method is capability-gated.

| Method | Grant |
|---|---|
| `evidence.emit` | `evidence.write` (kind-scoped) |
| `evidence.query` | `evidence.read` (kind-scoped) |
| `blob.put` / `blob.get` | `evidence.write` / `evidence.read` |
| `log` | none |
| `progress` | none |
| `secret.get` | `secret` (named entries only) |

No method exposes raw SQL, raw filesystem, or the store handle. Adding a method to this list after 1.0 is a semver-minor event and requires a documented justification.

### 9.5 Trust tiers and distribution

The five tiers from `Vision.md` §10 are metadata in the plugin index, surfaced at install time alongside the requested grants. **Tiers describe review and maintenance status; they never expand what a plugin may do.** A `Core` plugin requesting `egress` is prompted exactly like a `Community` one.

In-tree collectors run through the same `CollectorPort` and the same conformance suite as third-party ones — but in-process, since they ship with the host and share its trust boundary. **The contract is identical; only the process boundary differs.** This is what keeps the first-party path from silently diverging into a privileged API that third parties cannot match.

---

## 10. Policy and Egress Enforcement

The single choke point for invariant I3. Not a plugin, not optional, not bypassable.

### 10.1 Pipeline

```
Enrichment request
   ↓  resolve inputs → sensitivity = MAX over all inputs
   ↓  consent check: is (project_key, provider, sensitivity) granted?
   ↓  redaction: deterministic scrub → RedactionReport
   ↓  payload preview (interactive) / policy assert (non-interactive)
   ↓  provider call
   ↓  record PolicyDecision  ← referenced by enrichment_runs
```

A `PolicyDecision` row records what was permitted, what was redacted, which profile version applied, and which consent grant authorized it. It is append-only and referenced from `enrichment_runs`, so **every remote call in the system's history is auditable after the fact.**

### 10.2 Consent granularity

Grants are keyed on `(project_key, provider_id, max_sensitivity)`. This is what `PreArchitecture-Findings.md` §3 requires: a user enables their personal repositories for a cloud provider while their client work reaches only a local model. Source-level consent is too coarse for the audience the vision targets.

**Default posture:** `restricted` evidence never reaches a non-local provider. Overriding requires an explicit, per-project grant — never a global switch.

### 10.3 Deterministic redaction

Open question #5 in `Vision.md` §15 is narrowed here, not closed.

**Detected deterministically** (pattern- and entropy-based, no AI): private keys and certificate blocks, common cloud and vendor token formats, connection strings, `Authorization` headers, `.env`-style assignments, high-entropy strings in credential-shaped contexts, email addresses, absolute paths containing usernames.

**Not reliably detectable without AI:** client and project names in prose, unreleased product details, personnel discussion, business-sensitive context.

**Therefore the payload preview is mandatory, not advisory** — it is the honest mitigation for the residual class, and the reason `Vision.md` §6 promises the user sees exactly what leaves. Redaction profiles are versioned (`default@2`) and recorded per run, so re-running under an improved profile is distinguishable from the original.

**Open, to be resolved before the redaction milestone:** whether an optional *local-model* pre-screen for the undetectable class is worth the complexity. It cannot be a remote call — that would defeat the purpose.

---

## 11. Module Layout

```
careerforge/
├── packages/
│   ├── domain/          # Evidence, WorkUnit, Provenance, Claim, Gap
│   │                    #   pure; no I/O, no AI, no SQL
│   ├── store/           # SQLite adapter, migrations, export, rebuild
│   ├── policy/          # consent, sensitivity, redaction, audit  (I3 choke point)
│   ├── collect/         # collector host, cursors, conformance suite
│   ├── enrich/          # provider port, runs, prompt templates
│   ├── generate/        # assets, claims, gaps, style exemplars
│   ├── protocol/        # JSON-RPC types, capability manifests  (frozen at 1.0)
│   ├── cli/             # command surface
│   └── ui/              # local web UI (Evidence Explorer)
├── collectors/          # in-tree: git, ai-session, interview, fs, calendar
├── providers/           # in-tree: openai, anthropic, ollama, lmstudio
├── exporters/           # in-tree: markdown, pdf, docx, json-resume
└── docs/
```

**Why a monorepo with hard package boundaries:** the boundaries are what make invariants I1 and I3 mechanically checkable rather than review-dependent. `domain` has no dependencies. `store` depends only on `domain`. `policy` is the only package permitted to import an HTTP client. `protocol` depends on nothing and is published separately, so a plugin author in any language can consume the schema without pulling the application.

**Why `protocol` is its own package:** it is the artifact third parties build against, it is frozen at 1.0, and it must be versionable independently of the application. It is also the reason a contributor writing a collector does not need to understand the rest of the codebase (`Vision.md` §10).

---

## 12. The Proof of Thesis Cut

Built, minimally:

| Layer | Included |
|---|---|
| Domain | Evidence, WorkUnit, Provenance, Claim, Gap |
| Store | SQLite + migrations + export + `rebuild` + FTS5 |
| Collect | In-process host; Git, AI Session, Interview |
| Grouping | `context-temporal@1` |
| Enrich | OpenAI provider; `skills`, `technologies`, `star_candidate` |
| Policy | Sensitivity, per-project consent, deterministic redaction, payload preview |
| Generate | `resume_bullet` with claim-level support and gap emission |
| CLI | `collect · enrich · generate · interview · ui · export · rebuild · doctor` |
| UI | Evidence Explorer only |

Deferred but **structurally accommodated** — each has a defined seam and requires no schema migration to add:

| Deferred | Seam already in place |
|---|---|
| Out-of-process plugins | `CollectorPort` + `protocol` package |
| Capability enforcement | Grants in the manifest; unenforced in-process |
| Sync | `export/` + ULIDs + append-only tables |
| More providers | `ProviderPort` |
| More exporters | `ExporterPort` |
| Analytics | Read-only queries over existing tables |
| Multi-party evidence | `subject_id` / `asserted_by` present from row one |

### The three-question test

If the architecture is right, these are all "no schema change":

1. *Add a Jira collector?* → New collector, new `kind`, new attributes. No core change.
2. *Add peer attestation?* → New identity, `subject_id` ≠ `asserted_by`, new provenance relation. No migration.
3. *Swap OpenAI for a local model?* → New provider adapter. New `enrichment_run`, prior enrichments preserved.

---

## 13. Open Items

| # | Item | Blocks |
|---|---|---|
| 1 | Outcome-shaped evidence for non-developers (`Vision.md` §15.4) | Serving secondary personas |
| 2 | Local-model pre-screen for non-deterministic redaction (§10.3) | Redaction milestone |
| 3 | Subagent transcript recovery from `~/.claude/tasks/` | AI Session collector completeness |
| 4 | `context-temporal@1` threshold values | Requires real-data tuning — scored against [`eval/grouping/`](../eval/grouping/) |
