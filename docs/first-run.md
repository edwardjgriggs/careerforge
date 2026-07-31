# First run

## Start with the tour

```bash
careerforge tour
```

Fifteen minutes, no API key, no network, and it touches nothing of yours. It
builds a small sample store, runs the real commands against it, and after each
step says what just happened and why the system works that way.

It is the fastest way to find out whether you want this, because the thing that
makes CareerForge different is not a feature — it is what it refuses to do, and
you have to watch that happen to believe it.

Remove the sample store when you are done:

```bash
careerforge tour --reset
```

## Then your own work

```bash
careerforge init
careerforge collect --backfill
careerforge group
careerforge ui
```

That is the whole first run. What each step does:

**`init`** creates `~/.careerforge/`. Everything CareerForge writes lives under
that one directory, so you can back it up, move it, or delete it without
hunting.

**`collect --backfill`** reads your Git history and your AI coding sessions. It
writes nothing to either — collection is a read, and the collectors are
structurally incapable of writing (invariant I6). Nothing leaves your machine.

> **Your AI coding transcripts are deleted after 30 days by default.** If you
> use Claude Code, the record of what you were thinking while you worked is
> already expiring. Collecting is preservation, not convenience — this is the
> single strongest reason to run the backfill sooner rather than later.

**`group`** turns thousands of artifacts into units of work at the size a
person actually describes work: not a commit, not a quarter. Run it as often as
you like; it is idempotent.

**`ui`** opens Evidence Explorer, bound to `127.0.0.1` and not configurable.

## Writing something

Generation is the only part that needs an API key.

```bash
export OPENAI_API_KEY=sk-...
careerforge units                                        # pick a unit
careerforge generate resume-bullet --unit <id>
```

Expect it to refuse things. A model will propose that you led the work and that
you improved something by 40%; both are removed unless your evidence carries
them, and each becomes a question instead:

```bash
careerforge interview --unit <id>
careerforge interview --gap <gap-id> --answer "I led it and set the approach."
careerforge generate resume-bullet --unit <id> --force
```

Answering makes your *evidence* stronger. The words already written do not
change until you regenerate — a statement improves when it is rebuilt from the
evidence, and not a moment before.

## Before anything leaves

Nothing is sent until you allow it, per project:

```bash
careerforge preview --unit <id> --provider openai   # the exact bytes
careerforge consent grant --provider openai --project <key> --level confidential
```

Read the preview. Pattern redaction catches keys and tokens; it cannot catch a
client's name in a sentence, and the preview says so every time.

## Publishing

```bash
careerforge review <asset-id>            # read it
careerforge review <asset-id> --accept
careerforge assets --markdown
```

A draft cannot be exported. Neither can something you rejected. The gate is in
the export path, not in a screen, so a script inherits it too.

## When something looks wrong

```bash
careerforge doctor
```

It checks your Node version, the store, the schema, whether any collector has
run, what consent is in place, whether a key is configured, and whether your
export is stale. Every check that is not `ok` names a next step.

## What runs without an API key

Everything except `generate` and `enrich`:

`tour` · `collect` · `group` · `units` · `explain` · `interview` · `review` ·
`assets` · `consent` · `preview` · `ui` · `search` · `timeline` · `export` ·
`rebuild` · `reindex` · `doctor`

That is not a limitation to work around. AI is additive here by design
(ADR-0005), and the build graph enforces it: the domain package cannot import a
provider SDK at all.
