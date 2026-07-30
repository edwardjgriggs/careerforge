# ADR-0014 — `better-sqlite3` as the driver, Node 22 as the floor

**Status:** Accepted · 2026-07-30
**Relates to:** ADR-0003 · `Architecture.md` §4, §12
**Raised by:** M2 implementation

## Context

ADR-0003 makes SQLite canonical. It does not say how CareerForge talks to it, and M0 set the Node
floor at 20.11 before any driver had been evaluated.

Both viable drivers rule Node 20 out:

- **`better-sqlite3@13`** declares `engines: { node: ">=22" }`.
- **`node:sqlite`**, the built-in module, does not exist in Node 20 at all, and on Node 22 it is
  experimental and emits a warning on import.

So the documented floor is unreachable for any SQLite driver. It has to move regardless of which
driver is chosen. Node 20's LTS maintenance window has also closed, so a floor of 22 asks nothing
unreasonable of contributors or users.

The choice that remains is native module versus built-in, and it is genuinely close.

## Decision

**`better-sqlite3` is the driver. The Node floor rises from 20.11 to 22.**

Reasons, in order of weight:

1. **A stable API.** `node:sqlite` is experimental and may change between minor releases. The
   store is the layer everything else depends on, and it holds the user's irreplaceable data.
   Churn there is the most expensive churn available.
2. **Synchronous by design.** Collection is a batch process, and synchronous prepared statements
   make transactional append-only writes straightforward. An async driver would put `await` inside
   every transaction boundary — the classic route to a half-applied migration.
3. **Maturity where it matters.** WAL, transactions, user-defined functions, and FTS5 are all
   exercised heavily by a large existing user base. The migration path is the one place this
   project cannot afford to discover a driver bug.
4. **No experimental warning on every run.** A CLI that prints an `ExperimentalWarning` on startup
   reads as unfinished, and suppressing it would hide real warnings too.

**The cost is accepted deliberately:** `better-sqlite3` is a native module. Users on platforms
without a prebuilt binary need a toolchain to install it, and that is a genuine barrier for the
non-developer audience CareerForge eventually wants. The driver is confined behind `StorePort` so
that swapping it later is an adapter change, not a rewrite.

## Consequences

**Gains**

- Stable, well-exercised API at the layer holding the canonical store.
- Synchronous transactions, so append-only writes and migrations are atomic without async
  ceremony.
- FTS5 available without extension loading.

**Accepted costs**

- A native dependency, with install failures possible on unusual platform and Node combinations.
  CI covers Linux, macOS, and Windows, which is where the users are.
- Node 22 floor excludes anyone pinned to Node 20. Acceptable — Node 20 is out of maintenance.
- M0's README, CONTRIBUTING, CI matrix, and `doctor` all stated 20.11 and are corrected.
- `doctor` must now diagnose a failed native build clearly, since "cannot find module" is the
  least helpful error a first-run user could receive.

## Alternatives considered

**`node:sqlite`.** Zero dependencies, no native build step, and therefore a materially better
install story for non-developers — the single strongest argument against the decision made here.
Rejected for now on stability grounds: an experimental API underneath the canonical store is the
wrong risk to take at M2, and the warning on every run is a poor first impression. **This is the
most likely alternative to win on revisit.**

**`sql.js` (SQLite compiled to WebAssembly).** No native build at all, runs anywhere. Rejected:
it operates on an in-memory database that must be serialised back to disk, which forfeits WAL,
incremental writes, and crash safety — unacceptable for a store whose durability promise is the
product.

**Defer the driver choice behind an interface and ship neither.** Rejected as false prudence: the
interface would be designed against no real implementation, and M2 exists to make persistence
real.

## Revisit if

- **`node:sqlite` becomes stable.** It removes the native dependency, which is the main cost being
  accepted here. This is the expected trigger.
- Prebuilt binaries prove unreliable for real users on real platforms.
- Install failures become a common first-run complaint.
