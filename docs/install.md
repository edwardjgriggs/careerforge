# Installing

## Requirements

**Node.js 22.0 or newer.** Not negotiable: the SQLite driver requires it, and
`node:sqlite` does not exist on 20 (ADR-0014). `careerforge doctor` checks it
and says so plainly if yours is older.

CareerForge is developed on Windows and tested on Windows, macOS, and Linux on
every commit. Windows is a first-class matrix entry rather than something added
after a bug report.

## From a release

Download the artifacts and their checksums from the releases page, then verify
before running anything:

```bash
sha256sum -c SHA256SUMS
npm install -g ./careerforge-cli-0.1.0.tgz
```

A download nobody can verify is a download nobody should run.

## From source

```bash
git clone https://github.com/edwardjgriggs/careerforge
cd careerforge
npm ci
npm run build
node packages/cli/dist/bin.js tour
```

## Check it worked

```bash
careerforge doctor
```

On a machine that has not collected anything yet, expect warnings and no
failures. An empty store and a broken installation look identical from the
outside, so doctor is careful to distinguish them.

## Where everything lives

`~/.careerforge/`, or wherever `CAREERFORGE_HOME` points. One directory:

```
careerforge.db      the store — a cache of the export, not the source of truth
export/             the durable JSON copy; `rebuild` reconstructs the database
backups/            snapshots taken before migrations
blobs/              content-addressed payloads
```

Deleting that directory deletes everything CareerForge knows. There is no
account, no remote, and nothing left anywhere else on your system.

## Pre-1.0

`0.1.0` is pre-release software. The store schema is forward-migrated on every
upgrade and your export is the durable copy, so upgrading is safe — but
**`@careerforge/protocol` is unstable** and will change without a major version
bump until 1.0. Do not build an out-of-process plugin against it yet expecting
it to keep working.
