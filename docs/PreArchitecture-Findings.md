# Pre-Architecture Findings

**Date:** 2026-07-30
**Purpose:** Resolve the two blockers identified in `Vision.md` §15 before architecture begins.
**Method:** Empirical analysis of real local data — 1,219 session files, 75,311 records, 328 MB, 30-day window (2026-06-30 → 2026-07-30).

---

# Part 1 — Claude Session Collector: Feasibility

## Verdict

**VIABLE. Approved for Proof of Thesis — with three mandatory design constraints and one rename.**

This is a genuinely differentiating source. It is also the most fragile and most sensitive source CareerForge will ever touch. Both are true, and the design must reflect both.

---

## 1.1 Is session history practically accessible?

**Yes. Unambiguously.**

| Property | Measured |
|---|---|
| Location | `~/.claude/projects/<url-encoded-cwd>/<session-uuid>.jsonl` |
| Format | Newline-delimited JSON, UTF-8, plain text |
| Session files (30 days) | **1,219** |
| Total volume (30 days) | **328 MB** |
| Records parsed | **75,311** |
| **Parse failures** | **0** |
| Median file size | 68 KB |
| Largest file | 32 MB |
| Distinct working directories | 65 |
| Distinct git branches | 16 |

No API, no auth, no database, no reverse engineering. Read-only file access to a well-formed local directory. **Zero malformed records across the entire corpus** — the writer is disciplined.

**Secondary stores found** (useful later, not needed for Proof of Thesis): `~/.claude/history.jsonl` (4,717 prompt records with `project`, `sessionId`, `timestamp`), `~/.claude/tasks/` (105 entries), `~/.claude/file-history/` (77), `~/.claude/plans/` (5), `~/.claude/shell-snapshots/` (74).

---

## 1.2 Is the format stable enough to build against?

**No — not the full schema. Yes — a narrow subset.** This is the single most important finding in this document.

### Schema version churn, measured

In a **single 30-day window**, records carried **12+ distinct `version` values**:

```
2.1.220  2.1.219  2.1.217  2.1.216  2.1.215  2.1.214
2.1.209  2.1.207  2.1.206  2.1.200  2.1.199  2.1.198
```

That is roughly a schema-bearing release every 2–3 days. **Any collector that assumes a fixed schema will break continuously.**

### Thirteen record types, most of them internal

| Type | Count (sample) | Assessment |
|---|---|---|
| `assistant` | 792 | **Stable core** |
| `attachment` | 601 | Peripheral |
| `user` | 446 | **Stable core** |
| `last-prompt` | 147 | Internal |
| `system` | 138 | Internal (hooks, metadata) |
| `bridge-session` | 95 | **Internal implementation detail** |
| `mode` / `permission-mode` | 92 / 92 | Internal |
| `queue-operation` | 86 | **Internal implementation detail** |
| `ai-title` | 73 | Useful but sparse (7% of sessions) |
| `file-history-snapshot` | 68 | Internal |
| `file-history-delta` | 19 | Internal |
| `pr-link` | 6 | Useful, very rare |

Types like `bridge-session` and `queue-operation` are transport plumbing. They will change without notice and must never appear in a mapping table.

### Mandatory constraint #1 — Tolerant parsing

The collector must:

1. **Extract only a narrow, load-bearing field set** (below). Ignore everything else.
2. **Skip unknown record types silently** — never error, never warn loudly.
3. **Skip unknown fields silently** — never validate strictly against a closed schema.
4. **Never assume a `version`.** Record it as provenance metadata; never branch on it unless a specific break is confirmed.
5. **Treat a parse failure on one line as a skip, not a session failure.**

The stable subset — present across every version observed:

```
type · timestamp · sessionId · cwd · gitBranch · uuid · parentUuid
message.role · message.content[] (text | tool_use | tool_result)
tool_use.name · tool_use.input
```

These are the fields the product itself depends on for resume and replay. They are the least likely to break.

---

## 1.3 What information is actually available?

**Substantially more than `git log`, and of a fundamentally different kind.**

| Signal | Measured | Career-evidence value |
|---|---|---|
| **User prompts** | 2,223, averaging **5,171 chars** | **Highest.** A problem statement in the user's own words, written before the solution existed. |
| Assistant responses | 792 in sample | Reasoning, approach, tradeoffs considered |
| Files created/edited | **853 distinct paths** | Concrete artifacts, with extensions |
| Bash/PowerShell commands | 555 git commands in 200 sessions | Real tooling and operational work |
| `git commit/push/merge/tag` | **140** in 200 sessions | Direct link to Git collector evidence |
| Working directory | 65 distinct | Project attribution |
| Git branch | 16 distinct | Work-stream attribution |
| Timestamps | On every substantive record | Timeline placement |
| `attributionSkill` / `attributionPlugin` / `attributionMcpTool` | Present | Tooling sophistication |
| `ai-title` | 85 sessions (**7%**) | Useful when present; cannot be relied upon |
| `pr-link` | 3 sessions | Excellent when present; very rare |
| File types touched | `.md` 733, `.tsx` 456, `.ts` 361, `.js` 108, `.swift` 97, `.json` 79, `.css` 70, `.py` 69, `.mjs` 59, `.html` 46, `.ps1` 46 | **Genuine technology evidence, derived not claimed** |

### Why this beats Git for career evidence

`git log` records **what changed**. It systematically discards **what problem was being solved, what was tried, and why the approach was chosen** — which is exactly the material a STAR story needs and exactly what a person forgets first.

A session transcript maps almost directly onto STAR:

| STAR element | Session source |
|---|---|
| **Situation / Task** | The user's opening prompt — a 5,000-character problem statement in their own words |
| **Action** | Tool sequence, files edited, commands run, approach discussed |
| **Result** | Commits, PRs, files created, closing state |

**No competitor has this.** It is the strongest single differentiator in the product.

---

## 1.4 Is there enough structure for meaningful Evidence?

**Yes — but the unit of work is not the session file.** This was the most surprising finding.

### The bimodal session problem

Session duration is not normally distributed. It is **bimodal**:

```
p10:  0.4 min
p50:  0.4 min     ← the median "session" is under 30 seconds
p90:  0.5 min
p99:  460.6 min

>5 min:   94 sessions   (7.7%)
>30 min:  70 sessions   (5.7%)
>2 hours: 40 sessions   (3.3%)
```

Median records per session: **22**.

**Over 90% of session files are fragments** — resumes, forks, one-shot invocations, aborted starts. Treating "one `.jsonl` file = one accomplishment" would generate thousands of meaningless Evidence records and bury the ~94 sessions that represent real work.

### Mandatory constraint #2 — Sessions must be grouped into Work Units

The collector must not emit one Evidence record per file. It must group fragments into a **Work Unit** using observable signals — `cwd` + `gitBranch` + temporal proximity — and apply a substance threshold (duration, record count, files touched, or commits present) before emitting Evidence.

**This is a genuine architectural requirement, not an implementation detail.** The Evidence model must support a *collector-defined grouping key* so that many raw source artifacts can roll up into one unit of work. Git has the same need (many commits → one feature). Designing this now avoids a schema migration later.

### Known gap: subagent work is invisible

`isSidechain` was **`false` on 57,206 records and `true` on 0**. Subagent transcripts are not in these files. Work delegated to subagents — often the most substantial work — is currently unattributable from this source alone. `~/.claude/tasks/` (105 entries) is the likely location and should be investigated during implementation, not now.

---

## 1.5 Privacy, portability, and versioning concerns

### Mandatory constraint #3 — Highest sensitivity classification in the product

**Session transcripts are the most dangerous data CareerForge will ever hold.** More dangerous than Git, by a wide margin. A transcript routinely contains:

- Full file contents, including files never committed
- Pasted credentials, tokens, connection strings, and API keys
- Internal architecture, client names, contract details
- Error messages and stack traces with production identifiers
- The user's unfiltered thinking about employers, colleagues, and clients

A git diff shows what changed. A transcript shows **everything the person looked at, pasted, and said.**

**Required, non-negotiable:**

| Requirement | Rationale |
|---|---|
| Sensitivity defaults to **maximum** | Never opt-in-by-default to remote enrichment |
| Local models are the **default** for this source | Consistent with `Vision.md` §6 |
| **Excerpt, never bulk-ship** | Send narrow extracts to any provider, never whole transcripts |
| **Mandatory payload preview** | The user sees exactly what would leave, before it leaves |
| Per-**project** scoping, not just per-source | A user must be able to enable `personal-project/` and exclude `client-work/` |

This source alone justifies the entire per-source consent architecture. It is the proof that the privacy model is necessary rather than decorative.

### Volume

**328 MB per user per month ≈ 4 GB/year.** Two consequences:

1. **Raw transcripts must not be copied into the Evidence store.** Store a reference, a content hash, and extracted excerpts.
2. **Naive enrichment is financially impossible.** Enrichment operates on Work Units and extracted excerpts, never raw corpora.

### Portability

The collector is Claude Code-specific: specific path, specific format, specific product. Users of Cursor, Copilot, Codex, Aider, or no AI tool at all get nothing from it.

This does **not** disqualify it — it aligns with "depth before breadth," and Claude Code users overlap heavily with the primary persona. But it must not be architecturally privileged.

---

## 1.6 Recommendation

### Rename: `AI Coding Session Collector`, with Claude Code as the first adapter

Not "Claude Session Collector."

The concept — *an AI-assisted work session containing a problem statement, an approach, and an outcome* — generalizes to Cursor, Copilot Workspace, Codex, and Aider. The **parser** is vendor-specific; the **Evidence it emits** must not be. Naming it generically now costs nothing and prevents a rename plus a schema change later, once someone contributes a Cursor adapter.

### Approved Proof of Thesis scope — unchanged in substance

Git + AI Coding Session (Claude Code adapter) + Manual Interview → Evidence → OpenAI enrichment → one resume bullet + Evidence Explorer.

### Complement, not replacement

Git and sessions are complementary and should be correlated, not merged: **Git proves the outcome; the session proves the reasoning.** A resume bullet supported by *both* — the problem in the user's own words plus the commit that resolved it — is the single most compelling Evidence Explorer screenshot available, and it is achievable with the two collectors already in scope.

### Fallback, if it degrades

If the format breaks badly or subagent invisibility proves fatal, the smallest replacement preserving the thesis is a **shell-history + file-mtime collector**. It captures activity but **not reasoning**, which weakens STAR generation considerably. It is a genuine fallback, not an equal. **Not needed now.**

### Residual risks accepted

1. Format churn — mitigated by tolerant parsing, not eliminated.
2. Subagent invisibility — investigate `~/.claude/tasks/` during implementation.
3. Vendor coupling — mitigated by the generic collector name and Evidence shape.

---

## 1.7 Addendum — measured during implementation (M5, 2026-07-30)

Three findings from building the collector against the real corpus rather than a sample. Each contradicted or extended an assumption above.

### Transcripts are deleted after 30 days

The corpus boundary is **exactly 30.0 days** (oldest 2026-06-30, newest 2026-07-30), and `cleanupPeriodDays` is unset — the default. This was read above as "the analysis window." It is retention.

Consequences, all material:

- **"Reference the raw transcript" produces a dangling reference within a month.** Evidence must stand alone. The collector stores a SHA-256 of the bytes it parsed, so provenance survives the file.
- **There is no second chance.** Anything not collected is lost permanently, not deferred. This is the argument that decided ADR-0017 against dropping programmatic sessions.
- **Backfill has a deadline.** A user installing CareerForge inherits at most 30 days of session history, and every day of delay costs a day permanently. That strengthens the case for the Continuous Operator retention model, not just the backfill acquisition model.

### 93% of sessions were driven by a program, not typed

| `promptSource` | Sessions |
|---|---|
| `sdk` | 1,110 |
| typed (incl. `queued`/`system` combinations) | 87 |
| none recorded | 1 |

The 85–90 human-driven sessions are close to the ~94 substantive sessions estimated in §1.4 by duration — two independent measures pointing at the same population. See ADR-0017 for how these are collected without misattributing them.

### Format drift is faster than the survey suggested

The survey saw 12 versions and 13 record types. Building against the corpus found **14 versions**, and the **first run surfaced 2 more record types and 13 more fields** — including `isCompactSummary`, which was hiding a correctness bug rather than merely being unrecognised. This is why drift is now reported rather than silently tolerated (ADR-0016).

---

# Part 2 — Canonical Storage Model

**Recommendation, stated plainly.**

## 2.1 Canonical source of truth: SQLite

**One SQLite database is canonical. Nothing else is.**

`Vision.md` described "SQLite + JSON + Markdown," which is three sources of truth and would drift within months. It resolves as: **SQLite is truth; JSON is the durable export; Markdown is a rendering.**

### Why SQLite, and not the alternatives

**Provenance is a graph, not a document.** An asset cites claims; claims cite evidence; evidence has enrichments; enrichments have versions and model attribution; user-confirmed answers link back to the questions that produced them. Evidence Explorer is a multi-hop traversal rendered as UI. Implementing that over a directory of Markdown files means writing a database badly, in application code, forever.

**Append-only requires transactions.** Supersede-and-tombstone semantics (`Vision.md` §12) demand atomic multi-row writes. Files cannot provide this without inventing a journal.

**Analytics requires aggregation.** "Which skills have gone dormant?" is a `GROUP BY` over years of enrichments. Over flat files it is a full corpus scan.

**Migration requires versioning.** SQLite provides `PRAGMA user_version` and transactional DDL — the foundation of the automatic-migration promise.

**It fits the constraints already chosen.** Single file, zero server, zero daemon, embedded, excellent TypeScript support, and it is the most portable data format in existence with the broadest tooling for a user who wants to leave.

### Why Markdown is not canonical

Markdown is the correct **output** format and a poor **storage** format. It cannot express the provenance graph without inventing a serialization nobody else can read, and every query becomes a parse. `Vision.md` §1 already settled the principle: **assets are generated views, not stored documents.** Markdown is a view.

## 2.2 Derived representations

Everything below is regenerable from SQLite, and **must be regenerable at any time by command**:

| Representation | Purpose | Regenerable |
|---|---|---|
| `export/**/*.json` | Durable, human-readable, diffable, syncable | Yes — `careerforge export` |
| Markdown / PDF / DOCX / JSON Resume | Career assets for humans and ATS | Yes — exporters |
| Search index (FTS5) | Fast local search | Yes — rebuilt from tables |
| Timeline / analytics views | UI surfaces | Yes — queries, never stored |

### The durability guarantee that makes SQLite safe

> **The database must be fully reconstructible from the JSON export, and the JSON export must be fully regenerable from the database.**

A `careerforge rebuild` command that restores a complete store from `export/` is a required feature, not a nice-to-have. It is what converts SQLite from a **jail** into an **index** — if the database is ever corrupted, superseded, or abandoned, no career history is lost.

The **JSON export format is versioned separately from the database schema and is deliberately far more stable.** The database may be refactored freely; the export is a long-term contract with the user.

### Raw payload handling — required, given measured volume

At 4 GB/year for one source, raw source data must not live in the database.

Store: a **content hash**, a **source reference** (path, offset, or ID), and **extracted excerpts** actually used as evidence. Optionally cache raw payloads in a content-addressed blob directory outside the DB, prunable without data loss.

The content hash provides free deduplication and makes re-enrichment against a newer model verifiable.

## 2.3 Migration strategy

1. **Forward-only, numbered migrations.** No down-migrations — they are rarely correct and never tested in the wild.
2. **`PRAGMA user_version` is the single schema-version authority.**
3. **Every migration runs inside a transaction.** It fully succeeds or fully rolls back.
4. **Automatic timestamped backup before every migration**, retained until the next successful start.
5. **A migration that cannot be performed automatically must halt and explain.** Never silent, never lossy, never best-effort. This is a direct implementation of the `Vision.md` §14 promise.
6. **Refuse to open a database newer than the running binary**, with a clear message. Prevents a stale install corrupting a synced store.
7. **Every migration ships with a test that migrates a real fixture database** from the prior version. Untested migrations are the fastest route to breaking the one promise that matters.

## 2.4 Backup strategy

| Layer | Mechanism | Protects against |
|---|---|---|
| **Pre-migration** | Automatic timestamped DB copy | Failed or buggy migrations |
| **Continuous** | `export/` JSON tree, regenerated on write or on demand | Database corruption; format obsolescence |
| **Versioned** | `export/` is a plain-file tree — Git-friendly by design | Accidental deletion; unwanted edits; full history |
| **Off-device** | User-owned sync of `export/`, encrypted, user-held keys | Device loss |
| **Integrity** | SQLite WAL + `PRAGMA integrity_check` on startup | Silent corruption |

**Sync operates on the JSON export, not the database file.** Syncing a live SQLite file across cloud storage is a well-known route to corruption, and binary files do not merge. A plain-file tree with stable per-record IDs is diffable, mergeable, inspectable, and safe on OneDrive, Dropbox, iCloud, or Git.

This also makes the deferred sync feature dramatically simpler when its time comes — a further argument for keeping it out of Proof of Thesis.

## 2.5 Where this differs from the assumptions in Vision.md

| Vision.md assumption | Recommendation | Why |
|---|---|---|
| "SQLite + JSON + Markdown" | **SQLite canonical; JSON derived-durable; Markdown rendered** | Three sources of truth guarantees drift |
| Markdown implied as storage | **Markdown is output only** | Cannot express the provenance graph; §1 already says assets are views |
| Sync destination unspecified | **Sync the JSON export, never the DB file** | Live SQLite over cloud sync corrupts; binaries do not merge |
| Raw evidence storage unaddressed | **Hash + reference + excerpt; blobs outside the DB** | Measured 4 GB/year from one source |

---

# Part 3 — Resulting Changes to Vision.md

| §15 Open Question | Status |
|---|---|
| 1. Canonical storage | **RESOLVED** — Part 2 |
| 2. Outcome-shaped evidence for non-developers | **OPEN** — unchanged; still unaddressed by Proof of Thesis |
| 3. Claude Session collector feasibility | **RESOLVED** — viable; renamed; three mandatory constraints |
| 4. Redaction determinism | **OPEN** — now higher priority; Part 1.5 shows the payload is far more sensitive than assumed |
| 5. Repository placement | **OPEN** — unchanged |

## New architectural requirements produced by this investigation

1. **Work Unit grouping** — the Evidence model must support a collector-defined grouping key so many source artifacts roll up into one unit of work. Applies to Git as much as to sessions.
2. **Tolerant parsing as a collector contract** — every collector declares a narrow required field set and ignores everything else. Not a per-collector choice; a platform rule.
3. **Reference-and-excerpt storage** — Evidence stores hashes, references, and excerpts. Never bulk raw payloads.
4. **Per-project consent granularity** — sensitivity scoping must reach below the source level to individual projects and directories.
5. **`careerforge rebuild`** — reconstruct the canonical database from the JSON export. A first-class command, and the guarantee that makes SQLite safe.
