# Architecture Decision Records

Each ADR records **one decision**, the context that forced it, and the consequences accepted — including the bad ones.

`Vision.md` and `Architecture.md` are frozen. **ADRs are the mechanism for changing them.** A decision that contradicts a frozen document requires a new ADR that supersedes the relevant one; the frozen documents are then corrected to match, and the ADR carries the reasoning forever.

## Format

Status · Context · Decision · Consequences · Alternatives considered · Revisit if

**"Revisit if"** is required. A decision without stated falsification conditions is a belief, and belief is how projects carry bad decisions for years past their expiry.

## Status values

`Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Deprecated`

An accepted ADR is never edited except to change status or fix errors. Disagreement is expressed by writing a new ADR, not by rewriting history.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-append-only-data-model.md) | Append-only data model | Accepted |
| [0002](0002-evidence-is-immutable-and-factual.md) | Evidence is immutable and factual | Accepted |
| [0003](0003-sqlite-is-canonical-storage.md) | SQLite is canonical storage | Accepted |
| [0004](0004-export-is-the-sync-contract.md) | The JSON export is the sync and durability contract | Accepted |
| [0005](0005-ai-is-additive.md) | AI is additive, never load-bearing | Accepted |
| [0006](0006-work-units.md) | Work Units are the unit of accomplishment | Accepted |
| [0007](0007-claim-level-provenance.md) | Provenance is tracked at claim level | Accepted |
| [0008](0008-jsonrpc-stdio-plugin-protocol.md) | JSON-RPC over stdio for the plugin protocol | Accepted |
| [0009](0009-capability-grants-and-egress-separation.md) | Capability grants, with egress separate from network | Accepted |
| [0010](0010-tolerant-parsing-contract.md) | Tolerant parsing is a platform contract | Accepted |
| [0011](0011-forward-compatible-identity.md) | Every record carries subject and asserter identity | Accepted |
