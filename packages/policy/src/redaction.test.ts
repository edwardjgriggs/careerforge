import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hasResidualSecrets, redact, DEFAULT_RULES, REDACTION_PROFILE } from './redaction.js';

/**
 * Redaction, against two corpora that pull in opposite directions.
 *
 * The credential corpus asserts that secrets never survive. The ordinary
 * corpus asserts that everything else does — and that half matters as much,
 * because redaction which destroys legitimate content makes enrichment useless
 * and teaches users to switch it off, at which point the careful redaction
 * protects nobody.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const load = <T>(name: string): T[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);

const credentials = load<{ name: string; text: string; secret: string }>('credentials.jsonl');
const ordinary = load<{ name: string; text: string }>('ordinary.jsonl');

describe('the credential corpus', () => {
  it('has cases to run', () => {
    expect(credentials.length).toBeGreaterThanOrEqual(20);
  });

  it.each(credentials.map((c) => [c.name, c] as const))('%s never survives', (_name, testCase) => {
    const { text, report } = redact(testCase.text);
    expect(text, 'the secret survived redaction').not.toContain(testCase.secret);
    expect(report.totalRedactions, 'nothing was redacted at all').toBeGreaterThan(0);
  });

  it('leaves nothing a second pass would still catch', () => {
    // If a rule can fire on the output, the first pass was incomplete.
    for (const testCase of credentials) {
      expect(hasResidualSecrets(redact(testCase.text).text), testCase.name).toBe(false);
    }
  });

  it('says which rule fired, so a report is checkable', () => {
    const { report } = redact(credentials.map((c) => c.text).join('\n\n'));
    expect(report.profile).toBe(REDACTION_PROFILE);
    expect(new Set(report.findings.map((f) => f.ruleId)).size).toBeGreaterThan(6);
  });
});

describe('the ordinary corpus', () => {
  it('has cases to run', () => {
    expect(ordinary.length).toBeGreaterThanOrEqual(15);
  });

  it.each(ordinary.map((c) => [c.name, c] as const))(
    '%s survives byte-identical',
    (_name, testCase) => {
      const { text, report } = redact(testCase.text);
      expect(text).toBe(testCase.text);
      expect(report.totalRedactions, `redacted: ${JSON.stringify(report.findings)}`).toBe(0);
    },
  );
});

describe('determinism', () => {
  it('produces the same output every time', () => {
    const input = credentials.map((c) => c.text).join('\n');
    const first = redact(input);
    for (let n = 0; n < 5; n++) {
      expect(redact(input).text).toBe(first.text);
    }
  });

  it('does not carry regex state between calls', () => {
    // A global regex keeps `lastIndex`. Reusing one across calls would make
    // the result depend on how often the module had been used, which is the
    // subtlest possible way to break an audit.
    const input = 'AKIAQY7EXAMPLE4NPTZW';
    const runs = Array.from({ length: 4 }, () => redact(input).text);
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).not.toContain('AKIA');
  });

  it('reports how much was withheld', () => {
    const { report } = redact(
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    );
    expect(report.charactersRemoved).toBeGreaterThan(0);
  });

  it('names its profile, so a decision can be re-run years later', () => {
    expect(REDACTION_PROFILE).toMatch(/^[a-z]+@\d+$/);
    expect(DEFAULT_RULES.every((rule) => rule.id.length > 0)).toBe(true);
  });
});
