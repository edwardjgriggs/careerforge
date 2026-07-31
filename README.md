# CareerForge

**An AI-powered Career Intelligence Platform. Local-first, privacy-first, evidence-backed.**

CareerForge automatically collects evidence of your work, enriches it with AI, and turns it into
career assets — resume bullets, STAR stories, portfolio entries, interview answers, performance
review material, and career analytics.

**It is not a journaling app.** You should not have to write down what you did. You already did
it, and the record already exists.

---

> ### Status: pre-alpha — M11 of 13
>
> **`careerforge ui` opens a screen that answers two questions.**
>
> _Why does CareerForge believe this?_ Every claim in a generated bullet is
> marked and selectable, and selecting one shows the records behind it — each
> labelled as something a collector observed, something CareerForge computed,
> something you said in an interview, or a model's interpretation, which is
> shown separately and never counts as a reason to believe anything.
>
> _What evidence would make it stronger?_ The other half of the screen ranks
> what you could do about it, and each option says what it would be worth:
>
> ```
> Confirm what your role was              Observed → Corroborated
>   Your answer becomes evidence you stand behind, which is the only
>   thing that can support a role claim.
>   > What was your role in this work? Did you lead it, or contribute to it?
>   [                                                            ]
>   [ Record this as evidence ]
>
> Record what changed because of this work    Observed → Corroborated
>   No collector in this build observes outcomes — Git records commits and
>   sessions record conversations, and neither sees what changed afterwards.
>   Answering it yourself is the only route today.
> ```
>
> Answering a question there writes evidence and the page updates. It does
> **not** claim your bullet got better: the words still rest on the records they
> were generated from, so the Explorer says your answer is not in the statement
> yet and offers to regenerate. A grade that rose above unchanged text would be
> a lie about what you are looking at.
>
> **It binds to 127.0.0.1, and there is no option to change that.** Nothing is
> fetched from anywhere: no CDN, no framework, no fonts. The whole page is one
> document served from your machine.
>
> **Everything on that screen works with no API key.** Only generating a new
> statement needs one.
>
> **Left for M12:** CLI polish, packaging, and the first release.
>
> Working today: `ui` · `collect` · `group` · `units` · `generate` · `review` ·
> `assets` · `explain` · `interview` · `enrich` · `interpretations` · `consent` ·
> `preview` · `init` · `doctor` · `search` · `timeline` · `export` · `rebuild` ·
> `reindex`
>
> This section will always tell you the truth about what works. See
> [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for what lands when.

---

## The idea

Every AI resume tool has the same problem: it writes confident sentences about work it cannot
see. Ask where _"reduced deployment time by 40%"_ came from and the honest answer is that a
language model produced a plausible number.

CareerForge answers differently. Every claim it generates is traceable to evidence you can
inspect:

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

When CareerForge lacks the evidence for a stronger claim, **it asks instead of guessing.** Your
answer becomes evidence too, reusable in everything it writes afterward.

## What makes it different

**It will not invent your accomplishments.** Generation refuses to emit a claim with no
supporting evidence. Claims about leadership and metrics — the two that end careers when
fabricated — require evidence you confirmed or evidence that can be computed. Never inference.

**Your data never leaves machines you control.** No CareerForge server holds your evidence. Ever.
Sensitivity is classified per source _and per project_, consent is explicit and revocable, and a
deterministic redaction pass runs before anything reaches a provider — with a preview of the
exact payload. Sensitive work defaults to local models.

**AI is optional.** Collection, storage, search, timelines, and export work with no API key and
no network. This is enforced by the build: the domain layer cannot import an AI SDK.

**It reads your AI coding sessions.** `git log` records what changed and discards _what problem
you were solving and why you chose that approach_ — which is exactly what a STAR story needs and
the first thing anyone forgets. Session transcripts keep it.

**Your history endures.** Evidence is append-only. Enrichments are versioned, never overwritten.
The database is reconstructible from a plain JSON export you can read, diff, and grep.

## The demo (once M12 lands)

```bash
careerforge collect              # git history + AI coding sessions
careerforge group                # artifacts -> units of work
careerforge enrich               # optional; needs a key
careerforge generate resume-bullet
careerforge ui                   # Evidence Explorer in your browser
```

## Building from source

```bash
git clone https://github.com/edwardjgriggs/careerforge
cd careerforge
npm install
npm run verify
node packages/cli/dist/bin.js doctor
```

Requires **Node.js 22+**. No API key needed to build, test, or contribute.

## Documentation

| Document                                                             | What it covers                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| [Vision.md](Vision.md)                                               | What CareerForge is, who it serves, what it refuses to do   |
| [Architecture.md](Architecture.md)                                   | How it works, ordered by permanence                         |
| [docs/adr/](docs/adr/)                                               | Why each major decision was made — and what would change it |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)                     | The 13 milestones to a working Proof of Thesis              |
| [docs/PreArchitecture-Findings.md](docs/PreArchitecture-Findings.md) | Measurements that shaped the design                         |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). **A contributor should not need to understand the whole
codebase to write a collector** — if you do, that is a bug in our API and we want to hear about
it.

Once the plugin protocol lands, collectors can be written in any language that speaks JSON-RPC
over stdio. The protocol is the platform; TypeScript is just what the core happens to be.

**The plugin protocol is unstable until 1.0.** At 1.0 the Evidence schema and the plugin protocol
are frozen under semver — 1.0 is a compatibility promise, not a feature count.

Security issues: [SECURITY.md](SECURITY.md), never the issue tracker.

## License

[Apache 2.0](LICENSE). The name is protected by [trademark policy](TRADEMARK.md) rather than by
restricting the software — build on it freely, just do not claim to be us.
