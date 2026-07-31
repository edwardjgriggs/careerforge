# CareerForge — Vision

**Status:** Frozen. Changed only by an ADR that supersedes the relevant section.
**Date:** 2026-07-30
**Author:** Edward Griggs
**License:** Apache License 2.0

> This document defines **what** CareerForge is and **why**, and deliberately contains no
> architecture. For how it works, see [Architecture.md](Architecture.md). For how a decision
> here was changed, see [docs/adr/](adr/) — an ADR that contradicts this document supersedes
> it, and this document is corrected to match.

---

## 1. What CareerForge Is

CareerForge is a **local-first evidence engine for professional work**.

> **CareerForge is an Evidence Engine. Career assets are generated views of your evidence, not documents you write.**

It automatically collects evidence of a person's work, optionally enriches that evidence with AI, and transforms it into career assets: resume bullets, STAR stories, portfolio entries, interview answers, performance review material, and career analytics. It refuses to assert anything the evidence cannot support, and says what would change the answer.

*Corrected by [ADR-0029](adr/0029-positioning-is-an-evidence-engine.md), which retired the previous description ("an AI-powered Career Intelligence Platform") as indistinguishable from the products this project exists to argue against — and as contradicting ADR-0005, under which AI is additive rather than load-bearing.*

### What CareerForge Is Not

- **Not a journaling app.** Collection is automatic. Nothing about CareerForge should feel like a daily writing chore.
- **Not an AI resume writer.** It does not invent accomplishments, and it does not manufacture metrics.
- **Not a SaaS product.** No CareerForge-operated server ever stores user evidence.
- **Not a note-taking tool.** Evidence is structured, provenanced, and queryable — not prose in a folder.

---

## 2. Foundational Principles

These are the commitments every future decision is measured against. They are ordered; earlier principles win ties.

1. **Evidence is factual. AI interprets. Humans approve professional claims.**
2. **User data endures.** If backward compatibility for evidence ever conflicts with developer convenience, evidence wins.
3. **AI is never required.** CareerForge is fully useful with no API key and no network connection. The local experience is the product, not a degraded mode.
4. **Never overpromise a connector.** If a source cannot be collected honestly and automatically, CareerForge asks the user instead of guessing.
5. **Accuracy beats stronger-sounding.** Every time, without exception.
6. **Your career data stays under your control.** Nothing leaves the machine without explicit, scoped, revocable consent.
7. **Depth before breadth.** Better to be the best tool for technical knowledge workers than an average tool for everyone.
8. **The protocol is the platform.** The plugin contract, not the implementation language, defines the ecosystem.
9. **Ship the smallest version that proves the idea.** Let real users determine what deserves to be built next.

---

## 3. Target Audience

### v1.0 — Technical Knowledge Workers

Software engineers, IT and system administrators, cybersecurity professionals, DevOps and cloud engineers, technical consultants.

Chosen because they generate machine-readable evidence naturally, and because they are the population most likely to adopt, evaluate, and contribute to an open-source platform.

### At Scale — Anyone Whose Work Creates Digital Artifacts

Project managers, marketers, designers, HR professionals, researchers, teachers, analysts.

**This expansion must happen because the Evidence model naturally supports them — never because one-off logic was added for a profession.** If serving a new audience requires special-casing the core, the core is wrong.

### Architectural Consequence

The ingestion layer is **source-agnostic from day one**. Every collector emits the same `Evidence` object whether it came from a Git commit, a meeting, a document edit, a learning session, or a manual interview. The *product experience* is optimized for technical professionals; the *architecture* assumes nothing about software development.

---

## 4. Personas

### Primary — Technical Knowledge Workers
Evidence arrives through Git, IDEs, terminals, documentation, AI coding sessions, and calendars. High tolerance for CLI. Will notice and judge the security model.

### Secondary #1 — Technical Consultants and Project Professionals
Government contractors, solutions architects, business analysts, technical writers, project managers. Evidence lives in meetings, documentation, SharePoint, email, and project artifacts rather than source code. Frequently under NDA, contract restrictions, or clearance obligations.

### Secondary #2 — Continuous Learners
People investing in certifications, labs, courses, research, books, and personal projects. **CareerForge treats learning as career evidence with the same standing as work accomplishments.**

### Engagement Model

The **Continuous Operator** is the retention model — CareerForge is always on, accumulating quietly, and its value compounds over years.

**Backfill is the acquisition model.** On first run, CareerForge retroactively ingests what is already present on the machine — full Git history across local repos, existing Claude sessions, calendar history, documents — and generates real assets before the user has done any new work.

This makes **retroactive ingestion a core requirement, not a later feature.** Every collector must answer *"how do you replay the past?"*, not just *"how do you watch the present?"* Backfill is the answer to cold start; a sparse database must be visibly full of answerable questions, never visibly empty.

---

## 5. Primary Workflows

### The Core Loop

```
Collectors                    (no AI, no network required)
    ↓
Evidence Store                (local, append-only, provenanced)
    ↓
Search / Timeline / Export    (fully functional with zero AI)
    ↓
AI Enrichment                 (optional, deferred, versioned)
    ↓
Career Assets                 (generated views, never stored facts)
    ↓
Human Review + Edit           (the only approval gate)
    ↓
Style Feedback Loop           (edits teach future generations)
```

### Collection

Collectors have exactly one responsibility: normalize a source into `Evidence` and store it. **Collectors never depend on AI.** They must function offline with no API key.

### Enrichment — Deferred Batch

AI enrichment is a **separate pipeline**, triggered on demand, on a schedule, or immediately before asset generation.

- Enrichment **never modifies original evidence.** It produces linked, additive artifacts.
- Every enrichment is **versioned**. Re-running with a newer model creates a new enrichment; it does not overwrite the prior one unless the user chooses.
- Enrichment output includes: skills, technologies, impact signals, leadership indicators, keywords, relationships, STAR candidates.

### Human Review Gate

**Evidence and enrichment flow automatically. Nothing requires approval merely to exist** — approval-per-item is journaling, which CareerForge is not.

**Human review is required at the asset layer.** Anything leaving CareerForge as a professional artifact — resume bullet, STAR story, performance review summary, LinkedIn post, portfolio entry, cover letter, promotion packet, interview answer — is reviewable and editable before export.

### The Interview Engine

When a stronger claim would be warranted but is not supported by evidence, CareerForge **asks instead of guessing**:

| Instead of asserting | CareerForge asks |
|---|---|
| "Led a cross-functional migration…" | "Did you lead this effort, or contribute to it?" |
| "Reduced deployment time by 40%" | "Do you know approximately how much time this saved?" |
| "Managed a team of five" | "Were other people reporting to you during this project?" |

The user's answer becomes **first-class Evidence** (`user_confirmed`), linked to the relevant work, reusable forever across every future asset. The interview engine is how evidence gaps close over time — the system gets smarter with continued use, and **never asks the same question twice.**

### Evidence Explorer — The Flagship Feature

Every generated claim is clickable and shows what it was built from:

```
Resume Bullet
────────────────────────────────────────────────────
Implemented Microsoft Intune compliance policies
for 50+ users, improving endpoint security.

Supporting Evidence
  ✓ Git commit — Intune policy changes
  ✓ Work journal entry — July 18
  ✓ Outlook meeting — "Endpoint Security Review"
  ✓ User-confirmed metric — "50 managed users"
  ✓ PowerShell script committed

Missing Information
  ? Estimated time savings
  ? Reduction in support tickets
  ? Business outcome
```

**"Missing Information" is interactive** — clicking a gap launches the interview inline. This turns the gap list into the primary engagement loop and is the single most differentiating surface in the product.

The standard CareerForge answers when a user asks *"why did it write this?"*:

> Never: *"The AI thought it sounded better."*
> Always: *"Here is the evidence this statement is based on."*

---

## 6. Privacy Philosophy

### Local-First, Absolutely

CareerForge functions 100% without any CareerForge-operated service: collection, storage, search, local AI, asset generation, analytics, and plugins all work offline.

### The Egress Problem

Local-first protects storage. It does nothing about **egress** — and CareerForge's core function is ingesting work product that is frequently not the user's property. Commit diffs, client names in meeting invites, incident details, internal architecture in AI session transcripts.

For the stated audience this is not hypothetical: a GovCon employee, a security professional handling an active investigation, or anyone under NDA or DLP policy is one careless enrichment run from a career-ending event.

**Therefore:**

- Every source carries a **sensitivity classification**.
- **Nothing leaves the machine without explicit, per-source opt-in.**
- A **deterministic redaction pass** runs before any remote call.
- The user can **preview the exact payload** before it is sent.
- **Sensitive sources default to local models** (Ollama, LM Studio).

This turns a compliance burden into a moat. Every competitor in this space requires uploading your work history to their servers. *"Your career data never leaves machines you control"* is a claim they structurally cannot make.

### Sync — User-Owned Only

Multi-device support is a goal. CareerForge-hosted evidence is not.

CareerForge's responsibility is **synchronizing** data, not **hosting** it. Users choose the destination: Git, private GitHub repos, OneDrive, iCloud Drive, Dropbox, Google Drive, Syncthing, S3-compatible storage, SMB/NAS, or local network shares.

Data is **encrypted before leaving the machine**. **Keys belong to the user, not CareerForge.**

### Future Cloud Services

Optional and additive only. Acceptable: plugin marketplace, community templates, update checking, hosted documentation, model catalogs, opt-in telemetry. **Never: user evidence.**

> CareerForge should never require users to trust us with their professional history.

---

## 7. AI Philosophy

### AI Is a Layer, Not a Foundation

Provider-agnostic by design: OpenAI, Anthropic, Gemini, Azure OpenAI, Ollama, LM Studio, and whatever comes next. The enrichment engine does not care which provider produced a result.

### Strict Provenance

**Every claim generated by AI is traceable to specific evidence.**

The AI may: summarize, organize, rewrite, combine, clarify.
The AI may not: fabricate, exaggerate, speculate.

```
Resume Bullet  →  Git Commit #42, Meeting #17, Journal Entry #108
STAR Story     →  Evidence IDs 14, 22, 35, 41
```

### Metrics — Derive, Ask, Never Invent

Invented metrics are the defining failure of every AI resume tool currently shipping. CareerForge's answer:

**Derived metrics** — computed directly from evidence, always with provenance: repositories contributed to, commits, pull requests, issues resolved, files modified, deployments, incidents responded to, certifications earned, training hours, meetings led, documentation written, policies created, automations built, days on a project, technologies used, collaborators.

**User-confirmed metrics** — for business impact CareerForge cannot know, it asks a targeted question at the moment it is needed and stores the answer as reusable Evidence.

**If a metric cannot be derived or confirmed, CareerForge asks a question rather than generating a number.**

### Evidence Types

The provenance model distinguishes four kinds of record, and this distinction is visible in the UI:

| Type | Meaning |
|---|---|
| `derived` | Computed from other evidence |
| `user_confirmed` | Answered by the human, treated as fact |
| `imported` | Collected from an external source |
| `ai_enrichment` | AI interpretation — a suggestion, not a fact |

### Style Learning

Consistent user edits to generated assets teach CareerForge the user's voice. The learning loop adjusts **generation**, never **evidence**. History is not rewritten to match an edited bullet.

### Design Principle

> CareerForge behaves like a research assistant, not a creative writer. Its goal is to help users present their work accurately — not to embellish it.

---

## 8. Plugin Philosophy

### The Plugin System Is a Contract, Not an Architecture

A small set of first-party integrations lives in-tree and demonstrates each plugin type. The plugin API exists so *others* can extend CareerForge — **not so the core can avoid making decisions.** Projects that make everything pluggable end up with forty half-working integrations and no reason to exist.

### Plugins Are the Attack Surface

A collector has read access to a person's entire professional life, on a tool that also holds AI provider keys and sync credentials. A malicious CareerForge plugin would be an extraordinarily valuable payload, and this audience will notice if it is handled badly.

**The security model is a headline feature, not an implementation detail.**

### Least Privilege by Declared Capability

Every plugin ships a manifest declaring exactly what it requires — specific filesystem paths, specific repositories, specific network hosts, calendar access, email access, scoped evidence read/write, AI provider access, ability to create assets, ability to send data off-device.

- The installer explains these permissions in plain language before approval.
- Permissions are **viewable, revocable, and auditable** after installation.
- Plugins can be restricted to specific repositories or folders.
- Recent plugin activity is inspectable.

### Out-of-Process Execution

Third-party plugins run in isolated processes and communicate over a defined protocol. **They never touch the database or the filesystem directly.** They request operations, and the core is the policy enforcement point:

> *"Give me Git evidence for Repository X." · "Store this Evidence object." · "Request AI enrichment." · "Request export."*

### Scoped Evidence Access

A Git collector does not need Outlook evidence. A resume exporter does not need Teams messages. Access is scoped wherever possible.

### Declared Egress

Any plugin capable of transmitting data off-device must declare it. Users see the destination, the reason, and the categories of data involved. The policy engine enforces privacy rules **before** any outbound transmission, regardless of what the plugin requests.

### Plugin Types

**Stable public APIs at 1.0 — three, deliberately:**

1. **Collectors** — sources → Evidence
2. **AI Providers** — enrichment backends
3. **Exporters / Renderers** — assets → output formats

**Reserved categories** (namespaced, not shipped contracts): Sync Providers, Search Providers, UI Extensions, Automation Plugins.

Sync is deliberately excluded from the initial plugin surface. Sync is the hardest correctness problem in the project; it will be solved once, well, before it is made swappable.

Each category exposes only the APIs it actually needs.

---

## 9. Business Model and License

### License: Apache 2.0

Chosen for explicit patent grant, enterprise familiarity, minimal friction for plugin authors, and low barriers to both individual and corporate contribution. Licensing uncertainty must never discourage participation.

The **name and branding are protected by trademark policy**, not by restrictive software licensing. People may build freely on the platform; they may not misrepresent an unofficial fork as official CareerForge.

### The Moat Is Architectural, Not Legal

Local-first, privacy-first, user-owned data, evidence provenance, transparent AI, and a strong plugin security model are far harder to replicate than source code. A hosted fork is not a threat worth designing against.

### Money

**The core application is free and open source, permanently.**

- No feature in the local application requires a subscription.
- No open core. The best functionality is never proprietary.
- No artificial limits designed to drive upgrades.
- No user evidence on CareerForge servers, at any price.

**If revenue ever exists, it funds maintenance through optional services that make CareerForge easier to use — never more capable:** hosted documentation, plugin marketplace infrastructure, verified plugin signing, update infrastructure, enterprise support and SLAs, training and consulting, deployment assistance, an optional managed AI gateway, premium community templates, sponsorship and donations.

### Sustainability — Stated Honestly

The realistic failure mode for this project is not bad architecture. It is a successful project with one exhausted maintainer, hundreds of open issues, and a Reddit thread asking whether it is dead.

CareerForge acknowledges this rather than pretending otherwise. Governance is BDFL now — correct at this stage, where speed matters more than process — with **written succession triggers**: at a defined number of regular contributors, maintainers with merge rights are added; after a defined period of maintainer inactivity, named successors or the community may continue the work under the trademark policy.

---

## 10. Open Source Strategy

### Curated Core, Tiered Ecosystem

The main repository contains only integrations that are fundamental to the product experience and serve as **reference implementations** of each plugin type.

**In-tree collectors:** Git · Local Filesystem/Documents · Manual Interview · Calendar (Outlook/ICS) · AI Coding Sessions (Claude Code adapter)
**In-tree AI providers:** OpenAI · Anthropic · Ollama · LM Studio
**In-tree exporters:** Markdown · PDF · DOCX · JSON Resume

Everything else — Jira, GitLab, Azure DevOps, Notion, Obsidian, ServiceNow, SharePoint, Google Workspace, Slack, Teams, Linear, Asana — lives in its own repository and evolves independently.

### Official Plugin Index

Users must not have to hunt through GitHub. The index publishes: name, type, version, supported API version, last tested version, last release date, maintainers, verification status, license, source repository, documentation, and compatibility status.

**Trust tiers — these communicate maintenance status and trust, never capability:**

| Tier | Meaning |
|---|---|
| **Core** | Ships with CareerForge |
| **Official** | Maintained under the CareerForge organization |
| **Verified** | Community-maintained, reviewed against quality and security standards |
| **Community** | Public, no official review |
| **Archived** | No longer maintained, still discoverable |

> The goal is not "the repository with 150 integrations." It is **"the platform with an outstanding ecosystem."**

Every integration should feel first-class regardless of where it lives.

### Contributor Experience

**A contributor must not need to understand the entire CareerForge codebase to write a collector.** This is the measurable test of whether the plugin API is good.

### Community Foundations

At launch: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (a private disclosure path must exist *before* there are users), `TRADEMARK.md`, and an architectural decision log with rationale.

Formal governance and maintainer guidelines are written when a second maintainer exists — derived from what actually happened, not from an imagined organization.

---

## 11. Roadmap

### Milestone 0 — Proof of Thesis

**Goal:** someone installs CareerForge, uses it for fifteen minutes, and immediately understands why it is different.

**Inputs:** Git collector · AI Coding Session collector (Claude Code adapter) · Manual Interview
**Processing:** normalize to Evidence · store locally · enrich via OpenAI · maintain provenance
**Output:** one evidence-backed resume bullet, plus Evidence Explorer

The entire demo:

```bash
careerforge collect
careerforge enrich
careerforge generate resume-bullet
careerforge ui
```

The browser opens to a generated bullet with Evidence Explorer showing exactly what supports it, what was inferred, what is missing, and which questions would strengthen it.

**Success criterion:** users say *"I've never seen anything like this."*

**Explicitly deferred** — anticipated by the architecture, not implemented: additional collectors, additional AI providers, plugin runtime and sandbox, capability system, redaction policies, sync, additional exporters, analytics, dashboards, enterprise governance, plugin registry.

### The Constraint on Deferral

Three things must be designed as though the deferred features already exist, because they are the only ones that cannot be changed cheaply later:

1. **The Evidence schema**
2. **The collector interface**
3. **The provenance model**

Everything else may be naive at first.

### Beyond Proof of Thesis

Sequencing is driven by real user feedback, not by this document. Expected order of pressure: additional collectors → additional AI providers → exporters → plugin protocol and sandbox → redaction and policy engine → sync → analytics.

---

## 12. Technical Constraints

### Core: TypeScript

Chosen because CareerForge's primary value is user experience — Evidence Explorer, timeline, search, interview workflow, provenance visualization, plugin management — and because it offers the largest contributor pool, strong AI SDK support, and alignment with modern frontend tooling and a future Tauri shell.

### Ecosystem: Language-Agnostic

**The core plugin API is not tied to Node.js.** Plugins communicate over a stable protocol (JSON-RPC over stdio). Collectors may be written in TypeScript, Python, Go, Rust, C#, Java, or anything that speaks the protocol.

> **The platform is TypeScript. The ecosystem is language-agnostic.**

Clear separation is maintained between **core application**, **plugin runtime**, and **plugin protocol**. The protocol is among the most stable contracts in the project.

### Heavy AI Work

If advanced local processing is ever needed, it is solved with specialized worker processes — never by changing the application's primary language.

```
CareerForge (TypeScript) → JSON-RPC → Python enrichment worker
CareerForge              → Ollama   → local model
```

The UI and platform never become tightly coupled to an AI implementation.

### Interfaces — One Application, Two Surfaces

**CLI** for workflows and automation. Collection should feel like infrastructure, not an app someone clicks through daily. Scriptable, cron- and Task Scheduler-friendly, Git-hook and CI compatible, easy to debug.

**Local web UI** for exploration and review. Provenance is inherently visual; Evidence Explorer cannot be communicated in terminal output and cannot produce the screenshot that sells the project.

Both surfaces use the same core APIs and data model. A desktop application (likely Tauri) remains on the long-term roadmap as **packaging and UX enhancement, never a prerequisite.**

> **Build the platform first. Package it later.**

### Storage

Local, durable, queryable, and **append-only**. Evidence is never mutated in place: a user "edit" writes a **correction record** that supersedes the original; a "delete" writes a **tombstone** that suppresses it everywhere. Enrichments and assets reference evidence IDs, so in-place mutation would silently invalidate everything downstream.

**Canonical model — resolved 2026-07-30, see `docs/PreArchitecture-Findings.md` Part 2:**

- **SQLite is the single source of truth.** Provenance is a graph, append-only semantics require transactions, and analytics require aggregation. One canonical store, not three.
- **A versioned JSON export tree is the durable representation** — human-readable, diffable, Git-friendly, and the unit of sync. Its format is versioned separately from the database schema and is deliberately far more stable.
- **Markdown is an output format, never storage.** Assets are generated views; rendering them is an exporter's job.
- **`careerforge rebuild` reconstructs the database from the JSON export.** This guarantee is what makes SQLite an index rather than a jail — if the database is ever lost or abandoned, no career history is.
- **Sync operates on the JSON export, never the live database file.** Syncing SQLite across cloud storage corrupts it, and binary files do not merge.
- **Evidence stores content hashes, source references, and extracted excerpts — never bulk raw payloads.** One measured source alone produces ~4 GB/year.

Migrations are forward-only, numbered, transactional, preceded by an automatic backup, and covered by a test that migrates a real fixture database from the prior version. **A migration that cannot be performed automatically halts and explains itself — never silent, never lossy.**

---

## 13. Stretch Goals

**These are architectural north stars, not commitments.** Their purpose is to prevent decisions today that foreclose them tomorrow. They are destinations, not milestones, and appear on no timeline.

### Career Analytics
Built entirely from evidence and enrichments — never manual tracking. Eventually answering: which technologies am I actually using? Which skills are growing? Which have gone dormant? Which accomplishments am I repeating? What evidence do I lack for the jobs I want?

### Multi-Party Evidence
Peer attestations, manager confirmations, mentor feedback, professional references. **No collaboration or cloud features are planned early** — but Evidence must be attributable to multiple identities so the data model never needs redesign. This is the hardest thing to retrofit, touching identity, access control, encryption, and provenance simultaneously. Naming it now costs nothing; discovering it in year three costs a rewrite.

### Job-Target Tailoring
Map a real job description against existing evidence: highlight genuine strengths, identify real gaps, ask targeted follow-up questions, generate tailored assets that remain fully evidence-backed. **Never keyword stuffing.** The goal is better communication, not exaggeration.

### Interview Practice
Generate behavioral questions the user can actually answer with confidence, each linked to real evidence, optionally producing multiple evidence-backed STAR stories. Reinforces the core philosophy: CareerForge helps users recall and communicate what they actually did.

---

## 14. What 1.0 Means

**1.0 is a compatibility promise, not a feature count.**

At 1.0:

- The **Evidence schema is stable.**
- **Automatic migrations are part of the platform.** Every schema change has a documented migration path. A migration that cannot be performed automatically **never happens silently.**
- The **plugin protocol is stable under semantic versioning**, with published compatibility guarantees.
- Compatibility policies are documented.
- Users can confidently invest years of career history.
- Plugin authors can confidently build against the public APIs.

Before 1.0, the plugin protocol is explicitly unstable, clearly versioned, with breaking changes documented. **User data compatibility is treated as the higher priority throughout** — it stabilizes first and is protected hardest.

> **Features can evolve. User data must endure.**

---

## 15. Open Questions — Deferred to Architecture

Recorded so they are decided deliberately rather than by accident.

### Resolved

1. ~~**Canonical storage.**~~ **RESOLVED 2026-07-30** — SQLite canonical, versioned JSON export durable, Markdown output only. See §12 and `docs/PreArchitecture-Findings.md` Part 2.
2. ~~**Claude Session collector feasibility.**~~ **RESOLVED 2026-07-30** — Verified against 1,219 real sessions / 75,311 records / 328 MB. Viable and confirmed as the strongest differentiator: transcripts preserve the *problem statement, approach, and reasoning* that `git log` discards, mapping almost directly onto STAR. Approved for Proof of Thesis, renamed **AI Coding Session collector** (Claude Code is the first adapter, not the concept), with three mandatory constraints — tolerant parsing, Work Unit grouping, and maximum sensitivity classification. See `docs/PreArchitecture-Findings.md` Part 1.
3. ~~**Repository placement.**~~ **RESOLVED 2026-07-31** — CareerForge lives in its own public repository. An organization is deferred until there is a second maintainer; moving a repository into one preserves history and redirects, so the cost of waiting is zero.

### Still open

**#4 is the most important unsolved problem in the project.** It is the gap between the
audience this document names and the audience the shipped product actually serves.

4. **Outcome-shaped evidence for non-developers.** A detection engineer's best work is a tuned rule that prevented an incident; a sysadmin's is a migration nobody noticed. Neither appears meaningfully in `git log`, and a calendar entry reading "Change Advisory Board" is noise. At least one collector must capture **outcome-shaped** rather than **activity-shaped** evidence, or half the stated v1 audience gets an empty app. *Unchanged by the investigation — the Proof of Thesis still proves the thesis only for developers.*
5. **Redaction determinism.** "Deterministic redaction" is a strong promise. What is actually detectable without AI, and what residual risk is disclosed honestly? *Priority raised: session transcripts routinely contain pasted credentials, uncommitted file contents, client names, and production identifiers — a far more sensitive payload than originally assumed.*

### New architectural requirements produced by the investigation

- **Work Unit grouping.** Over 90% of session files are sub-minute fragments; only ~8% represent substantive work. The Evidence model must support a collector-defined grouping key so many source artifacts roll up into one unit of work. Git needs this too (many commits → one feature).
- **Tolerant parsing as a platform contract.** 12+ schema versions were observed in a single 30-day window. Every collector declares a narrow required field set and silently ignores unknown types, fields, and versions. A platform rule, not a per-collector choice.
- **Reference-and-excerpt storage.** Evidence stores content hashes, source references, and excerpts — never bulk raw payloads.
- **Per-project consent granularity.** Sensitivity scoping must reach below the source level to individual projects and directories, so a user can enable personal work and exclude client work.
- **`careerforge rebuild`.** Reconstruct the canonical database from the JSON export — a first-class command and the guarantee that makes SQLite safe.

---

## 16. Non-Goals

- A daily writing habit or journaling workflow.
- A CareerForge-hosted store of user evidence.
- Features gated behind payment.
- Impressive-sounding output that outruns the evidence.
- Broad profession coverage achieved through per-profession special cases.
- Being the repository with the most integrations.

---

## Status

This document was approved on 2026-07-30 and is **frozen**. Architecture followed from it;
implementation followed from that. Where implementation revealed a flaw, an
[ADR](adr/) records the correction and this document was amended to match — see
[ADR-0029](adr/0029-positioning-is-an-evidence-engine.md) for a worked example of exactly
that happening.

**If something here looks wrong to you, say so.** A decision that cannot survive scrutiny
should not survive, and there is an [issue template](https://github.com/edwardjgriggs/careerforge/issues/new?template=challenge_a_decision.yml)
for arguing with one.
