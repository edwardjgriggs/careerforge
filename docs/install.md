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

## Verifying what you installed

Releases are cut by [the release
workflow](../.github/workflows/release.yml), which publishes with [npm
provenance](https://docs.npmjs.com/generating-provenance-statements) — an
attestation recording which commit, which repository, and which workflow run
produced the tarball.

Do not take that on trust. Check it:

```bash
npm view careerforge dist.attestations
```

**If that prints nothing, the version you have was not published through the
pipeline and carries no attestation.** Treat it as unverified. A claim about
provenance that you cannot check yourself is exactly the kind of claim this
project exists to argue against, so the command is here rather than the
reassurance.

## From a release, verifying what you got

Tagged releases carry the same tarballs and a `SHA256SUMS` file on the
[releases page](https://github.com/edwardjgriggs/careerforge/releases). Verify,
then install the whole set at once — the packages depend on each other, so
installing one of them alone will send npm looking for the rest:

```bash
sha256sum -c SHA256SUMS
npm install -g ./*.tgz
```

The `./` matters. Without it npm reads `careerforge-0.2.1.tgz` as a package
name rather than a file, and goes looking for it on the registry.

**One thing will still be fetched, and it is worth being exact about.**
`better-sqlite3` is a native dependency, it is not in these tarballs, and npm
will download it. Every `@careerforge` package comes from the files you just
checksummed; the storage driver comes from the registry, as it would under any
other install.

Adding `--offline` will therefore fail on a machine that has never installed it
before, which is the honest reason this page no longer tells you to. The
release pipeline does run that check — with the third-party cache warmed first,
so that a failure means one of *our* packages went to the network, which is the
thing actually worth asserting.

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

`0.2.1` is pre-release software. The store schema is forward-migrated on every
upgrade and your export is the durable copy, so upgrading is safe — but
**`@careerforge/protocol` is unstable** and will change without a major version
bump until 1.0. Do not build an out-of-process plugin against it yet expecting
it to keep working.
