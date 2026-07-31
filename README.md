<div align="center">

# CareerForge

### It refuses to invent your accomplishments.

**A local-first evidence engine for professional work.** It collects what you actually did,
and refuses to claim anything the evidence cannot support.

[![CI](https://github.com/edwardjgriggs/careerforge/actions/workflows/ci.yml/badge.svg)](https://github.com/edwardjgriggs/careerforge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-5FA04E.svg)](docs/install.md)
[![API key](https://img.shields.io/badge/API%20key-not%20required-7aa2f7.svg)](docs/adr/0005-ai-is-additive.md)

<img src="docs/assets/refusal.svg" alt="A model proposes four claims about a piece of work. Three are refused for want of evidence, each naming the question that would change the answer." width="640">

_A model proposed four claims about one piece of work. Three of them are gone — not
softened, **gone** — and each one names the question that would change the answer._

</div>

---

## The problem

Every AI résumé tool has the same problem: it writes confident sentences about work it
cannot see. Ask where _"reduced deployment time by 40%"_ came from and the honest answer is
that a language model produced a plausible number.

CareerForge works the other way around. It collects evidence of work you have already done,
groups it into units of work you would recognise, and generates career assets — résumé
bullets, STAR stories, interview answers — where **every claim cites the records behind
it.** When the evidence will not carry a stronger claim, it asks instead of guessing, and
your answer becomes evidence too, reusable in everything it writes afterwards.

**It is not a journaling app.** You should not have to write down what you did. You already
did it, and the record already exists.

## Try it

```bash
npm install -g careerforge
careerforge tour
```

No API key, no network, no account, and it touches nothing of yours — the tour builds its
own sample store and never opens yours. It runs the real commands and, after each step,
says _why_ the system works that way.

> The tour is not a recording. Every step calls the same command function the CLI calls,
> and CI walks the whole thing end to end on Linux, macOS, and Windows on every commit. A
> demonstration that cannot fail is a marketing asset, not a demonstration — if the tour
> works, the product works.

## What it refuses to do

This is step two of the tour, verbatim. A model was asked for a résumé bullet and proposed
four assertions: what was done, that the person led it, a percentage, and an outcome.

```
Rebuilt the nightly export to run incrementally.

Every part of that, and what stands behind it:

  action   Rebuilt the nightly export to run incrementally
           cites 3 records, from git and from a coding session

Left out — the evidence does not carry them:

  role     "led the redesign of the export pipeline"
           Leadership and responsibility cannot be inferred from activity.
           -> What was your role in this work? Did you lead it?

  metric   "cutting export time by 80%"
           Numbers must be computed from evidence or confirmed by you.
           -> Did this work produce a measurable result you can quote?

  outcome  "eliminating the nightly timeout alerts"
           The evidence records the work, not what came of it.
           -> What actually changed as a result of this work?

Evidence: corroborated — 3 records from 2 source(s)
  Left out for want of evidence: metric, outcome, role.
```

Three of four claims were **removed rather than softened.** There is no code path from a
refused claim to weaker wording, which is how _"led the redesign"_ avoids quietly becoming
_"helped lead the redesign"_.

`role` and `metric` claims — the two that end careers when fabricated — require evidence
you confirmed or evidence that can be computed. Never inference. An `outcome` must be
observed, never inferred from the work that caused it.

**Because it refuses, what it does say survives being asked about.** That is the whole
trade: fewer sentences, each of which you can defend in an interview.

## Why evidence comes before interpretation

Evidence is what a collector saw. Interpretation is what a model made of it. They are
different kinds of thing, they are stored in different tables, and AI output may never
occupy an Evidence row.

That separation is what makes the question _"why does it believe this?"_ answerable:

```bash
careerforge explain <claim-id>
```

Every claim carries its own support, labelled by how it was obtained — observed by a
collector, stated by you in an interview, or derived. `careerforge ui` opens the same thing
in a browser as two columns: on the left, why CareerForge believes a statement; on the
right, the questions whose answers would make it stronger.

## Why AI is optional

Collection, storage, search, timelines, the provenance graph, and export all work with no
API key and no network. This is not a promise in a README — it is enforced by the build:

- The `domain` package cannot import a provider SDK. It cannot even see Node's types.
- Exactly one package, `policy`, may hold a network client. Importing an HTTP client
  anywhere else fails lint, and a boundary test asserts it.
- A CI job runs the entire suite with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and
  `GOOGLE_API_KEY` set to empty, so "AI is never required" is a test rather than a slogan.

Generating a résumé bullet from a remote model needs a key. Everything else does not.

## Why privacy is architecture, not a promise

There is no CareerForge server. No account, no telemetry, no sync destination. Your
evidence lives in one directory on your machine and nowhere else.

- **Sensitivity is classified per source _and per project_.** Client work and personal
  projects are not the same risk, and CareerForge does not treat them as one.
- **Consent is explicit, scoped, and revocable.** Granted per provider and per project.
  There is deliberately no global switch.
- **Nothing leaves without a preview of the exact bytes.** `careerforge preview` shows the
  literal payload, and it shows it even when the answer is refused — because seeing what
  would leave is how you decide whether to allow it.
- **Every refusal names its remedy.** A block tells you the rule that stopped it and the
  command that would change the answer.

And the honest part: deterministic redaction catches keys, tokens, and connection strings.
**It does not catch a client's name in a sentence, or an opinion about a colleague.** That
limitation is why the payload preview is mandatory rather than advisory. See
[docs/privacy.md](docs/privacy.md), which names what the design cannot do as plainly as
what it can.

## It reads what `git log` throws away

`git log` records what changed and discards _what problem you were solving and why you
chose that approach_ — which is exactly what a STAR story needs and the first thing anyone
forgets. AI coding session transcripts keep it, and CareerForge reads them.

> **Those transcripts expire.** Claude Code deletes them after 30 days by default. The
> record of what you were thinking while you worked is already disappearing, which makes
> the backfill preservation rather than convenience.

## How it fits together

| Stage        | What happens                                                               |
| ------------ | -------------------------------------------------------------------------- |
| **Collect**  | Collectors emit Evidence. Append-only, immutable, factual.                 |
| **Group**    | Artifacts become Work Units — the size at which people describe work.      |
| **Enrich**   | Optional. A model interprets, cites its inputs, and never writes Evidence. |
| **Generate** | Claims are proposed, checked against provenance, and refused or kept.      |
| **Review**   | Nothing exports until you have read it and accepted it.                    |

Storage is SQLite, but the durable copy is a plain JSON export you can read, diff, and
grep — `careerforge rebuild` reconstructs the database from it. Leaving is always possible,
which is the only version of data ownership that means anything.

## Status: 0.1.0, and honest about it

**Working today:** collection from Git and AI coding sessions, grouping into units of work,
generation with every claim checked, the interview, the provenance graph, the egress gate,
Evidence Explorer, and the guided tour. 953 tests, on three operating systems, on every
commit.

**Not built yet:** out-of-process plugins, sync, analytics, a desktop shell. Each has a
seam already in place and needs no schema migration to add.

**`@careerforge/protocol` is unstable** and will change without a major version bump until
1.0. Everything else follows semver from 0.1.0. At 1.0 the Evidence schema and the plugin
protocol freeze — 1.0 is a compatibility promise, not a feature count.

This section will always tell you the truth about what works.

## Install

```bash
npm install -g careerforge
careerforge doctor
```

Requires **Node.js 22 or newer**. Release tarballs and checksums are on the releases page,
and every package is published with npm provenance, so you can check that what you
installed was built from the commit you can read. See [docs/install.md](docs/install.md).

Everything lives in `~/.careerforge` (or `CAREERFORGE_HOME`). Deleting that directory
deletes everything CareerForge knows. There is nothing left anywhere else.

## Documentation

|                                                    |                                                       |
| -------------------------------------------------- | ----------------------------------------------------- |
| [Installing](docs/install.md)                      | Requirements, checksums, where files live             |
| [First run](docs/first-run.md)                     | The tour, then your own work                          |
| [The privacy model](docs/privacy.md)               | What happens to your data, and which code enforces it |
| [Writing a collector](docs/writing-a-collector.md) | The main extension point                              |
| [Architecture](docs/Architecture.md)               | How it works, ordered by permanence                   |
| [Vision](docs/Vision.md)                           | What it is, who it serves, what it refuses to do      |
| [Architecture decisions](docs/adr/)                | 29 ADRs, each with what would overturn it             |
| [Roadmap](docs/IMPLEMENTATION_PLAN.md)             | The milestones, and what lands when                   |
| [Measurements](docs/PreArchitecture-Findings.md)   | The numbers that shaped the design                    |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). **A contributor should not need to understand the
whole codebase to write a collector** — if you do, that is a bug in our API and we want to
hear about it.

Every major decision has an ADR with a **"Revisit if"** section, because a decision without
stated falsification conditions is a belief. If one of them looks wrong to you, saying so is
a contribution — a decision that cannot survive scrutiny should not survive.

Security issues: [SECURITY.md](SECURITY.md), never the issue tracker.

## License

[Apache 2.0](LICENSE). The name is protected by [trademark policy](TRADEMARK.md) rather than
by restricting the software — build on it freely, just do not claim to be us.
