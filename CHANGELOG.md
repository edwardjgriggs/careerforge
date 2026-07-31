# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 0.2.0 —
with one stated exception: **`@careerforge/protocol` is unstable and will change without a
major version bump until 1.0.**

This file covers the repository. Each published package also carries its own generated
`CHANGELOG.md`; this one is the account a person would want to read.

## [Unreleased]

## [0.2.1] — 2026-07-31

**The first release published by the release workflow rather than by hand.** No functional
change; this release exists so that what the README claims and what the registry holds are
the same thing.

### Fixed

- **Provenance.** 0.2.0 was published from a laptop, so no package carried a
  [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) and no
  tarballs or checksums ever reached the releases page — while the README asserted both.
  0.2.1 is published by the workflow, with `--provenance`, from a tagged commit.
  `npm view careerforge dist.attestations` is the check, and
  [docs/install.md](docs/install.md) now says what an empty answer means rather than asking
  to be believed.
- **`@careerforge/store`** declared `better-sqlite3@^13.0.2` while the source had since been
  held at `^12.11.1`, where the prebuilt binaries are. Published and committed now agree.

### Changed

- Package descriptions and keywords rewritten for discoverability.
- Every third-party GitHub Action pinned to a commit SHA. A tag can be repointed by whoever
  owns it, and the release workflow runs beside a job holding a registry credential.
- README restructured: install above the fold, the Evidence Explorer screenshot that did not
  previously exist anywhere in the repository, the accepted output rather than only the
  refusal, architecture diagrams, and a forward-looking roadmap.
- `Vision.md` and `Architecture.md` no longer carry their internal "Draft for approval"
  status headers.

### Added

- [docs/faq.md](docs/faq.md) — cost, scale, Windows and WSL, monorepos, and what leaving
  looks like. Including the answer to the question that was disqualifying readers in the
  first paragraph: **no, you do not need an AI coding assistant. Git alone is a complete
  source.**
- Issue and pull request templates, `CODEOWNERS`, and Dependabot.
- A note in [CONTRIBUTING.md](CONTRIBUTING.md) that the first `npm test` reads your own
  `~/.claude` transcripts. The test commits nothing and asserts nothing about content, but a
  project that classifies those as its most sensitive data should say so beforehand.

## [0.2.0] — 2026-07-31

**The first public release.** Thirteen milestones of development, and a Proof of Thesis:
that career assets can be generated from evidence with claim-level provenance, and that the
refusals are the point. (0.1.0 was the in-development version and was never published.)

_Published to npm by hand rather than by the release workflow, so this version carries no
provenance attestation and has no tarballs or checksums on the releases page. 0.2.1 is the
first release for which those claims hold; prefer it._

### Added

- **Evidence collection.** A Git collector and an AI Coding Session collector (Claude Code
  is the first adapter), both held to the same conformance suite. Collectors parse
  tolerantly: they declare the narrow field set they need, skip and count everything else,
  and never throw on an unknown record.
- **Work Units.** Artifacts group into the size at which people actually describe work,
  measured against a labelled corpus rather than asserted.
- **Generation with claim-level provenance.** Every claim in a generated asset cites the
  records behind it. Claims the evidence cannot carry are refused rather than softened;
  `role` and `metric` claims require confirmed or computed support, and an `outcome` must
  be observed rather than inferred from the work that caused it.
- **The interview.** Every refusal names the question that would change the answer. Your
  answer is stored as evidence you confirmed, and is reused by every later asset.
- **`careerforge explain`.** Any claim, traced to its support, with grounds separated from
  interpretation.
- **Evidence Explorer** (`careerforge ui`). A local page, served from loopback, with no
  bundler, no framework, and no third-party request: on the left why a statement is
  believed, on the right the questions that would strengthen it.
- **The Policy Engine.** One egress choke point. Sensitivity classified per source and per
  project, consent granted per provider and per project, deterministic redaction, and a
  mandatory preview of the exact outbound payload — shown even when the answer is refused.
- **The guided tour** (`careerforge tour`). Runs the real commands against a sample store
  with no key and no network, and argues for the design at each step. CI walks it end to
  end on Linux, macOS, and Windows.
- **Durability.** Append-only storage, versioned enrichments, and a plain JSON export that
  `careerforge rebuild` can reconstruct the database from.
- 29 architecture decision records, each with the conditions that would overturn it.

### Notes

- Requires Node.js 22 or newer (ADR-0014).
- Published to npm with provenance. Release tarballs carry SHA-256 checksums.
- Not built yet: out-of-process plugins, sync, analytics, a desktop shell. Each has a seam
  in place and needs no schema migration to add.

[unreleased]: https://github.com/edwardjgriggs/careerforge/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/edwardjgriggs/careerforge/releases/tag/v0.2.1
[0.2.0]: https://www.npmjs.com/package/careerforge/v/0.2.0
