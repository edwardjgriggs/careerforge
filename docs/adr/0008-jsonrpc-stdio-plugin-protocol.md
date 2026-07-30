# ADR-0008 — JSON-RPC over stdio for the plugin protocol

**Status:** Accepted · 2026-07-30
**Relates to:** `Vision.md` §8, §12 · `Architecture.md` §9
**Paired with:** ADR-0009

## Context

`Vision.md` §12 states that **the protocol, not the implementation language, is the platform.** The core is TypeScript, but a plugin ecosystem restricted to TypeScript would exclude most of the target audience — Python is dominant among security and data professionals, PowerShell among Windows administrators, Go among infrastructure engineers.

Simultaneously, `Vision.md` §8 requires that third-party plugins never touch the database or filesystem directly, because a collector has read access to a person's entire professional life on a machine that also holds AI provider keys and sync credentials. **A malicious CareerForge plugin would be an unusually valuable payload.**

These two requirements — any language, no direct access — point at the same answer.

## Decision

**Plugins are child processes speaking JSON-RPC 2.0 over newline-delimited stdio. They are never loaded in-process.**

Chosen because it is:

- **Language-agnostic.** Any language that can read stdin and write stdout qualifies. This is the vision requirement, satisfied directly.
- **Port-free.** No sockets, no listeners, no firewall interaction, no port collisions.
- **Cross-platform.** Identical behavior on Windows, macOS, and Linux — non-trivial given the primary development platform is Windows.
- **Trivially debuggable.** A plugin can be tested by piping a fixture file into it. Contributors need no CareerForge installation to develop against the protocol.
- **Proven.** MCP demonstrates this exact pattern at scale with a large third-party ecosystem.
- **Process-isolated.** A crashing or hostile plugin cannot take down the host or read the store.

Supporting decisions:

1. **Version negotiation in `initialize`.** A plugin declaring an unsupported `api_version` is refused immediately with a clear message, rather than failing later in an unrelated way.
2. **Plugins request operations; they do not perform them.** The host API is deliberately minimal (`evidence.emit`, `evidence.query`, `blob.put/get`, `log`, `progress`, `secret.get`). No method exposes raw SQL, raw filesystem, or a store handle. **The core is the policy enforcement point** — by construction, not by review.
3. **`protocol` is its own package** with no dependencies, published separately. A plugin author consumes the schema without pulling the application. This is the mechanism behind "a contributor shouldn't need to understand the entire codebase" (`Vision.md` §10).
4. **In-tree collectors use the identical `CollectorPort` and identical conformance suite** but run in-process, sharing the host's trust boundary. **The contract is identical; only the process boundary differs** — this is what stops the first-party path from silently becoming a privileged API third parties cannot match.
5. Frozen at 1.0 under semver. Adding a host method is a minor version event requiring documented justification.

## Consequences

**Gains**

- Ecosystem contributions in any language.
- Process isolation as a security boundary, satisfying `Vision.md` §8 structurally.
- Plugin crashes are contained and observable.
- Streaming works naturally: collectors yield evidence drafts incrementally, so a long backfill reports progress and can be interrupted safely.

**Accepted costs**

- Serialization overhead per record. Acceptable: collection is I/O-bound and runs in the background, not on a UI path.
- Process spawn cost per plugin invocation. Amortized across a run.
- Binary payloads must be handled by reference (`blob.put`/`blob.get`), not inline. Correct anyway — ADR-0003 keeps blobs out of the database.
- Two execution modes (in-process first-party, out-of-process third-party) is a genuine complexity cost. Mitigated by the shared port and shared conformance suite: mode is a deployment detail, not an API difference.
- Debugging spans a process boundary.

## Alternatives considered

**In-process plugins (npm packages).** Simplest, fastest, most familiar. Rejected on both counts: TypeScript-only, and a plugin with full process access can read the entire store, exfiltrate silently, and break the central privacy promise. Irreconcilable with `Vision.md` §8.

**WASM sandbox.** Strongest isolation available. Rejected: collectors need real filesystem access and native tooling (`git`, platform APIs), which is exactly what WASM restricts. It would make the most valuable plugins impossible to write.

**HTTP/gRPC local server.** Rich tooling, streaming, well-understood. Rejected: requires port management, introduces a locally listening service on a privacy-focused product, and complicates lifecycle and firewall behavior for no gain over stdio.

**Custom binary protocol.** Faster and smaller. Rejected: hostile to contributors, poor debuggability, and the performance gain is irrelevant for an I/O-bound background workload.

## Revisit if

- Serialization overhead becomes measurable on realistic corpora (measure before acting).
- A plugin category emerges that genuinely cannot be expressed request/response plus streaming.
- MCP or an equivalent becomes a de facto standard worth adopting directly instead of paralleling.
