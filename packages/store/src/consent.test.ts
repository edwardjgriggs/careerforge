import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluate, type PayloadItem } from '@careerforge/policy';

import { ConsentStore } from './consent-store.js';
import { closeDatabase, IN_MEMORY, openDatabase } from './database.js';
import { deterministicPlatform, sha256 } from './platform.js';
import type { Db } from './migrations/index.js';

/**
 * Consent as stored state, and the audit trail of what it decided.
 *
 * The engine's rules are tested in `@careerforge/policy` with no database in
 * sight. What is tested here is that grants persist the way the append-only
 * model requires, and that every decision is on record — because the question
 * a user asks after a scare is "what was attempted?", not "what succeeded?".
 */

let db: Db;
let consent: ConsentStore;

beforeEach(() => {
  db = openDatabase({ path: IN_MEMORY }).db;
  consent = new ConsentStore(db, deterministicPlatform());
});

afterEach(() => {
  closeDatabase(db);
});

const item = (projectKey: string | null): PayloadItem => ({
  kind: 'evidence',
  id: 'ev-1',
  sensitivity: 'confidential',
  projectKey,
  text: 'work',
});

const remote = { id: 'openai', locality: 'remote' as const };

describe('grants', () => {
  it('permits nothing by default', () => {
    expect(consent.lookup('acme', 'openai')).toBeNull();
    expect(consent.list()).toEqual([]);
  });

  it('records a grant and finds it again', () => {
    consent.grant({ projectKey: 'acme', providerId: 'openai', maxSensitivity: 'confidential' });
    expect(consent.lookup('acme', 'openai')!.maxSensitivity).toBe('confidential');
  });

  it('prefers a project grant over a store-wide one', () => {
    // Narrowing consent for one client must not require expressing it as a
    // hole in a broader permission.
    consent.grant({ projectKey: null, providerId: 'openai', maxSensitivity: 'restricted' });
    consent.grant({ projectKey: 'client-work', providerId: 'openai', maxSensitivity: 'public' });
    expect(consent.lookup('client-work', 'openai')!.maxSensitivity).toBe('public');
    expect(consent.lookup('personal', 'openai')!.maxSensitivity).toBe('restricted');
  });

  it('blocks subsequent requests the moment a grant is revoked', () => {
    consent.grant({ projectKey: 'acme', providerId: 'openai', maxSensitivity: 'restricted' });
    const before = evaluate(
      { provider: remote, purpose: 'enrich', items: [item('acme')] },
      { consent: (p, i) => consent.lookup(p, i) },
    );
    expect(before.allowed).toBe(true);

    consent.revoke('acme', 'openai', 'changed my mind');
    const after = evaluate(
      { provider: remote, purpose: 'enrich', items: [item('acme')] },
      { consent: (p, i) => consent.lookup(p, i) },
    );
    expect(after.allowed).toBe(false);
    expect(after.refusals[0]!.rule).toBe('consent-revoked@1');
  });

  it('supersedes rather than deletes, so what you allowed stays answerable', () => {
    consent.grant({ projectKey: 'acme', providerId: 'openai', maxSensitivity: 'restricted' });
    consent.revoke('acme', 'openai');
    consent.grant({ projectKey: 'acme', providerId: 'openai', maxSensitivity: 'internal' });

    const history = consent.history('acme', 'openai');
    expect(history).toHaveLength(3);
    expect(history.map((g) => [g.maxSensitivity, g.revoked])).toEqual([
      ['restricted', false],
      ['restricted', true],
      ['internal', false],
    ]);
    expect(consent.list()).toHaveLength(1);
  });

  it('refuses to be edited in place', () => {
    consent.grant({ projectKey: 'acme', providerId: 'openai', maxSensitivity: 'public' });
    expect(() =>
      db.prepare(`UPDATE consent_grants SET max_sensitivity='restricted'`).run(),
    ).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM consent_grants`).run()).toThrow(/append-only/);
  });
});

describe('the audit trail', () => {
  it('records a row per decision, permitted or not', () => {
    const lookup = (p: string | null, i: string) => consent.lookup(p, i);
    for (let n = 0; n < 5; n++) {
      consent.recordDecision(
        evaluate(
          { provider: remote, purpose: 'enrich', items: [item('acme')] },
          { consent: lookup },
        ),
      );
    }
    expect(consent.decisionCount()).toBe(5);
    expect(consent.recentDecisions().every((d) => !d.allowed)).toBe(true);
  });

  it('keeps which rules refused, so an old decision is still explicable', () => {
    consent.recordDecision(
      evaluate(
        { provider: remote, purpose: 'enrich', items: [item('acme')] },
        { consent: () => null },
      ),
    );
    expect(consent.recentDecisions()[0]!.refusalRules).toEqual(['consent-required@1']);
  });

  it('stores a hash and never the payload', () => {
    // The audit trail must not become the largest concentration of sensitive
    // data in the store, which is the thing it exists to guard.
    consent.grant({ projectKey: 'acme', providerId: 'openai', maxSensitivity: 'restricted' });
    const decision = evaluate(
      { provider: remote, purpose: 'enrich', items: [{ ...item('acme'), text: 'a secret plan' }] },
      { consent: (p, i) => consent.lookup(p, i), digest: sha256 },
    );
    consent.recordDecision(decision);

    const row = db.prepare(`SELECT * FROM policy_decisions LIMIT 1`).get() as Record<
      string,
      unknown
    >;
    expect(row['payload_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('a secret plan');
  });

  it('is not editable', () => {
    consent.recordDecision(
      evaluate(
        { provider: remote, purpose: 'enrich', items: [item(null)] },
        { consent: () => null },
      ),
    );
    expect(() => db.prepare(`UPDATE policy_decisions SET allowed=1`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM policy_decisions`).run()).toThrow(/append-only/);
  });
});
