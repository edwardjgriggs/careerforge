# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 0.2.0 —
with one stated exception: **`@careerforge/protocol` is unstable and will change without a
major version bump until 1.0.**

This file covers the repository. Each published package also carries its own generated
`CHANGELOG.md`; this one is the account a person would want to read.

## [Unreleased]

## [0.2.0] — 2026-07-31

**The first public release.** There is no 0.1.0 on npm or on the releases page — the
version was carried through thirteen milestones of development and bumped once on the way
out the door, before anything had been published. Nothing is missing.

Thirteen milestones, and a Proof of Thesis: that career assets can be generated from
evidence with claim-level provenance, and that the refusals are the point.

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

[unreleased]: https://github.com/edwardjgriggs/careerforge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/edwardjgriggs/careerforge/releases/tag/v0.2.0
