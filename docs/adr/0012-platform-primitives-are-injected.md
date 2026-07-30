# ADR-0012 — Platform primitives are injected into the domain, never imported

**Status:** Accepted · 2026-07-30
**Relates to:** `Architecture.md` §1.1, §1.3, §2.2 · ADR-0005
**Raised by:** M1 implementation

## Context

`Architecture.md` requires three things of the domain layer that it cannot do on its own:

1. **IDs are ULIDs** (§1.3) — which needs the current time and a source of randomness.
2. **`natural_key` = `sha256(collector_id + NUL + source_uri)`** (§2.2) — which needs a hash.
3. **`content_hash` = `sha256(canonical payload)`** (§2.2) — likewise.

Invariant I1 forbids the domain from importing adapters or performing I/O, and M0 tightened this
further: `domain` compiles with `"types": []`, so `node:crypto` is not merely discouraged, it is
invisible. Meanwhile `Date.now()` and `Math.random()` are ambient globals that would make domain
functions non-deterministic and untestable.

The architecture specified *what* these values are without saying *where the primitives live*.
That gap has to be closed before any of it can be written.

## Decision

**The domain defines the rules. The platform supplies the primitives. Primitives arrive as
function parameters, never as imports.**

Three port *types* are declared in the domain and implemented by adapters:

```ts
type Clock = () => number;                          // epoch milliseconds
type EntropySource = (byteLength: number) => Uint8Array;
type Digest = (input: string) => string;            // lowercase hex
```

These are type declarations only. The domain never calls a platform API; it receives a function
and applies it. Purity is preserved by construction rather than by discipline.

The split follows one line consistently:

| The domain owns | The adapter owns |
|---|---|
| ULID layout, Crockford encoding, monotonic ordering | Reading the clock, generating entropy |
| What constitutes identity (`collector_id` + `source_uri`) | Computing SHA-256 |
| The canonical form that gets hashed | Turning bytes into a digest |

**Canonicalization stays in the domain.** Deciding *which bytes represent this artifact's identity*
is a domain rule — it is the definition of when two collected artifacts are the same thing. That
is distinct from serialization for storage or transport, which remains firmly outside.

## Consequences

**Gains**

- Domain functions are deterministic and exhaustively testable. Injecting a fixed clock and a
  counter-based entropy source makes ULID generation reproducible in tests, so ordering and
  monotonicity can be asserted rather than hoped for.
- The most security-relevant primitive (randomness) is supplied by the platform CSPRNG. The
  domain never has an opinion about entropy quality, which is the correct place for it not to.
- Invariant I1 needs no exception. The purity rule holds without carve-outs, which matters
  because a rule with one exception acquires a second.
- Swapping SHA-256 later is an adapter change, and the canonicalization it hashes is unchanged.

**Accepted costs**

- Call sites are wordier: `newEvidenceId(clock, entropy)` rather than `newEvidenceId()`. This is
  the visible price of purity and will look like ceremony to a newcomer — hence this ADR.
- A composition root must assemble the primitives. For now that is the CLI; it is one small place
  and it stays small.
- An adapter could supply a bad primitive — a constant clock, weak entropy. Mitigated by the
  adapters being few, in-tree, and tested. Not mitigated for third parties, and that is acceptable:
  a plugin cannot construct domain objects directly (ADR-0008).

## Alternatives considered

**Implement SHA-256 in pure TypeScript inside the domain.** Genuinely tempting: it keeps the
domain self-contained and makes the hashing acceptance criteria directly testable with no
injection. Rejected — reimplementing a platform cryptographic primitive is roughly 120 lines of
bit manipulation that every contributor must take on trust, it will be slower than the native
implementation on a hot collection path, and it buys self-containment the project does not need.

**Import `node:crypto` in the domain and treat hashing as an exception to I1.** Simplest, and
hashing is arguably not "I/O". Rejected — an invariant with one exception soon has three, and the
argument for the second exception is always as good as the argument for the first. The purity rule
is worth more than the convenience.

**Move ID and hash derivation out of the domain into `store` or `collect`.** Also defensible, and
it keeps the domain smaller. Rejected because identity is a *domain* rule: two collected artifacts
being the same thing is a statement about evidence, not about storage. Putting it in `store` would
mean a second store implementation could silently disagree about identity.

**Accept ambient `Date.now()` and `Math.random()`.** Conventional and briefest. Rejected — it
makes every function touching an ID non-deterministic, which forfeits exactly the exhaustive
testability M1 exists to establish.

## Revisit if

- The parameter threading becomes genuinely burdensome at real call-site density — the fix would
  be a narrow context object, not ambient access.
- A platform arrives where injecting a CSPRNG is impractical.
- ULIDs are replaced by another identifier scheme, which would change what is injected but not
  the principle.
