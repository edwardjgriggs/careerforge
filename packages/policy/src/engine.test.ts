import { describe, expect, it } from 'vitest';

import { isActionable, SENSITIVITY_LEVELS, type Sensitivity } from '@careerforge/domain';

import {
  evaluate,
  preview,
  POLICY_RULES,
  type ConsentGrant,
  type PayloadItem,
  type Provider,
} from './engine.js';

/**
 * The egress choke point.
 *
 * The matrix below is the whole product promise expressed as a truth table:
 * every sensitivity, against every provider locality, against every grant
 * state. It ships before any provider exists, so there is never a release in
 * which egress is possible without these rules deciding first.
 */

const remote: Provider = { id: 'openai', locality: 'remote' };
const local: Provider = { id: 'ollama', locality: 'local' };

const item = (sensitivity: Sensitivity, projectKey: string | null = 'acme'): PayloadItem => ({
  kind: 'evidence',
  id: `ev-${sensitivity}`,
  sensitivity,
  projectKey,
  text: `some ${sensitivity} work`,
});

const grantOf = (maxSensitivity: Sensitivity, revoked = false): ConsentGrant => ({
  projectKey: 'acme',
  providerId: 'openai',
  maxSensitivity,
  revoked,
});

const noConsent = () => null;
const consentAt =
  (level: Sensitivity, revoked = false) =>
  () =>
    grantOf(level, revoked);

const request = (provider: Provider, items: readonly PayloadItem[]) => ({
  provider,
  purpose: 'enrich',
  items,
});

describe('the consent matrix', () => {
  it.each(SENSITIVITY_LEVELS)('a local provider needs no grant for %s work', (level) => {
    // Nothing leaves the machine, so there is nothing to consent to. This is
    // what makes `restricted` workable rather than merely restrictive.
    const decision = evaluate(request(local, [item(level)]), { consent: noConsent });
    expect(decision.allowed).toBe(true);
    expect(decision.refusals).toEqual([]);
  });

  it.each(SENSITIVITY_LEVELS)('a remote provider is refused %s work with no grant', (level) => {
    const decision = evaluate(request(remote, [item(level)]), { consent: noConsent });
    expect(decision.allowed).toBe(false);
    expect(decision.refusals[0]!.rule).toBe('consent-required@1');
  });

  it.each(SENSITIVITY_LEVELS)('a revoked grant blocks %s work immediately', (level) => {
    const decision = evaluate(request(remote, [item(level)]), {
      consent: consentAt('restricted', true),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusals[0]!.rule).toBe('consent-revoked@1');
  });

  it('refuses restricted work by default, even with a generous grant', () => {
    // The loudest promise in the product. A confidential grant is not consent
    // for session transcripts.
    const decision = evaluate(request(remote, [item('restricted')]), {
      consent: consentAt('confidential'),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusals[0]!.rule).toBe('restricted-default@1');
  });

  it('allows restricted work only when the grant says restricted', () => {
    const decision = evaluate(request(remote, [item('restricted')]), {
      consent: consentAt('restricted'),
    });
    expect(decision.allowed).toBe(true);
  });

  it.each([
    ['public', 'internal', true],
    ['internal', 'internal', true],
    ['confidential', 'internal', false],
    ['confidential', 'confidential', true],
  ] as const)('%s work under a %s grant: allowed=%s', (level, granted, expected) => {
    const decision = evaluate(request(remote, [item(level)]), { consent: consentAt(granted) });
    expect(decision.allowed).toBe(expected);
  });

  it('takes the most sensitive input, never the average', () => {
    const decision = evaluate(
      request(remote, [item('public'), item('restricted'), item('internal')]),
      { consent: consentAt('confidential') },
    );
    expect(decision.maxSensitivity).toBe('restricted');
    expect(decision.allowed).toBe(false);
  });

  it('decides per project, so one grant does not open another', () => {
    // Consent is per project by design: client work stays on this machine
    // while personal work does not.
    const consent = (projectKey: string | null): ConsentGrant | null =>
      projectKey === 'personal'
        ? { projectKey, providerId: 'openai', maxSensitivity: 'confidential', revoked: false }
        : null;

    const decision = evaluate(
      request(remote, [item('confidential', 'personal'), item('confidential', 'client-work')]),
      { consent },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.refusals).toHaveLength(1);
    expect(decision.refusals[0]!.reason).toContain('client-work');
  });

  it('separates permission to reach the network from permission to send', () => {
    // Conflating them is how a collector quietly becomes an exfiltration path
    // (ADR-0009).
    const decision = evaluate(
      { ...request(remote, [item('public')]), hasEgressGrant: false },
      { consent: consentAt('restricted') },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.refusals[0]!.rule).toBe('egress-capability@1');
  });
});

describe('every refusal is actionable', () => {
  /** Each rule, reached by the smallest request that triggers it. */
  const scenarios: readonly [string, () => ReturnType<typeof evaluate>][] = [
    [
      'consent-required@1',
      () => evaluate(request(remote, [item('public')]), { consent: noConsent }),
    ],
    [
      'consent-revoked@1',
      () => evaluate(request(remote, [item('public')]), { consent: consentAt('restricted', true) }),
    ],
    [
      'sensitivity-ceiling@1',
      () => evaluate(request(remote, [item('confidential')]), { consent: consentAt('internal') }),
    ],
    [
      'restricted-default@1',
      () => evaluate(request(remote, [item('restricted')]), { consent: consentAt('confidential') }),
    ],
    [
      'egress-capability@1',
      () =>
        evaluate(
          { ...request(remote, [item('public')]), hasEgressGrant: false },
          { consent: consentAt('restricted') },
        ),
    ],
  ];

  it('covers every rule the engine can apply', () => {
    // A rule with no scenario here is a rule nobody has checked explains
    // itself. The engine's own list is the source of truth.
    expect(scenarios.map(([rule]) => rule).sort()).toEqual([...POLICY_RULES].sort());
  });

  it.each(scenarios)('%s names the rule and what would change it', (rule, run) => {
    const decision = run();
    const refusal = decision.refusals.find((candidate) => candidate.rule === rule);

    expect(refusal, `no refusal cited ${rule}`).toBeDefined();
    expect(refusal!.code.length).toBeGreaterThan(0);
    expect(refusal!.reason.length, 'a refusal needs a reason a person can read').toBeGreaterThan(
      20,
    );

    // The point of the whole design: a refusal that does not say what to do
    // next teaches the user nothing and gets the feature switched off.
    if (rule === 'egress-capability@1') {
      // The exception, and it is honest: the user cannot grant a capability
      // the caller never asked for.
      expect(refusal!.remedy.kind).toBe('not_possible');
    } else {
      expect(isActionable(refusal!.remedy), `${rule} has no actionable remedy`).toBe(true);
    }
  });

  it('gives grant remedies a command that would actually work', () => {
    const decision = evaluate(request(remote, [item('confidential')]), { consent: noConsent });
    const remedy = decision.refusals[0]!.remedy;
    expect(remedy.kind).toBe('grant');
    if (remedy.kind !== 'grant') throw new Error('unreachable');
    expect(remedy.command).toContain('careerforge consent grant');
    expect(remedy.command).toContain('--provider openai');
    expect(remedy.command).toContain('--project acme');
    expect(remedy.command).toContain('--level confidential');
  });

  it('reports every blocking rule, not just the first', () => {
    // Reporting one problem at a time turns a privacy decision into
    // whack-a-mole, and a user who fixes what they were told and is refused
    // again stops believing the explanation.
    const decision = evaluate(
      {
        ...request(remote, [item('restricted', 'a'), item('restricted', 'b')]),
        hasEgressGrant: false,
      },
      { consent: noConsent },
    );
    expect(decision.refusals.length).toBeGreaterThanOrEqual(3);
    expect(new Set(decision.refusals.map((r) => r.rule))).toContain('egress-capability@1');
  });
});

describe('payloads', () => {
  it('produces nothing for a refused request', () => {
    // A payload that exists only to be discarded is one that can be logged by
    // mistake.
    const decision = evaluate(request(remote, [item('restricted')]), { consent: noConsent });
    expect(decision.payload).toBe('');
    expect(decision.payloadHash).toBeNull();
  });

  it('redacts what it does send', () => {
    const decision = evaluate(
      request(remote, [{ ...item('public'), text: 'deploy key AKIAQY7EXAMPLE4NPTZW rotated' }]),
      { consent: consentAt('restricted') },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.payload).not.toContain('AKIAQY7EXAMPLE4NPTZW');
    expect(decision.redaction.totalRedactions).toBe(1);
  });

  it('hashes the payload when a digest is supplied, so a decision is checkable', () => {
    const decision = evaluate(request(remote, [item('public')]), {
      consent: consentAt('restricted'),
      digest: (input) => `sha:${input.length}`,
    });
    expect(decision.payloadHash).toMatch(/^sha:\d+$/);
  });

  it('previews a refused request too, because that is how consent is decided', () => {
    // Pattern redaction cannot catch a client name in prose. A person reading
    // the actual bytes is the only mitigation for that, so the preview must
    // not depend on the request being permitted.
    const shown = preview(request(remote, [{ ...item('restricted'), text: 'Acme Corp rollout' }]));
    expect(shown.payload).toContain('Acme Corp rollout');
  });

  it('is deterministic for the same request', () => {
    const build = () =>
      evaluate(request(remote, [item('public')]), { consent: consentAt('restricted') });
    expect(build().payload).toBe(build().payload);
  });
});
