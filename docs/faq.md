# Questions people actually ask

## Do I need an AI coding assistant for this to be useful?

**No.** Git alone is a complete source. Commits carry what changed, when it actually
happened, which branch and repository it belonged to, who else touched it, and how much
moved — enough to group work into units and to support `action` and `scope` claims.

AI coding session transcripts add the thing `git log` throws away: the problem you were
solving and why you chose that approach. That is the STAR *Situation*, and it is the first
thing anyone forgets. If you use Claude Code, CareerForge reads those transcripts. If you do
not, nothing breaks and nothing asks you to.

## Do I need an API key?

Only for `generate` and `enrich`. Everything else — collection, grouping, search, timeline,
the provenance graph, `explain`, the interview, Evidence Explorer, export, rebuild — runs
with no key and no network.

This is enforced by the build rather than promised: a CI job runs the entire test suite with
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY` set to empty. See
[ADR-0005](adr/0005-ai-is-additive.md).

## Which model does it use, and what does it cost?

OpenAI is the only provider implemented today. A résumé bullet sends one bounded work unit —
excerpts, not whole transcripts — so a single generation is a small number of thousands of
tokens, which is fractions of a cent at current prices. Enrichment operates on work units
rather than your whole corpus for exactly this reason: whole-corpus enrichment would be both
expensive and privacy-hostile.

Run `careerforge preview --unit <id> --provider openai` to see the literal payload before
anything is sent. That is the honest answer to "what will this cost" — you can read it.

**Local models (Ollama, LM Studio) are on the roadmap and are not implemented yet.** When
they land, sensitive sources default to them.

## How long does the backfill take on a lot of history?

Collection is a read of your local Git history and your local transcript directory. It is
bounded by disk, not by network, because there is no network. A large corpus was measured at
1,219 session files / 75,311 records / 328 MB in a 30-day window with zero parse failures
(see [PreArchitecture-Findings.md](PreArchitecture-Findings.md)); reading it is a matter of
minutes, not hours.

Evidence stores content hashes, source references, and bounded excerpts — never bulk raw
payloads — so the store does not grow with the size of your repositories. One measured
source alone would otherwise produce roughly 4 GB/year.

Collection is also idempotent and resumable. Re-running it is a no-op for anything
unchanged, and an interrupted run resumes without gaps or duplicates.

## Does it modify my repositories or my transcripts?

No. Collection is a read. Collectors are structurally incapable of writing anywhere —
`CollectorPort` has no store handle and no filesystem write path; they emit records and the
core decides what to persist (invariant I6).

## Can I exclude a repository or a project?

Sensitivity and consent are scoped per project, which is the mechanism that matters: nothing
reaches a provider unless you have granted that provider that project at that sensitivity
level, and there is deliberately no global "allow everything" switch.

```bash
careerforge consent grant --provider openai --project my-repo --level confidential
```

Collection-time exclusion filters are not yet a first-class flag. If you need one, that is a
good issue to open — the scoping model already supports it and it is a small change.

## What about monorepos, worktrees, and bare repositories?

Monorepos work; `project_key` and `stream` come from the repository and branch, so a
monorepo groups as one project. Bare repositories and linked worktrees are **not** specially
handled yet and are a known gap — an open issue and a good first contribution.

## Does it work on Windows?

Yes, and it is tested there on every commit. Windows is a first-class entry in the CI matrix
alongside Linux and macOS, and the guided tour is walked end to end on all three. It is the
primary development platform for this project, which is unusual and deliberate.

WSL works too — it is Linux from CareerForge's point of view. Note that a WSL install and a
Windows install have separate `~/.careerforge` directories and separate transcript
directories; they will not see each other's evidence.

## Where does my data live, and how do I get rid of it?

`~/.careerforge/`, or wherever `CAREERFORGE_HOME` points. One directory: the SQLite store,
the JSON export, blobs, backups, and config.

Deleting that directory deletes everything CareerForge knows. There is no account to close,
no server to contact, and no residue anywhere else on your system.

## What if I want to leave?

`careerforge export` writes a plain JSON tree — one file per record, sorted keys, partitioned
by date. You can read it, diff it, grep it, and put it in Git. `careerforge rebuild`
reconstructs the database from it, and a round-trip test asserts the fidelity of that in CI.

The database is an index, not a jail.

## Can it fabricate something anyway?

The mechanism is a hard failure at generation time, not a prompt instruction: a claim with
zero supporting provenance edges is refused rather than emitted (invariant I4), and `role`
and `metric` claims additionally require user-confirmed or computed support — never
inference.

What a model *can* still influence is wording. It chooses how a supported claim is phrased.
If you find a case where phrasing carried an assertion its support does not justify, that is
the most important bug class in the project and there is
[an issue template for it](https://github.com/edwardjgriggs/careerforge/issues/new?template=it_claimed_something_it_should_not_have.yml).

## Is redaction going to protect me from sending something I shouldn't?

Partly, and the honest answer matters more than the reassuring one.

Deterministic pattern redaction removes API keys, tokens, connection strings, private keys,
and authorization headers. It is tested against 21 credential cases that must never survive
and 15 ordinary code samples that must survive byte-identical.

**It cannot catch a client's name in a sentence, a frank opinion about a colleague, or an
unreleased product mentioned in passing.** That is why the payload preview is mandatory
rather than advisory, and why the preview says this every single time it runs. See
[the privacy model](privacy.md).

## Is there a hosted version?

No, and there will not be one that stores your evidence. Optional hosted services are
acceptable in future for things like a plugin index or documentation. User evidence on a
CareerForge-operated server is a permanent non-goal.

## Is this abandoned? It is one person.

It is one person alongside a full-time job, and [SECURITY.md](../SECURITY.md) says so
plainly rather than implying a team. The realistic failure mode for this project is a
maintainer running out of energy, not bad architecture, and pretending otherwise would be
the first dishonest thing in the repository.

What reduces that risk: the license is Apache 2.0, the durable copy of your data is plain
JSON you own, the plugin protocol is designed to be implemented by people who are not us,
and governance has written succession triggers ([Vision §9](Vision.md)). If you want to
help, [contributing](../CONTRIBUTING.md) is the answer, and arguing with a decision counts.
