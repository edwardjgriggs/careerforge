# ADR-0023: A prompt is a versioned artifact, frozen once published

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M9
**Refines:** ADR-0002, ADR-0005

## Context

An enrichment is a claim about somebody's career made by a model. CareerForge
already refuses to let such a claim support anything (ADR-0020) and records
which evidence it read. Both are worthless if the question *"why does this year's
answer differ from last year's?"* cannot be answered.

Five things independently decide an enrichment's output:

```
the evidence          corrected, superseded, added, removed
the prompt            reworded, restructured, re-scoped
the provider          OpenAI, a local model, something not yet written
the model             a different one, or the same name resolving elsewhere
the parameters        temperature, token ceiling, seed
```

The usual arrangement makes four of the five invisible. Prompts live as string
literals near the code that sends them, so changing one leaves no trace; the
run record stores a single opaque hash, so two runs can be shown to differ and
nothing can be said about why. A user comparing two interpretations is told
"these are different" and left to guess.

Worse, an editable prompt makes every run record that references it a lie. The
record names `skills@1`; if `skills@1`'s text has since changed, the record
names text that never ran.

## Decision

**A prompt is an artifact with a version, and publishing one freezes it.**

Each template is `{ id, enrichmentType, instructions, schema, params }` with an
id carrying its version — `skills@1`. `templateHash` covers instructions,
schema, and parameters, and a committed lockfile pins every published hash. A
test compares the two, so editing a published template fails the build.
Changing behaviour means adding `skills@2`. Regenerating the lock is its own
command, `npm run lock:prompts`, so publishing a prompt is a deliberate act
visible in a diff rather than something a test run does quietly.

**Every dimension is recorded separately, and a difference is attributed
rather than merely observed.** `explainDifference` compares two runs and names
which of the five moved. Three consequences worth stating:

1. **`model` and `resolved_model` are different columns.** The first is what
   was asked for; the second is what the provider says answered. An alias
   advancing to a newer snapshot is one of the most common real causes of a
   changed interpretation and is completely invisible in the first. It gets its
   own dimension, `model_build`.

2. **When nothing changed and the output did, that is reported.** The cause is
   the model itself, which is not reproducible even at temperature zero. Saying
   `model_nondeterminism` is the honest answer; returning an empty list while
   the user looks at two different answers would teach them to stop trusting
   the record.

3. **The hashes are the record, not the prompt text.** A run stores
   `prompt_hash` and a template id that resolves to frozen text. The store
   never keeps the rendered prompt, which would mean keeping the evidence that
   went into it.

**A cache hit requires all five to match.** Anything looser returns an answer
produced by a different instrument and calls it the same answer, which is
precisely what a reproducibility record exists to prevent. Refused and unusable
runs are never cached — a failure must not become permanent by being
remembered.

## Consequences

**Good**

- A run recorded a year ago is fully reconstructible from its stored fields
  after the code that produced it has moved on. A test asserts it.
- Prompt changes become reviewable. A diff that adds `skills@2` and leaves
  `skills@1` untouched shows exactly what changed and leaves history intact.
- Re-running costs nothing when nothing moved, so running `enrich` over a whole
  store is not an act of faith.
- The instructions are static text with no interpolation, which is also what
  lets the transport guard treat anything secret-shaped in them as a bug.

**Costs**

- Improving a prompt means publishing a version rather than editing a line. It
  is friction, and it is the point — the friction is proportional to the
  consequence, which is that every existing run record's reference changes
  meaning.
- The template registry only grows. `skills@1` must resolve forever even after
  nobody would choose it, which is a small permanent cost against runs staying
  explicable.
- Five separate hashes are more machinery than one. Justified entirely by
  attribution: a single hash answers a question nobody asks.

## Alternatives considered

**Prompts in a config file, loaded at runtime.** Users could tune them without
a rebuild. Rejected: a prompt that varies per machine makes a run record
unreconstructible everywhere except the machine that made it, and the record is
the feature.

**Store the rendered prompt on the run.** Perfect reproducibility, trivially.
Rejected: the rendered prompt contains the evidence, so the audit trail would
become the largest concentration of sensitive text in the store — the same
reasoning that keeps payloads out of `policy_decisions` (ADR-0009).

**One run hash over everything.** Simpler schema, simpler cache. Rejected: it
answers "did anything change?" and never "what changed?", and the second is the
only question a person actually asks.

**Hash the template id along with its content.** Rejected: a rename would then
look like a rewrite. A template's identity is what it says.

**Warn instead of failing when the lock does not match.** Rejected: a warning
in a test run is a warning nobody reads, and the failure mode is silent —
records referencing text that never ran.

## Revisit if

- Users need per-project prompt customisation, which would require deciding
  whether a customised prompt is a new version or a different artifact class
  entirely.
- Providers begin exposing a stable snapshot identifier that makes
  `resolved_model` redundant.
- The number of published versions grows enough that resolution needs an
  archive rather than a constant, at which point "frozen forever" needs a
  storage story rather than a source file.
