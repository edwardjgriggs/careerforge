# Redaction fixtures

**Every credential in `credentials.jsonl` is fabricated. None of them has ever been
valid anywhere.**

If you arrived here from a secret scanner, that is the file it matched, and this is the
explanation. Please do not open an issue reporting a leaked token — but if you believe one
of these is a _real_ credential rather than a synthetic one, that is a security report and
[SECURITY.md](../../../SECURITY.md) is the right channel.

## Why they look real

`packages/policy` is the only package permitted to move evidence off the machine, and the
deterministic redaction pass is the control that runs before it does. A corpus of obviously
fake strings — `SECRET_HERE`, `xxxxx` — would test nothing. A pattern that catches
`AKIA_FAKE_KEY` and misses a real AWS key ID is worse than no pattern at all, because it
reports a clean payload to somebody about to approve one.

So the fixtures carry the real _shape_ of each credential type and none of the substance.
The tells are deliberate and left visible: `EXAMPLE` embedded in the AWS keys, identical
team and bot identifiers in the Slack token, `hunter2` and `Tr0ub4dor` as passwords,
`.example` domains throughout, and `ThatIsNotReal` in the key material.

`ordinary.jsonl` is the other half of the same test: text that must survive untouched. A
redactor that removes everything passes any test built only from secrets.

## GitHub push protection

The Slack entry matches GitHub's detector on shape, so it is registered in this
repository's push-protection allowlist as a test fixture. That entry is what lets
contributors push the file; it is not a dispensation for real secrets, and push protection
remains on for everything else.

## Adding a case

Add the shape, never a working credential — not an expired one, not a revoked one, not one
from a sandbox account. Give it a visible tell like the ones above. Then add the matching
negative case to `ordinary.jsonl` if the new pattern could plausibly fire on ordinary
prose, because that is the failure mode nobody notices until a user's work has been
silently mangled.
