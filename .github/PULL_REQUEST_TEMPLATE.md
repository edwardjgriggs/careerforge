<!--
Explain the why. The what is visible in the diff.
One concern per PR — easier to review, easier to revert.
-->

## What this changes, and why

## Checklist

- [ ] `npm run verify` passes locally, on my platform
- [ ] Tests ship with the change, not after it
- [ ] One concern
- [ ] If this touches a decision recorded in an ADR, the PR says which one and why the
      decision still holds — or a new ADR supersedes it

## Invariants

Tick the ones this change comes near, and say how it stays inside them. Leave the rest.

- [ ] **I1 — the domain layer stays pure.** No I/O, no network, no AI SDK, no sibling
      packages. It cannot even see Node's types.
- [ ] **I2 — nothing is mutated.** No `UPDATE`, no `DELETE`. Corrections supersede;
      deletions tombstone.
- [ ] **I3 — only `policy` reaches the network.** Every outbound call passes through the
      Policy Engine.
- [ ] **I4 — no claim without support.** Generation refuses to emit an assertion with no
      provenance. `role` and `metric` require confirmed or computed support.
- [ ] **I5 — the database is reconstructible from `export/`.**
- [ ] **I6 — collectors emit and never write.**

<!--
If you cannot see how to make the change without crossing one of these, that is worth
saying out loud in the PR rather than working around. It may mean the invariant is wrong,
which is a finding, not a failure — see CONTRIBUTING.md.
-->
