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
| [0012](0012-platform-primitives-are-injected.md) | Platform primitives are injected into the domain | Accepted |
| [0013](0013-append-only-is-universal-and-derived-by-join.md) | Append-only is universal; suppression is derived by join | Accepted |
| [0014](0014-sqlite-driver-and-node-floor.md) | better-sqlite3, with a Node 22 floor | Accepted |
| [0015](0015-identity-and-content-are-separate-tables.md) | Identity and content live in separate tables | Accepted |
| [0016](0016-format-drift-is-reported-not-just-tolerated.md) | Format drift is reported, not just tolerated | Accepted |
| [0017](0017-source-authored-is-not-human-authored.md) | Source-authored is not human-authored | Accepted |
| [0018](0018-curation-is-protected-by-evidence.md) | Curation is protected by evidence, not by grouping key | Accepted |
| [0019](0019-grouping-quality-is-measured.md) | Grouping quality is measured against a labelled corpus | Accepted |
| [0020](0020-explanation-separates-grounds-from-interpretation.md) | An explanation separates grounds from interpretation | Accepted |
| [0021](0021-the-interview-is-not-a-collector.md) | The person is a source; the interview is not a collector | Accepted |
| [0022](0022-every-refusal-names-its-remedy.md) | Every refusal names the rule and the remedy | Accepted |
| [0023](0023-a-prompt-is-a-versioned-artifact.md) | A prompt is a versioned artifact, frozen once published | Accepted |
| [0024](0024-an-interpretation-cites-its-inputs.md) | An interpretation cites its inputs, or it is discarded | Accepted |
| [0025](0025-the-model-proposes-claims-not-prose.md) | The model proposes claims, and the sentence is composed afterwards | Accepted |
| [0026](0026-confidence-describes-evidence-not-the-model.md) | Confidence describes the evidence, never the model | Accepted |
| [0027](0027-an-outcome-is-observed-never-inferred.md) | An outcome must be observed, never inferred from the work that caused it | Accepted |
| [0028](0028-listening-is-not-sending.md) | Listening is not sending | Accepted |
| [0029](0029-positioning-is-an-evidence-engine.md) | CareerForge is positioned as an evidence engine, not an AI platform | Accepted |
