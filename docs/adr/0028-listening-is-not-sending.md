# ADR-0028: Listening is not sending

**Status:** Accepted
**Date:** 2026-07-31
**Milestone:** M11
**Refines:** ADR-0009

## Context

Invariant I3 says only `@careerforge/policy` may reach the network, and lint
enforces it by banning `node:http`, `undici`, `fetch`, and every other client
module everywhere else. That rule has held without exception since M1 and it is
the reason egress cannot happen unenforced.

M11 needs a local web UI, and a web UI needs a server. `node:http` is on the
banned list. The rule as written forbids it.

The rule is right and the ban is too coarse. `node:http` exports two unrelated
capabilities that happen to share a module:

```
http.request / http.get     initiates a connection to somewhere else
http.createServer           accepts a connection from somewhere else
```

Only the first can move evidence off the machine. A server bound to `127.0.0.1`
answers the user's own browser and cannot originate a connection to anything.
Banning it protects nothing and would have forced the UI into a worse shape —
writing HTML files to disk and hoping a browser opens them, or adding a
third-party server dependency, which is strictly more surface than the one
Node function actually needed.

There is a real risk in the neighbourhood, though, and it is the binding. A
server on `0.0.0.0` is reachable from the local network, and the machine on the
other end of a coffee-shop Wi-Fi does not need to be an attacker for that to be
a serious mistake. The danger is not that a server exists; it is *where it
listens*.

## Decision

**`@careerforge/ui` may create an HTTP server. It may not make an HTTP
request.** Three things enforce it:

1. **Lint permits `node:http` in `packages/ui` and nothing else.** Every
   client module — `undici`, `axios`, `node-fetch`, `got`, and the rest — stays
   banned there, and so does the global `fetch`. The one allowed import is the
   one that cannot originate a connection.

2. **The bind host is not a parameter.** `createExplorerServer` binds
   `127.0.0.1` as a constant. There is no option, no environment variable, and
   no flag to change it — the CLI cannot pass `--host`, because a flag that
   exposes a career database to a network is a flag somebody will eventually
   set by accident or on advice from a forum post. A test asserts the listening
   address is loopback.

3. **The UI cannot generate egress by itself.** Every path that could send
   evidence anywhere — enrichment, generation — goes through the same command
   functions the CLI uses, and therefore through `policy`. The UI has no
   provider, no key handling, and no route to one.

**The UI is otherwise a normal adapter.** It may read the store and write
interview answers, both local operations. It sits at the same layer as the CLI
and inherits every gate the CLI does.

## Consequences

**Good**

- The Explorer needs no bundler, no framework, and no third-party server. The
  UI package's runtime dependency list is the store and the domain.
- The distinction is now stated rather than implied, which matters because the
  next person to need a listener — a plugin host, a webhook receiver — will
  face the same question and can read the answer.
- Making the bind host a constant rather than a default removes a class of
  configuration mistake entirely. Nothing to get wrong means nothing to review.

**Costs**

- I3's enforcement is no longer "no package but `policy` imports a network
  module". It is now that plus one carve-out, and a carve-out is a thing to
  maintain. The lint rule names the package explicitly and the boundary test
  asserts a client import is still refused there.
- A user who genuinely wants the Explorer on another device cannot have it.
  That is the intended answer — the right way is an SSH tunnel, which is the
  user's decision on their own machine rather than a checkbox in a career tool.
- `node:http` in the allowlist means somebody could write `http.request` in
  `packages/ui` and lint would not catch it. The boundary test covers the
  common clients; this specific hole is covered by review and by the fact that
  the UI has no reason to hold a provider.

## Alternatives considered

**Ban it and write HTML files to disk.** No server, no exception, and
`careerforge ui` becomes `careerforge export --html` plus "open this file".
Rejected: the interview cannot work — answering a question has to write to the
store, and a `file://` page cannot. The interactive Missing Information panel
is the acceptance criterion that matters most in this milestone.

**Ban it and take a third-party server dependency.** Rejected as strictly
worse: it adds far more surface than `http.createServer` while dodging the
question rather than answering it.

**Allow `node:http` everywhere and rely on the `fetch` ban.** Rejected:
`http.request` is exactly as capable of egress as `fetch`, and the point of I3
is that the capability lives in one package.

**Make the bind host configurable, defaulting to loopback.** The conventional
choice. Rejected: a default is a suggestion, and the failure mode is a personal
career database — transcripts, client names, unguarded opinions — served to a
network. The cost of the constant is one unhappy advanced user; the cost of the
flag is paid by whoever sets it without understanding.

## Revisit if

- A second package needs to listen, which would argue for a shared "server"
  capability rather than a per-package exception.
- Node's module layout changes such that server and client capabilities can be
  imported separately, which would let lint express the real rule directly.
- Users need remote access often enough that documenting an SSH tunnel stops
  being a sufficient answer.
