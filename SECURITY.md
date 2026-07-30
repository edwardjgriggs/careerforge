# Security Policy

CareerForge reads a person's work product — commit history, documents, calendars, AI coding
sessions — and holds AI provider keys. A vulnerability here is not an inconvenience. Please
report responsibly, and we will respond seriously.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through **[GitHub Security Advisories](https://github.com/edwardjgriggs/careerforge/security/advisories/new)**,
or by email to **ejg7cc@gmail.com** with `CareerForge Security` in the subject.

Please include: what you found, how to reproduce it, the affected version or commit, and what
an attacker could achieve. A proof of concept helps enormously.

### What to expect

|                        | Target                    |
| ---------------------- | ------------------------- |
| Acknowledgement        | 72 hours                  |
| Initial assessment     | 7 days                    |
| Fix or mitigation plan | 30 days for high severity |

This project is currently maintained by one person alongside a full-time job. These are honest
targets, not a contractual SLA. If you have not heard back within a week, please send a reminder —
it means the message was missed, not ignored.

## Scope

CareerForge is local-first. There is no CareerForge-operated server holding user data, so the
attack surface is the software on the user's machine.

**In scope — please report:**

- Any path by which evidence leaves the machine without passing the Policy Engine, or without
  matching consent. This is the most serious class of bug in the project.
- Redaction failures where a credential pattern in the documented set survives into an outbound
  payload.
- Plugins performing operations beyond their granted capabilities, or escaping process isolation.
- Path traversal, command injection, or unsafe deserialization in collectors, which process
  untrusted third-party file formats.
- Credential exposure through logs, error messages, exports, or crash reports.
- Local privilege escalation via file permissions in the CareerForge home directory.
- Anything that lets one project's evidence reach a provider only consented to for another.

**Out of scope:**

- Vulnerabilities in AI providers, sync destinations, or other third-party services.
- Anything requiring an attacker to already have full control of the user's account.
- Sensitive content that redaction is documented as unable to detect — client names in prose,
  personnel discussion, unreleased product details. This limitation is stated plainly in the
  privacy documentation and mitigated by the mandatory payload preview. If you can show a
  _class_ of secret that should be deterministically detectable but is not, that **is** in scope.
- Missing hardening with no demonstrated impact.

## Supported versions

Pre-1.0, only the latest release is supported. The plugin protocol is explicitly unstable until
1.0 and carries no compatibility guarantee.

## Disclosure

We prefer coordinated disclosure. Once a fix ships, we will publish an advisory crediting you
unless you ask otherwise. If you plan to publish independently, please give us 90 days, or less
if the issue is being actively exploited — tell us and we will move faster.
