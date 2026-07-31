# ADR-0030: `better-sqlite3` 12.x, because 13.x ships no prebuilt binaries

**Status:** Accepted
**Date:** 2026-07-31
**Milestone:** 0.2.0 launch
**Supersedes:** the driver-version half of ADR-0014
**Triggered by:** ADR-0014's "Revisit if" — *prebuilt binaries prove unreliable for real users on real platforms*

## Context

ADR-0014 chose `better-sqlite3@13` and accepted one cost explicitly: a native
dependency, mitigated by the prebuilt binaries the project publishes. The
mitigation was load-bearing. Without it, installing CareerForge means compiling
a C++ addon, and the audience is people who want to try a CLI rather than
people who want to configure a toolchain.

**The 13.x line publishes no prebuilt binaries at all.** Checked against the
upstream releases:

| Version | Prebuilt assets |
| ------- | --------------- |
| 13.0.2  | 0 |
| 13.0.1  | 0 |
| 13.0.0  | 0 |
| 12.11.1 | 138 |

13.x also declares no `install` script, so npm falls through to its default for
a package containing `binding.gyp`: `node-gyp rebuild`. Every install compiles,
on every platform, for every user.

That requires Visual Studio Build Tools and Python on Windows, the Xcode
command line tools on macOS, and a working gcc and make on Linux. Most
developers on Unix have those incidentally. **Most Windows users have none of
them**, and Windows is the platform this project calls a first-class matrix
entry from the first commit — and the platform its maintainer develops on,
which is exactly why the problem was invisible locally.

CI found it rather than a user, but only because CI is the only machine here
without a developer's toolchain already installed. The `windows-latest` runner
fails even though it *has* Visual Studio, because `node-gyp@11.5.0` cannot
identify the version it finds:

```
gyp ERR! find VS unknown version "undefined" found at
  "C:\Program Files\Microsoft Visual Studio\18\Enterprise"
gyp ERR! find VS Failure details: RangeError [ERR_CHILD_PROCESS_STDIO_MAXBUFFER]
```

So the failure mode is worse than "you need a compiler". It is "you need a
compiler, and the toolchain may not find it even when you have one."

Both of ADR-0014's falsification conditions are met. The second — *install
failures become a common first-run complaint* — had not happened yet only
because nothing had been released.

## Decision

**`packages/store` depends on `better-sqlite3@^12.11.1`.**

12.11.1 publishes prebuilds covering the supported matrix and beyond:

| Node ABI | Node version |
| -------- | ------------ |
| v127 | 22 |
| v137 | 24 |
| v141 | 25 |
| v147 | 26 |

across win32-x64, darwin arm64 and x64, and linux x64 and arm64. Its engines
field is `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`, so it constrains
nothing this project cares about.

**The Node 22 floor is unchanged.** It is now a choice rather than a
constraint: 12.x would run on Node 20, but ADR-0014's other reasons stand —
Node 20's maintenance window has closed, and `node:sqlite`, the eventual
destination, does not exist there.

No source change was required. The full suite — 953 tests — passes against
12.11.1 unmodified, and the packed release artifacts install offline and walk
the guided tour end to end.

## Consequences

**Good**

- `npm install -g careerforge` downloads a binary instead of invoking a
  compiler. This is the difference between a tool a Windows user can try and
  one they cannot.
- The Windows CI job stops depending on `node-gyp` correctly identifying a
  Visual Studio release that postdates it.
- The dependency is a downgrade in version number and an upgrade in
  reliability. Those are not the same axis, and the second one is the one
  users experience.

**Costs**

- 12.x is a major version behind, and will eventually stop receiving fixes.
  This is a deliberate hold, not neglect, and it is recorded here so the next
  person does not "helpfully" bump it.
- If 12.x stops publishing prebuilds for a future Node ABI, the supported Node
  range is capped at whatever it last built. That is the condition to watch,
  and it is in "Revisit if" below.
- A dependency pinned for packaging reasons rather than API reasons is a
  standing obligation to re-check upstream. The check is one command:
  `gh api repos/WiseLibs/better-sqlite3/releases/tags/vX.Y.Z --jq '.assets | length'`.

**Neutral**

- 12.11.1 bundles SQLite 3.53.2. Nothing in `packages/store` uses a feature
  newer than that, and the schema is created by our own migrations rather than
  by anything version-dependent.

## Alternatives considered

**Stay on 13.x and document the build prerequisites.** Honest, and the smallest
diff. Rejected because it makes "Windows is a first-class matrix entry" false
in the only way that matters to somebody trying to install it, and it converts
the first-run experience into a toolchain installation. A prerequisite that
most of the audience cannot satisfy is not a prerequisite; it is an exclusion.

**Stay on 13.x and pin CI to `windows-2022`.** Rejected as the worst available
option: it makes the runner green while leaving users broken, which is CI
lying. The value of the Windows job is that it is the one machine here without
a developer's toolchain.

**Publish our own prebuilds.** Correct in principle and wrong in scale. It
means a build matrix per ABI per platform per architecture, maintained by one
person alongside a full-time job, for a dependency somebody else already builds
correctly one major version back.

**Migrate to `node:sqlite`.** ADR-0014 names this the expected trigger, and it
is still the destination — it removes the native dependency permanently rather
than relocating it. Rejected *for now*, not on merit: it is experimental on
Node 22 and warns on import, and it means rewriting the store adapter and
re-proving migrations, export, and rebuild against a different API. That is a
milestone. This decision is what makes it possible to launch before doing it.

## Revisit if

- **13.x resumes publishing prebuilds.** Then the reason for the hold is gone
  and the version should move forward.
- **`node:sqlite` becomes stable.** Still the expected end state, and it makes
  this ADR moot rather than wrong.
- **12.x stops publishing prebuilds for a Node version this project supports.**
  That is the same failure arriving from the other direction, and it would
  force either the migration above or the prebuild matrix rejected above.
- A user reports an install that compiled from source anyway, which would mean
  the prebuild coverage is narrower than the release assets suggest.
