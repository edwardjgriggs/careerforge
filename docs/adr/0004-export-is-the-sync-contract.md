# ADR-0004 — The JSON export is the sync and durability contract

**Status:** Accepted · 2026-07-30
**Relates to:** `Vision.md` §6, §12 · `Architecture.md` §4.5, §4.6
**Paired with:** ADR-0003 · **Depends on:** ADR-0001

## Context

ADR-0003 makes SQLite canonical, which creates two genuine problems the project cannot wave away:

1. **Durability.** A binary database is opaque. "Your career data stays under your control" is hollow if control means a file only CareerForge can open.
2. **Sync.** `Vision.md` §6 promises multi-device support via user-owned destinations — OneDrive, Dropbox, iCloud, Git, S3, Syncthing. **Syncing a live SQLite file across cloud storage is a well-known route to corruption**, and binary files do not merge.

## Decision

**A versioned JSON export tree is the durability representation and the unit of sync. The database file is never synced.**

- One JSON file per record, named by ULID, **pretty-printed with sorted keys** so diffs are minimal and reviewable.
- Partitioned by `occurred_at` year/month so a decade does not become one unmanageable directory.
- `manifest.json` carries `export_format_version`, record counts, and checksums.
- **`export_format_version` is versioned separately from the database schema and changes far less often.** The database may be refactored freely; the export is a long-term contract with the user.
- `careerforge export` is idempotent: unchanged records produce byte-identical files, so sync targets see no churn.
- Blobs are not exported by default — only their hashes. Blob export is opt-in per project, because that is where the sensitive bulk lives.
- **`careerforge rebuild` reconstructs the canonical database from `export/`.** Round-trip fidelity is asserted in CI (invariant I5).

### Why sync converges without a coordinator

Because ADR-0001 makes every table append-only and every ID a ULID, **merging two exports is a set union.** Record-level conflicts are impossible: no record is ever modified, so two devices can only ever *add*. The single conflict class is competing supersede chains on the same record, resolved by ULID ordering with both branches retained and surfaced to the user.

This is the payoff for append-only that was not obvious when that decision was made, and it is why sync — though deferred from Proof of Thesis — is already structurally solved.

## Consequences

**Gains**

- `rebuild` converts SQLite from a **jail** into an **index**. If the database is corrupted, superseded, or abandoned, no career history is lost. This is what makes ADR-0003 acceptable.
- Sync works on any file-sync product without CareerForge-specific support.
- Git-based sync gets full version history free.
- Users can read, grep, and diff their own data with ordinary tools.
- Deferred sync becomes far simpler when its time comes — a further argument for keeping it out of Proof of Thesis.

**Accepted costs**

- Data exists twice on disk. Acceptable: JSON records are small, and blobs are excluded.
- Export must be kept current — either on write or by explicit command. Staleness is a real failure mode and needs a visible indicator.
- `export_format_version` is a second compatibility surface to maintain, deliberately more conservative than the schema.
- Round-trip fidelity must be continuously proven, not assumed. Hence invariant I5 in CI.

## Alternatives considered

**Sync the SQLite file directly.** Trivially simple. Rejected: documented corruption risk on cloud-sync providers, and binary files cannot merge — one device silently loses work.

**CRDT-based sync layer.** Principled multi-writer convergence. Rejected as unnecessary: append-only tables plus ULIDs already give convergence for this data shape, at a fraction of the complexity and contributor burden.

**A CareerForge sync service.** Best UX by far. Rejected outright: violates `Vision.md` §6, which forbids CareerForge-operated servers holding user evidence.

**Export on demand only, no continuous export.** Less write amplification. Rejected: makes the durability guarantee conditional on the user remembering — exactly when it matters least.

## Revisit if

- Export write amplification becomes measurable at realistic volumes.
- Real-world sync destinations expose a merge failure mode not covered by ULID ordering.
- Users report the two-representation model as confusing rather than reassuring.
