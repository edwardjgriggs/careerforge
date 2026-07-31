# careerforge

## 0.2.1

### Patch Changes

- The first release published by the release workflow rather than by hand.

  0.2.0 was published from a laptop, so no package carried a provenance attestation and no
  tarballs or checksums ever reached the releases page — while the README claimed both. This
  release exists so that the claim and the artifact agree. `npm view careerforge dist.attestations`
  is the check, and `docs/install.md` now says what an empty answer means.

  It also closes a gap between what was published and what is committed: `@careerforge/store@0.2.0`
  declares `better-sqlite3@^13.0.2` and the source has since been held at `^12.11.1`, where the
  prebuilt binaries are.

  No functional change. Package descriptions and keywords were rewritten for discoverability,
  and every third-party GitHub Action is now pinned to a commit SHA.

- Updated dependencies
  - @careerforge/cli@0.2.1

## 0.2.0

### Minor Changes

- 3ca4d73: Initial public release of CareerForge.

### Patch Changes

- Updated dependencies [3ca4d73]
  - @careerforge/cli@0.2.0
