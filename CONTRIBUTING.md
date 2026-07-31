# Contributing to CareerForge

Thank you for considering it. This document covers what you need to be productive quickly, and
the handful of rules that are not negotiable.

## Quick start

```bash
git clone https://github.com/edwardjgriggs/careerforge
cd careerforge
npm install
npm run verify        # format check, lint, build, typecheck tests, test
node packages/cli/dist/bin.js doctor
```

Requires **Node.js 22 or newer**. No API key is required to build, test, or contribute —
and that is deliberate (see ADR-0005).

### Scripts

| Command              | What it does                                   |
| -------------------- | ---------------------------------------------- |
| `npm run build`      | Compile all packages                           |
| `npm test`           | Run the suite                                  |
| `npm run test:watch` | Watch mode                                     |
| `npm run lint`       | ESLint, including architectural boundary rules |
| `npm run format`     | Prettier                                       |
| `npm run typecheck`  | Typecheck sources and tests                    |
| `npm run verify`     | Everything CI runs                             |

## Read this first

Three documents explain why CareerForge is built the way it is:

- **[docs/Vision.md](docs/Vision.md)** — what the product is and is not. **Frozen.**
- **[docs/Architecture.md](docs/Architecture.md)** — how it works. **Frozen.**
- **[docs/adr/](docs/adr/)** — why each major decision was made, and what would change it.

If a design choice looks wrong, there is very likely an ADR explaining it — including the
alternatives that were considered and rejected. Please read it before proposing a change. If it
is still wrong after reading, **say so**; a decision that cannot survive scrutiny should not
survive.

## The rules that are not negotiable

These are enforced by CI, not by reviewer patience.

**1. Evidence is factual. AI interprets. Humans approve professional claims.**
AI output may never occupy an Evidence row. See ADR-0002.

**2. The domain layer stays pure.** No I/O, no network, no AI SDK, no sibling packages.
Enforced by lint _and_ by the type system — `domain` cannot even see Node's types. See ADR-0005.

**3. Only `policy` reaches the network.** Every outbound call passes through the Policy Engine.
Importing an HTTP client anywhere else fails the build. See ADR-0009.

**4. Nothing is mutated.** No `UPDATE`, no `DELETE`. Corrections supersede; deletions tombstone.
See ADR-0001.

**5. Collectors parse tolerantly.** Declare the narrow field set you need; skip and count
everything else. Never throw on an unknown record. See ADR-0010.

**6. No claim without support.** Generation refuses to emit an assertion with no provenance.
`role` and `metric` claims require user-confirmed or derived support — never inference.
See ADR-0007.

## Changing the architecture

Vision and Architecture are frozen. That does not mean they are correct forever.

**If implementation reveals a flaw, stop and write an ADR.** Do not quietly diverge. A new ADR
supersedes the old decision, the frozen documents are corrected to match, and the reasoning is
preserved. Discovering that the architecture is wrong is a _success_ of this process.

Copy the shape of an existing ADR. Every one needs a **"Revisit if"** section — a decision
without stated falsification conditions is a belief.

## Pull requests

1. **Open an issue first** for anything beyond a bug fix or docs change. It is kinder than a
   rejected PR after a weekend of work.
2. **One concern per PR.** Easier to review, easier to revert.
3. **Tests with the change, not after.** Invariants get tests before the code they constrain.
4. **`npm run verify` passes locally**, on your platform.
5. **Explain the why** in the description. The what is visible in the diff.

Commits: imperative mood, present tense — `Add tolerant JSONL parser`. Reference an ADR when
your change depends on one.

## Writing a collector

**You should not need to understand the rest of the codebase.** If you do, that is a bug in our
API and we want to hear about it.

A collector implements `CollectorPort`: describe yourself, discover sources, emit evidence
drafts. You never touch the database — you emit, and the core persists, classifies, and applies
policy. Every collector is held to the same conformance suite, whether it ships in-tree or not.

Once the plugin protocol lands, a collector can be written in **any language** that speaks
JSON-RPC over stdio. See ADR-0008.

Most integrations belong in their own repository rather than in-tree; the core stays
deliberately small. See [docs/Vision.md](docs/Vision.md) §10 for the tier system.

## Reporting bugs

Include your platform, Node version, CareerForge version, and `careerforge doctor` output.

**Never paste real evidence, transcripts, or credentials into an issue.** If reproduction needs
data, describe its shape or construct a synthetic example.

Security issues go to [SECURITY.md](SECURITY.md), not the issue tracker.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licensing

Contributions are licensed under Apache 2.0. There is no CLA. By opening a PR you confirm you
have the right to contribute the code.
