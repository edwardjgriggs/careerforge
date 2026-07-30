/**
 * Deterministic redaction.
 *
 * Same input and same profile produce the same output on every machine and in
 * every release, because a redaction that varies is a redaction nobody can
 * audit — and because `PolicyDecision` records a profile version rather than
 * the payload, so the only way to check what was sent is to run the profile
 * again.
 *
 * ── What this cannot do ──────────────────────────────────────────────────
 *
 * Patterns catch what has a shape: keys, tokens, certificate blocks,
 * connection strings, authorization headers. They do not catch a client's name
 * in a sentence, an unreleased product detail, or a frank opinion about a
 * colleague. Those are the residual class, and the payload preview is the
 * honest mitigation for them — which is why the preview is mandatory rather
 * than advisory (ADR-0009).
 *
 * Overstating redaction is worse than having none. It converts an informed
 * user into a trusting one.
 */

export const REDACTION_PROFILE = 'default@1';

export interface RedactionRule {
  /** Stable name, so a report says which rule fired. */
  readonly id: string;
  readonly pattern: RegExp;
  /** What appears instead. Describes the removal rather than hiding it. */
  readonly replacement: string;
}

/**
 * Ordered, because earlier rules claim text later ones would also match.
 *
 * A PEM block must be removed whole before the high-entropy rule sees its
 * body, or the report would say "12 secrets" for one key.
 */
export const DEFAULT_RULES: readonly RedactionRule[] = [
  {
    id: 'pem-block',
    pattern:
      /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|RSA KEY)-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|RSA KEY)-----/g,
    replacement: '[redacted: private key or certificate]',
  },
  {
    id: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    replacement: '[redacted: AWS key id]',
  },
  {
    id: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    replacement: '[redacted: GitHub token]',
  },
  {
    id: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: '[redacted: Slack token]',
  },
  {
    id: 'openai-key',
    pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[redacted: provider API key]',
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{30,40}\b/g,
    replacement: '[redacted: Google API key]',
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[redacted: token]',
  },
  {
    id: 'authorization-header',
    pattern: /\b(Authorization|X-Api-Key|X-Auth-Token)\s*:\s*\S+/gi,
    replacement: '$1: [redacted]',
  },
  {
    id: 'connection-string-url',
    // A URL carrying credentials. The host survives; the credentials do not.
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/([^\s:/@]+):([^\s/@]+)@/gi,
    replacement: '$1://[redacted]@',
  },
  {
    id: 'connection-string-kv',
    pattern: /\b(Password|Pwd|User Id|Uid|AccountKey|SharedAccessKey)\s*=\s*[^;"'\s]+/gi,
    replacement: '$1=[redacted]',
  },
  {
    id: 'secret-assignment',
    // `KEY=value` and `"key": "value"` where the name says it is a secret.
    //
    // The value must look like a literal. A *name* is not a secret: the
    // corpus caught this rule redacting
    // `const accessToken = await auth.exchange(code)`, which is ordinary code
    // mentioning a token rather than containing one. Quoted strings and
    // unbroken credential-shaped runs qualify; bare words and expressions do
    // not.
    pattern:
      /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_.-]*)("?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[A-Za-z0-9_\-+/=]{8,})/gi,
    replacement: '$1$2[redacted]',
  },
  {
    id: 'email-address',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[redacted: email]',
  },
  {
    id: 'home-directory-path',
    // The username, not the path. Where a file sits is useful evidence; whose
    // machine it sits on is not, and it identifies the person and often the
    // employer.
    pattern: /((?:\/home\/|\/Users\/)|(?:[A-Za-z]:\\Users\\))([^/\\\s"']+)/g,
    replacement: '$1[user]',
  },
];

export interface RedactionFinding {
  readonly ruleId: string;
  readonly count: number;
}

export interface RedactionReport {
  readonly profile: string;
  readonly findings: readonly RedactionFinding[];
  readonly totalRedactions: number;
  /** Bytes removed. A crude but honest measure of how much was withheld. */
  readonly charactersRemoved: number;
}

export interface Redacted {
  readonly text: string;
  readonly report: RedactionReport;
}

/**
 * Apply a profile.
 *
 * Every rule runs over the whole text and the count of each is reported, so
 * "nothing was redacted" and "we did not look" are distinguishable.
 */
export function redact(
  input: string,
  rules: readonly RedactionRule[] = DEFAULT_RULES,
  profile: string = REDACTION_PROFILE,
): Redacted {
  let text = input;
  const findings: RedactionFinding[] = [];

  for (const rule of rules) {
    let count = 0;
    // A fresh regex per call: a global regex carries `lastIndex` between uses,
    // which would make results depend on how often the module had been used.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(pattern, (...args) => {
      count++;
      return expand(rule.replacement, args);
    });
    if (count > 0) findings.push({ ruleId: rule.id, count });
  }

  return {
    text,
    report: {
      profile,
      findings,
      totalRedactions: findings.reduce((sum, finding) => sum + finding.count, 0),
      charactersRemoved: Math.max(0, input.length - text.length),
    },
  };
}

/** Expand `$1`-style references without letting `$` in matched text expand. */
function expand(replacement: string, args: readonly unknown[]): string {
  return replacement.replace(/\$(\d)/g, (_, digit: string) => {
    const group = args[Number(digit)];
    return typeof group === 'string' ? group : '';
  });
}

/**
 * Whether a second pass would change anything.
 *
 * Idempotence rather than "no rule fires", because a replacement can legally
 * match the rule that produced it — `Authorization: [redacted]` still looks
 * like an authorization header. What matters is that nothing further is
 * removed, which means the first pass was complete.
 */
export function hasResidualSecrets(
  text: string,
  rules: readonly RedactionRule[] = DEFAULT_RULES,
): boolean {
  return redact(text, rules).text !== text;
}
