# ADR-0011 — Every record carries subject and asserter identity

**Status:** Accepted · 2026-07-30
**Relates to:** `Vision.md` §13 · `Architecture.md` §2.3

## Context

`Vision.md` §13 names multi-party evidence — peer attestation, manager confirmation, mentor feedback, professional references — as a long-term ambition explicitly **not** to be built early. Its stated purpose in the vision is to prevent decisions today that foreclose it tomorrow.

CareerForge is single-user for the foreseeable future. There is exactly one person, and every record is about them and asserted by them. Modeling identity now looks like textbook premature generalization.

It is not, and the asymmetry is stark. Adding identity later means migrating **every historical row** — the entire accumulated career history, the thing the product exists to protect — to backfill a value that was implicit. That migration is the single riskiest operation the project could ever perform, against the exact data whose durability is its central promise (`Vision.md` §14).

Adding it now costs two columns with a constant default.

## Decision

**Every Evidence record carries `subject_id` and `asserted_by`, both defaulting to `"self"`.**

- **`subject_id`** — the identity this evidence is *about*.
- **`asserted_by`** — the identity that *asserts* it.

For the entire single-user lifetime both are `"self"`, and no code branches on them. They exist so that:

| Future capability | Expressed as | Migration needed |
|---|---|---|
| Peer attestation | `subject_id = self`, `asserted_by = colleague` | None |
| Manager confirmation | `subject_id = self`, `asserted_by = manager` | None |
| Team rollup | `subject_id = report`, `asserted_by = self` | None |
| Reference given to someone else | `subject_id = colleague`, `asserted_by = self` | None |

Two fields, not one, because **the distinction between "whose work this is" and "who is vouching for it" is the entire substance of attestation.** Collapsing them to a single `owner` would require the migration this ADR exists to avoid.

## Consequences

**Gains**

- Multi-party evidence becomes a *feature* rather than a *migration of every row ever written*.
- Trust modeling has a place to attach when the time comes: an `asserted_by` that is not `self` is inherently different evidence, and provenance can already express that.
- Costs approximately nothing now — two `TEXT NOT NULL DEFAULT 'self'` columns.

**Accepted costs**

- Two columns carrying a constant for years. This will look like dead weight to new contributors; the ADR is the answer to "why is this here?"
- A mild temptation to build multi-party features early because the schema permits it. `Vision.md` §13 is explicit that these are destinations, not milestones, and that has not changed.
- An `identities` table is implied. It stays trivial — one row, `self` — until it is not.

## Alternatives considered

**Omit identity; add it when needed.** Genuinely simpler now, and normally the right instinct — YAGNI is a good default. Rejected because the asymmetry is extreme: the cost of *having* it is two constant columns; the cost of *adding* it is a full-table migration of irreplaceable data under a promise of automatic, lossless migration. YAGNI applies to features and abstractions, not to columns that make future migrations unnecessary.

**A single `owner_id`.** Half the cost. Rejected: cannot express attestation, which is the actual requirement. It would need the migration anyway, having paid a cost to avoid it.

**A full identity and trust model now.** Complete and principled. Rejected as genuinely premature: key exchange, verification, revocation, and trust levels are a large subsystem serving zero current users, and it would be designed against imagined requirements.

## Revisit if

- Multi-party evidence is definitively removed from the roadmap — then these columns become dead weight worth dropping.
- Real attestation design reveals that identity needs to be a first-class table with relationships sooner than expected (the columns still hold; only the target of the reference changes).
