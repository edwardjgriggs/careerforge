# Writing a collector

A collector turns some source of artifacts — a repository, a transcript
directory, an issue tracker — into Evidence. It is the main extension point,
and the one with the strictest contract, because a collector runs against
somebody's real work.

## The contract

```ts
export interface CollectorPort {
  readonly manifest: CollectorManifest;
  collect(source: SourceRef, cursor: Cursor | null): AsyncIterable<CollectorEvent>;
}
```

Four things follow from that shape, and all four are enforced rather than
requested:

**A collector emits and never writes.** It yields events; the host decides what
to store. There is no store handle in the interface, so writing is not
something to remember to avoid (invariant I6).

**A collector is resumable.** It receives a cursor and yields cursors. Running
twice must produce no duplicates, which the conformance suite checks by running
your collector twice and asserting the second run emits nothing new.

**A collector is tolerant.** Real sources are malformed, truncated, and change
format without warning. Yield `{kind: 'skipped'}` for what you cannot parse and
`{kind: 'drift'}` for what you did not recognise, rather than throwing
(ADR-0010, ADR-0016). One bad record must never end a collection run.

**A collector reaches no network.** Lint prevents it. If your source is remote,
that is a conversation about capabilities before it is a pull request
(ADR-0009).

## The conformance suite

```ts
import { describeConformance } from '@careerforge/collect';

describeConformance('my-collector', () => new MyCollector(), { source });
```

Eight checks: idempotence, cursor monotonicity, manifest validity, attribute
schema conformance, tolerance of malformed input, absence of writes, stable
natural keys, and content-hash stability. It is a runner-agnostic test kit, so
it works outside this repository — a third-party collector can prove it
conforms without vendoring anything.

## Emitting good evidence

**`sourceUri` is identity.** `natural_key` is derived from your collector id
and this URI, so it must be stable across runs and unique within your source.
If a re-run produces a different URI for the same artifact, every record
duplicates.

**Attributes are structured; text is not.** Put counts, file lists, and
identifiers in `attributes`. That is what a `scope` claim is corroborated
against — a claim matched against prose would be corroborated by its own
restatement, so only attributes count.

**Record evidence, not secrets.** Preserve useful metadata without storing
sensitive command arguments. The session collector records that `git commit`
ran and deliberately not what was in the commit body.

**Classify sensitivity honestly.** If your source can contain pasted
credentials or client names — any transcript can — emit `restricted`. That
class never leaves the machine without a specific grant, and getting it wrong
is the mistake with the worst consequences.

**Set `evidenceClass` correctly.** `imported` for what you observed, `derived`
for what you computed. Never invent a `user_confirmed` record: that class
carries a human assertion and is the only thing that can support a claim about
leadership.

## Outcome-shaped evidence

No shipped collector observes *outcomes* — Git records commits, sessions record
conversations, and neither sees what changed afterwards. A collector that
emitted `git.merge`, `issue.closed`, or `deploy.completed` would make outcome
claims reachable by observation rather than only by interview. It is the most
valuable collector nobody has written yet.

## Pre-1.0

In-process collectors use `@careerforge/collect`. Out-of-process plugins will
use `@careerforge/protocol`, which is **unstable** and will change without a
major version bump until 1.0.
