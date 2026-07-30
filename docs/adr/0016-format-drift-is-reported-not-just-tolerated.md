# ADR-0016: Format drift is reported, not just tolerated

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M5

## Context

ADR-0010 made tolerant parsing a platform rule: a collector declares a narrow
required field set, ignores everything else, and never fails a run over an
unrecognised record. That rule is correct and this decision does not weaken it.

It is also incomplete. A collector that ignores everything it does not
recognise will keep working forever while quietly ignoring more and more, and
nothing in the system says so. The failure mode is not a crash. It is a field
appearing upstream that carries real career evidence, being dropped on every
run for years, and nobody finding out.

The AI Coding Session collector made this concrete rather than theoretical:

- The measured corpus carried **14 distinct schema versions in 30 days**.
- A record type (`custom-title`) appeared between the format survey and the
  implementation, a gap of hours.
- The **first run against a real corpus** surfaced 2 further record types and
  13 fields the survey had never seen — including `isCompactSummary`, which
  marks a record whose content is model-written and which the parser was
  treating as something a person typed.

That last one is the argument. Field-level drift was not cosmetic; it was
hiding a correctness bug, and record-type-level reporting would not have found
it.

`CollectionReport` already counted `skipped` and `unknownRecordTypes`, both of
which are about *artifacts*. There was nowhere to record an observation about
the *format*.

## Decision

**`CollectorEvent` gains a fourth variant, and `CollectionReport` a fourth
tally.**

```ts
| { readonly kind: 'drift'; readonly signal: string }
```

The four events are distinguished by what they are about:

| Event | About | Counts toward `seen` |
|---|---|---|
| `evidence` | an artifact that became evidence | yes |
| `skipped` | an artifact examined and deliberately not emitted | yes |
| `unknown` | an artifact examined and not understood at all | yes |
| `drift` | the **source format**, not an artifact | **no** |

Drift does not count toward `seen` because the artifact it was noticed on is
already counted. Counting it again would inflate the tally of work done.

Three supporting rules, each learned from the data:

1. **Signals are counted once per source artifact, not once per record.** "Six
   sessions carry a field we do not know" is actionable. The record count of a
   field present on every line is not, and would drown a rarer signal that
   matters more.
2. **Signals are fixed strings, never interpolated with counts.** A signal is
   an aggregation key; `2 bad lines` and `3 bad lines` must not become two
   findings.
3. **Distinct signals are capped per run**, with the overflow reported. A
   wholesale format change should produce a readable report, not a thousand
   lines.

Drift is **printed by default** in `formatReport`, under a heading that says
what it means in plain words: *"source format has changed since this collector
was written."*

## Consequences

**Good**

- Tolerance stops being indistinguishable from blindness. The system can now
  say what it ignored.
- Drift reports are a maintenance queue: each signal is either extracted or
  acknowledged by adding it to the known set, and the report goes quiet again.
  It went quiet on the same day it was built.
- It found a real bug on its first run against real data.

**Costs**

- One more variant in the contract every collector author reads. Mitigated by
  it being optional — a collector that never emits `drift` is still conformant.
- The known-field sets need maintaining, and a neglected collector will report
  drift that nobody acts on. That is strictly better than a neglected collector
  that reports nothing.

**Not decided here**

- Drift is not persisted. It lives in the report for the run that produced it.
  Trend detection across runs would need storage, and there is no evidence yet
  that a single run's report is insufficient.

## Alternatives considered

**Leave it at ADR-0010.** Rejected once measurement showed the format changing
every 2–3 days. Tolerance without observation is a promise that the collector
will silently degrade.

**Reuse the `unknown` event with a synthetic record type such as
`"field:promptSource"`.** Avoids a contract change, and was tempting for that
reason alone. Rejected: it inflates `seen` with things that are not artifacts,
and encoding a second meaning into a field named `recordType` is the kind of
shortcut that is cheap once and confusing forever.

**Log a warning to stderr.** Rejected. Warnings are not data — they cannot be
counted, aggregated, or tested, and a CLI that prints warnings during a
long-running collection trains its user to ignore them.

**Fail the run on unknown input.** Rejected outright; this is exactly what
ADR-0010 forbids and what a source releasing every 2–3 days would punish
weekly.

## Revisit if

- Collectors start emitting drift that nobody ever acts on, making the channel
  noise. The fix would be to make acknowledgement explicit in the manifest
  rather than to remove the channel.
- Trend detection across runs becomes necessary — for example, to notice a
  signal that is growing rather than one that is merely present. That needs
  persistence and a schema, and should be its own decision.
- A second collector needs drift signals with structure rather than a string
  (a code, a severity, a suggested action). One collector is not enough
  evidence to design that.
