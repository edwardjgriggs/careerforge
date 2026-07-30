# ADR-0009 — Capability grants, with egress separate from network

**Status:** Accepted · 2026-07-30
**Relates to:** `Vision.md` §6, §8 · `Architecture.md` §9.3, §10
**Paired with:** ADR-0008

## Context

CareerForge's central promise is that career data never leaves machines the user controls. Two things can break it: a plugin, or an enrichment call. Both must pass through enforcement that is impossible to bypass rather than merely discouraged.

Measurement sharpened the stakes. AI session transcripts — the product's strongest differentiator — routinely contain pasted credentials, contents of files never committed, client identifiers, and production hostnames. **A git diff shows what changed; a transcript shows everything the person looked at, pasted, and said.**

A subtle failure mode drove the second half of this decision. A collector may legitimately need network access to *fetch* from an API. Conventional permission models express this as a single "network" permission — which also permits *sending*. **That conflation is how a collector quietly becomes an exfiltration path**, with the user having approved something that sounded reasonable.

## Decision

**Capability grants are declared, explicit, scoped, revocable, and audited — and `egress` is a distinct grant from `net`.**

1. **Declared in the manifest.** Every plugin lists required grants: `fs.read` with specific paths, `evidence.read`/`evidence.write` scoped to specific kinds, `net` with specific hosts, `egress` with data categories, `secret` with named entries.
2. **`net` ≠ `egress`.** `net` permits contacting declared hosts. `egress` permits local evidence to be included in an outbound payload. A plugin may hold one without the other. Conflating them is the failure mode this ADR exists to prevent.
3. **Enforced by the core, not the plugin.** Plugins request operations; they never perform them (ADR-0008). An ungranted operation is not refused — it is unreachable.
4. **Consent is keyed on `(project_key, provider_id, max_sensitivity)`.** Source-level consent is too coarse for this audience: a user enables personal repositories for a cloud provider while client work reaches only a local model.
5. **`restricted` evidence never reaches a non-local provider by default.** Overriding requires an explicit per-project grant — never a global switch.
6. **One choke point.** Invariant I3: every outbound enrichment call passes through the Policy Engine. It is the only package permitted to import an HTTP client; a lint rule enforces this. Every call produces an append-only `PolicyDecision` referenced from `enrichment_runs`, making **every remote call in the system's history auditable after the fact.**
7. **Mandatory payload preview.** The user sees exactly what would leave, before it leaves.
8. **Honest redaction boundaries.** Deterministically detectable: private keys, certificate blocks, cloud and vendor token formats, connection strings, `Authorization` headers, `.env` assignments, high-entropy strings in credential-shaped contexts, emails, paths containing usernames. **Not reliably detectable without AI:** client names in prose, unreleased product details, personnel discussion. The preview is the honest mitigation for the residual class — which is why it is mandatory rather than advisory. Profiles are versioned (`default@2`) and recorded per run.
9. **Trust tiers never expand capability.** A `Core` plugin requesting `egress` is prompted exactly like a `Community` one. Tiers describe review and maintenance status only.

## Consequences

**Gains**

- The privacy promise is enforced by architecture rather than by documentation.
- Compliance-constrained users — GovCon, cleared, NDA-bound, DLP-governed — can adopt CareerForge honestly. This is the audience competitors structurally cannot serve.
- Full audit trail of every plugin capability use and every remote call.
- Revocation is meaningful because enforcement is central.

**Accepted costs**

- Real friction at install and at first enrichment. This is the correct place for friction, and it must be well-designed rather than minimized.
- Plugin authors must think about capabilities up front.
- The policy engine is a single point of failure for correctness — hence the choke-point design, the lint rule, and heavy test coverage.
- Redaction is imperfect and the residual risk must be **disclosed plainly**, not obscured. Overstating redaction is worse than having none, because it converts an informed user into a trusting one.

## Alternatives considered

**Trust-on-install with documented risk.** What most plugin ecosystems do; ships fastest. Rejected: makes the safe path the effortful one and leaves the first "CareerForge leaked my employer's code" issue unanswerable.

**A single `network` permission.** Conventional and simpler to explain. Rejected: it silently authorizes exfiltration, which is precisely the risk that matters here.

**First-party plugins only.** Strongest safety. Rejected: makes maintainers a bottleneck on every integration and forfeits the ecosystem (`Vision.md` §10).

**AI-based redaction as the primary mechanism.** Would catch the non-deterministic class. Rejected for the default path: it requires sending unredacted content to a model to decide what should not be sent. Retained as an *optional local-model* pre-screen (open item).

## Revisit if

- Consent friction measurably prevents adoption — the fix is better defaults and clearer copy, never weaker enforcement.
- A local-model pre-screen proves reliable enough to reduce the residual disclosure.
- Real-world use reveals a capability category the grant vocabulary cannot express.
