# ADR-0010 — Tolerant parsing is a platform contract

**Status:** Accepted · 2026-07-30
**Relates to:** `Architecture.md` §6.3 · `docs/PreArchitecture-Findings.md` §1.2

## Context

Measurement of real AI session data produced a finding that changes how collectors must be written:

**In a single 30-day window, records carried 12+ distinct schema versions** (`2.1.198` → `2.1.220`) — roughly a schema-bearing release every two to three days. Thirteen record types were present, several of which (`bridge-session`, `queue-operation`, `file-history-delta`) are clearly transport plumbing that will change without notice or deprecation.

This is not unique to that source. Every source CareerForge will ever collect from is owned by someone else: Jira changes its API, Outlook changes its payloads, SharePoint changes everything. **CareerForge is permanently downstream of formats it does not control.**

Strict parsing — validate against a closed schema, throw on the unexpected — is the default instinct and the correct choice in most systems. Here it means collectors break continuously, users see errors for data they do not care about, and maintainers spend their time chasing upstream churn instead of building.

## Decision

**Tolerant parsing is a platform rule binding on every collector, in-tree and third-party. It is not a per-collector implementation choice.**

1. **A collector declares `required_fields`** in its manifest — the narrow set it genuinely depends on. For the AI session collector that is five fields out of dozens available.
2. **Records missing a required field are skipped and counted**, never fatal.
3. **Unknown record types, unknown fields, and unknown source versions are ignored silently.** No warnings. A warning the user cannot act on is noise that trains them to ignore real warnings.
4. **`source_format_version` is recorded as provenance but never branched on**, unless a specific break is confirmed and documented. Version-conditional logic is how a parser accumulates permanent unmaintainable cruft.
5. **A parse failure on one record never fails a run.**
6. **Every run emits a `CollectionReport`** — records seen, emitted, skipped by reason, unknown types encountered.
7. **Conformance tests enforce this**: every collector is tested against corrupted, truncated, and unknown-version fixtures and must not throw.

**The `CollectionReport` is what makes tolerance safe rather than reckless.** Silent tolerance without measurement is silent data loss. Skipped-record trends are how format drift is detected — a spike in skips is the signal that upstream changed, surfaced before users report missing evidence.

## Consequences

**Gains**

- Collectors survive upstream churn without releases.
- Users are not shown errors about plumbing records they do not know exist.
- Third-party plugins written once keep working, which is what makes an out-of-tree ecosystem viable (`Vision.md` §10).
- Narrow field dependency means a smaller surface to break.

**Accepted costs**

- **Silent data loss is possible.** A field that quietly stops being populated produces gradually thinner evidence with no error. `CollectionReport` trends are the mitigation, and they must actually be surfaced — an unread report is no mitigation at all.
- Contributors must resist strict validation, which is the instinct good engineers have. The conformance suite enforces it where discipline would not.
- Debugging is harder: "why is this evidence missing" requires consulting the report rather than reading an exception.

## Alternatives considered

**Strict schema validation with versioned parsers.** Catches upstream changes immediately and precisely. Rejected: at a schema-bearing release every 2–3 days, this is a full-time maintenance burden for one source, and it fails users loudly for changes that do not affect them.

**Best-effort parsing with warnings.** Middle ground; keeps visibility. Rejected: warnings the user cannot act on train them to ignore all warnings, including the ones that matter. The `CollectionReport` gives visibility to maintainers without spending user attention.

**Per-collector choice.** Maximum flexibility for plugin authors. Rejected: the ecosystem would fragment into collectors that break constantly and collectors that do not, with users unable to tell which they are installing. Reliability must be a platform property.

## Revisit if

- `CollectionReport` trend monitoring proves insufficient to catch real drift in practice.
- A source appears where silent skipping produces materially wrong evidence rather than merely incomplete evidence.
