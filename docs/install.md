# Installing

## Requirements

**Node.js 22.0 or newer.** Not negotiable: the SQLite driver requires it, and
`node:sqlite` does not exist on 20 (ADR-0014). `careerforge doctor` checks it
and says so plainly if yours is older.

CareerForge is developed on Windows and tested on Windows, macOS, and Linux on
every commit. Windows is a first-class matrix entry rather than something added
after a bug report.

## From npm

```bash
npm install -g careerforge
careerforge tour
```

`careerforge` is a four-line forwarder onto `@careerforge/cli`; installing
either works, and the unscoped name exists because it is the one people type.

Every package is published with [npm
provenance](https://docs.npmjs.com/generating-provenance-statements), so the
registry can show you which commit and which workflow run produced the tarball
you just installed. You do not have to take our word for what is in it.

## From a release, without a registry

The releases page carries the same tarballs and a checksum file. Verify, then
install the whole set at once — the packages depend on each other, so
installing one of them alone will send npm looking for the rest:

```bash
sha256sum -c SHA256SUMS
npm install -g --offline ./*.tgz
```

`--offline` is the point rather than a convenience: if it succeeds, nothing was
fetched, and what you verified is exactly what you installed. A download nobody
can verify is a download nobody should run.

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

`0.2.0` is pre-release software. The store schema is forward-migrated on every
upgrade and your export is the durable copy, so upgrading is safe — but
**`@careerforge/protocol` is unstable** and will change without a major version
bump until 1.0. Do not build an out-of-process plugin against it yet expecting
it to keep working.
