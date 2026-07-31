# The privacy model

CareerForge reads the most sensitive material on your machine: your commit
history, your coding transcripts, and eventually your own answers about your
career. This page says exactly what happens to it. Where a guarantee is
enforced by code rather than by intention, it says which code.

## Nothing leaves unless you say so

There is one place in the entire codebase that can put your evidence on a
network, and it is the policy engine. Every other package — the domain, the
store, the collectors, the enrichment layer, the generator, the UI — is cut off
from every HTTP client and from the global `fetch` by lint (invariant I3). The
rule is checked on every build and by tests that write deliberately illegal
code and assert it is refused.

The choke point shipped in M8, before any provider existed in M9. There has
never been a release in which egress was possible without enforcement.

**A provider is not handed a payload.** It is handed a *decision* — the object
the engine produces after evaluating your consent, containing the exact
redacted bytes it approved. There is no parameter through which a caller could
substitute anything else. Bypassing the gate is not discouraged; it is
unspellable.

## Consent is per project, and there is no global switch

```bash
careerforge consent grant --provider openai --project my-repo --level confidential
```

Deliberately per project, so client work can stay on your machine while
personal work does not. There is no "allow everything" option, because the
failure mode of one is that somebody enables it once and never thinks about it
again.

**Restricted work never leaves by default.** Your AI coding transcripts are
classified `restricted`, and a `confidential` grant does not cover them. You
have to say so specifically, for that project.

**An unknown provider is treated as remote.** Guessing "local" for something
CareerForge cannot identify would fail open, and this is the one place where
failing open is unacceptable.

## You see the bytes before they go

```bash
careerforge preview --unit <id> --provider openai
```

Mandatory rather than advisory, and it works *even when the answer is no* —
seeing what would leave is how you decide whether to allow it.

**What redaction can and cannot do.** A versioned, deterministic profile
(`default@1`) removes API keys, tokens, connection strings, private keys, and
authorization headers. It is tested against two corpora pulling in opposite
directions: 21 credential cases that must never survive, and 15 ordinary code
samples that must survive byte-identical.

It **cannot** catch a client's name in a sentence, a frank opinion about a
colleague, or an unreleased product mentioned in passing. The preview says so
every time it runs. Overstating redaction would convert an informed user into a
trusting one, which is worse than having none.

## Every refusal explains itself

A refusal names the rule that decided, why, and what would change the answer:

```
REFUSED — nothing would be transmitted.

  BLOCKED by restricted-default@1
    This includes work classified restricted — session transcripts and the
    like — which never leaves your machine unless you say otherwise.
    -> Use a provider that runs on this machine. Or raise the level:
       careerforge consent grant --provider openai --project x --level restricted
```

`Remedy` is a closed union in the domain, so adding a refusal without deciding
what a user could do about it is a compile error (ADR-0022).

## What is recorded about what left

Every evaluation — permitted or refused — writes a `policy_decisions` row: the
provider, the purpose, the rules that blocked, the redaction report, and a
**hash of the payload, never the payload**. Keeping what was sent would make
the audit trail the largest concentration of sensitive data in your store,
which is precisely the thing being guarded.

The table is append-only, enforced by database trigger. Revoking consent writes
a row rather than deleting one, so *"I revoked this in March"* stays answerable
in December.

## The AI cannot write facts

The packages that talk to models (`enrich`, `generate`) cannot import the store
or any database driver — enforced by lint, asserted by a test. They produce a
description of what should be recorded and hand it back. An AI interpretation
can accompany a claim and explain how it came to be worded; it can never be a
reason to believe it, and the database `CHECK` constraint refuses to express it
even if the code tried.

## The UI listens, it never sends

Evidence Explorer binds `127.0.0.1`. Not by default — as a constant, with no
flag, no environment variable, and no option (ADR-0028). The page fetches
nothing from anywhere: no CDN, no fonts, no framework.

## Deleting things

`careerforge` never destroys history, which is what makes provenance
trustworthy. To remove something from what CareerForge will use:

```bash
careerforge export     # the JSON tree is the durable copy
```

Everything lives under `~/.careerforge/`. Deleting that directory deletes
everything CareerForge knows, with no residue elsewhere on your system and no
account to close.

## What CareerForge never does

- Phone home. There is no telemetry, no analytics, and no update check.
- Send anything on install, on first run, or during the tour.
- Read anything outside your Git repositories, your AI session directory, and
  its own store.
- Write to any repository or transcript it reads.
