# ADR-0007 — Provenance is tracked at claim level

**Status:** Accepted · 2026-07-30
**Relates to:** `Vision.md` §5, §7 · `Architecture.md` §5
**Depends on:** ADR-0002

## Context

`Vision.md` requires that every claim be traceable and that CareerForge ask rather than guess. The obvious implementation — link a generated asset to the evidence used to produce it — is insufficient, and the reason is the entire point of the product.

Consider one bullet:

> *"Led implementation of Intune compliance policies for 50+ users, reducing support tickets by 30%."*

Asset-level provenance says: built from evidence 14, 22, 35. All three exist. The bullet appears supported. But inside it are four independent assertions with radically different support:

| Assertion | Type | Actual support |
|---|---|---|
| implemented Intune compliance policies | action | commits — **solid** |
| led | **role** | **nothing** |
| 50+ users | **metric** | user-confirmed — solid |
| reduced tickets 30% | **metric** | **nothing** |

**Asset-level provenance cannot distinguish these.** Two career-ending fabrications sit inside a bullet that passes every asset-level check. `role` and `metric` claims are precisely the two that end careers when invented, and they are exactly what asset-level tracking cannot see.

## Decision

**Each assertion inside an asset is a `Claim` with its own support set, its own type, and its own minimum support requirement.**

1. Generation decomposes an asset into typed claims: `action`, `scope`, `role`, `metric`, `outcome`, each carrying a text span into the rendered output.
2. **Invariant I4: generation refuses to emit a claim with zero `supports` edges.** A hard failure at generation time, not a validation warning.
3. **Support requirements are asymmetric, weighted toward the dangerous types:**

| Claim type | Minimum support |
|---|---|
| `action` | ≥1 Evidence or Work Unit |
| `scope` | ≥1 Evidence with a matching attribute value |
| `role` | ≥1 `user_confirmed` Evidence — **never inferred** |
| `metric` | `derived` (computed) or `user_confirmed` — **never model-generated** |
| `outcome` | ≥1 Evidence, or `user_confirmed` |

4. **An unsupportable claim becomes a `Gap`, not a weaker sentence.** Gaps are a queryable table with `gap_type`, `question`, `status`, and `asked_count` — which is what makes "never asks the same question twice" (`Vision.md` §7) enforceable rather than aspirational. A `declined` gap is never re-raised for the same Work Unit.
5. Answering a gap writes `user_confirmed` Evidence plus an `answers` edge, reusable across every future asset. **This is the mechanism by which the system gets smarter with use.**
6. Provenance edges are append-only and typed (`supports`, `interprets`, `derived_from`, `grouped_into`, `answers`, `contradicts`, `supersedes`).

## Consequences

**Gains**

- The two catastrophic failure modes are **structurally impossible**, not merely discouraged by prompting.
- Evidence Explorer becomes a bounded graph query rather than a heuristic explanation.
- The "Missing Information" panel is real data, and it is the engagement loop that solves cold start.
- Users can audit a single phrase, which is what actually happens when someone challenges a resume line in an interview.

**Accepted costs**

- Generation is materially more complex: decompose, classify, resolve support, emit gaps.
- Claim decomposition can itself be wrong. Mitigated by spans being user-visible and correctable.
- More rows — one asset produces several claims and several edges.
- **Bullets are weaker at first.** A user with no confirmed metrics gets a modest bullet plus three questions instead of an impressive fabrication. `Vision.md` §2.5 already resolved this: accuracy beats stronger-sounding, every time. It must be presented as *"three questions from a stronger bullet"*, not as failure.

## Alternatives considered

**Asset-level provenance.** Far simpler and what most tools do. Rejected: cannot distinguish supported from fabricated assertions inside one sentence, which is the whole problem.

**Confidence scores per claim, no hard requirement.** More flexible, better first drafts. Rejected: LLM confidence is poorly calibrated, users learn to ignore scores within days, and a low-confidence marker does not survive copy-paste into a resume.

**Post-hoc verification of generated text.** Simpler pipeline; generate freely, then check. Rejected: verification of free text is itself an inference problem, and it inverts the safe default — the fabrication exists first and must be caught, rather than never existing.

**Uniform support rules for all claim types.** Simpler to explain. Rejected: it either blocks harmless `action` claims or permits invented `role` and `metric` claims. Asymmetry is the point.

## Revisit if

- Claim decomposition accuracy is too low to be useful in practice.
- Users routinely bypass gaps by entering unverifiable answers — a signal to examine incentives, not to relax provenance.
- A claim type emerges that the five categories cannot express.
