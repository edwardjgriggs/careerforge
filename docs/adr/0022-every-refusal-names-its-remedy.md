# ADR-0022: Every refusal names the rule and the remedy

**Status:** Accepted
**Date:** 2026-07-30
**Milestone:** M8
**Refines:** ADR-0007, ADR-0009

## Context

CareerForge refuses more than most software, and on purpose. It will not infer
that you led something. It will not invent a number. It will not send
restricted work to a provider you have not approved. Each refusal is the
product working, and each one is a moment where a user decides whether the
product is protecting them or obstructing them.

That decision turns almost entirely on what the refusal says.

By M7 there were two independent refusal paths — claim support and, arriving in
M8, egress policy — and they had drifted into two different shapes. Claim
verdicts carried a `code` and a `reason`. Policy had no shape at all yet. Both
were on their way to the same failure: a message that explains what is wrong
and not what to do.

A refusal without a next step has a predictable outcome. The user cannot tell
whether the rule is protecting them or is a bug, has no path forward, and turns
the feature off. The careful enforcement then protects nobody, because it is
disabled. This is how privacy features die, and it is a design failure rather
than a user failure.

The M7 sequence showed what the alternative looks like: a `role` claim was
refused, the refusal named the question that would settle it, the interview
recorded an answer, and the same claim became recordable. The user learned
something true about their own evidence.

## Decision

**Every refusal is a record with four parts, and the fourth is required.**

```
code    stable and machine-readable
rule    which named, versioned rule decided — `restricted-default@1`
reason  one sentence, in words the user would use
remedy  what would have to change for the answer to be yes
```

`Remedy` is a closed union in the domain — `confirm`, `evidence`, `grant`,
`use_local_provider`, `reduce_payload`, `not_possible`. Closed on purpose:
adding a refusal without deciding its remedy is a compile error rather than a
gap somebody finds in production.

Four consequences worth stating:

1. **Rules are named and versioned.** A `PolicyDecision` recorded years ago
   must still be explicable after the code that produced it has moved. The
   audit trail stores the rule id, not a reference.

2. **All blocking rules are reported, not the first.** Reporting one problem at
   a time turns a privacy decision into whack-a-mole, and a user who fixes what
   they were told and is refused again stops believing the explanation.

3. **A `grant` remedy carries the exact command.** Not a description of what to
   do — the string to run, with the project and level already filled in from
   the request that failed.

4. **`not_possible` exists and is rare.** Some refusals genuinely have no user
   action: a caller holding `net` but not `egress` cannot be fixed by the
   person reading the message. Saying so plainly is the honest answer, and a
   test asserts every *other* refusal is actionable. If `not_possible` becomes
   common, the rule producing it is probably wrong.

The invariant ledger enforces this: one test walks every claim type and every
policy rule and asserts each refusal names a rule and an actionable remedy.

## Consequences

**Good**

- The two refusal paths say the same kind of thing, so every surface — CLI,
  the eventual UI, and whatever follows — renders them identically without
  each inventing its own phrasing.
- A refusal becomes a teaching moment about the user's own evidence rather
  than an obstacle. `careerforge preview` shows the blocked payload *and* the
  command that would permit it.
- New refusals cannot be added carelessly. The type system asks the question.

**Costs**

- Every rule author must decide the remedy, which is real work and is
  occasionally hard — deciding what a user could *do* is harder than deciding
  that something is wrong. That difficulty is a signal about the rule.
- The `Remedy` union will grow, and each addition touches a domain type shared
  by every refusal path. Deliberate: a new kind of remedy is a product
  decision, not an implementation detail.
- Remedies name commands, so a CLI rename breaks the strings. Worth it — a
  remedy that describes the command without giving it is markedly less useful,
  and the tests assert the exact text.

## Alternatives considered

**Leave claim and policy refusals with their own shapes.** Less coupling, and
they are genuinely different domains. Rejected: the user does not experience
them as different domains, and two vocabularies means two renderings of the
same idea, one of which will be worse.

**Free-text guidance in the `reason`.** What was already happening, and
cheapest. Rejected: prose cannot be tested, cannot be rendered differently by
surface, and drifts out of date silently when the command it describes changes.

**Return the first blocking rule only.** Simpler output and simpler code.
Rejected — see whack-a-mole above. The extra rules cost a few lines and save a
user from being refused three times for three reasons they were told about one
at a time.

**Make `remedy` optional.** Would have avoided touching M1's claim verdicts.
Rejected: optional means absent, absent means the refusals that most need a
remedy are the ones least likely to have one, and the whole value is in it
being unconditional.

## Revisit if

- A remedy needs to be conditional on something the rule cannot see — the
  user's other grants, say — which would argue for a remedy *resolver* rather
  than a value on the refusal.
- Refusals start needing to be ranked by severity rather than merely listed.
- The union stops being closable because refusals proliferate faster than
  remedies can be designed, which would be a signal that rules are being added
  without deciding what they mean for a person.
