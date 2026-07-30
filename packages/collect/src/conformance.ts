import {
  closeDatabase,
  CursorStore,
  deterministicPlatform,
  EvidenceStore,
  IN_MEMORY,
  openDatabase,
} from '@careerforge/store';

import { runCollection } from './host.js';
import type { CollectorPort, Scope } from './port.js';

/**
 * The collector conformance suite.
 *
 * Every collector is held to this, in-tree or third-party. It is the contract
 * behind "a contributor should not need to understand the whole codebase to
 * write a collector" — implement `CollectorPort`, pass this, done.
 *
 * A function rather than a test file, so a plugin author can import it into
 * their own repository:
 *
 *   import { describeConformance } from '@careerforge/collect';
 *   import { describe, it } from 'vitest';
 *
 *   describeConformance(
 *     { name: 'jira', create: () => new JiraCollector(), scope: () => myScope },
 *     { describe, it },
 *   );
 */

export interface ConformanceSubject {
  /** Shown in test names. */
  readonly name: string;
  /** A fresh collector instance. Called repeatedly; must not share state. */
  readonly create: () => CollectorPort;
  /**
   * A scope with real data behind it.
   *
   * Called inside each test, never at definition time, so fixtures built in a
   * `beforeAll` are ready by the time it runs.
   */
  readonly scope: () => Scope | Promise<Scope>;
  /**
   * Inputs that should be tolerated rather than fatal: truncated files,
   * invalid records, unknown versions, missing paths.
   *
   * Optional only because some sources cannot be corrupted meaningfully.
   * Omitting it skips the tolerance check rather than passing it silently.
   */
  readonly malformedScopes?: () =>
    | readonly { readonly label: string; readonly scope: Scope }[]
    | Promise<readonly { readonly label: string; readonly scope: Scope }[]>;
}

/**
 * Minimal shape of the test globals.
 *
 * Only `describe` and `it` — deliberately not `expect`. Assertions here throw
 * plain errors, so the kit works with whatever runner a plugin author uses and
 * needs no cast at the call site.
 */
export interface TestHooks {
  describe: (name: string, body: () => void) => void;
  it: (name: string, body: () => void | Promise<void>) => void;
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Conformance failure: ${message}`);
}

function checkEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`Conformance failure: ${message}\n  expected ${b}\n  actual   ${a}`);
  }
}

interface Harness {
  readonly store: EvidenceStore;
  readonly cursors: CursorStore;
  readonly close: () => void;
}

function harness(): Harness {
  const { db } = openDatabase({ path: IN_MEMORY });
  const platform = deterministicPlatform();
  return {
    store: new EvidenceStore(db, platform),
    cursors: new CursorStore(db, platform),
    close: () => closeDatabase(db),
  };
}

/** A stable, comparable view of what a collector produced. */
function fingerprint(store: EvidenceStore): string {
  return JSON.stringify(
    store
      .all()
      .map((e) => [e.naturalKey, e.contentHash, e.kind, e.title, e.occurredAt])
      .sort(),
  );
}

export function describeConformance(subject: ConformanceSubject, hooks: TestHooks): void {
  const { describe, it } = hooks;

  describe(`collector conformance: ${subject.name}`, () => {
    it('declares a manifest that matches what it emits', async () => {
      const collector = subject.create();
      const manifest = collector.describe();

      check(manifest.id.length > 0, 'manifest has no id');
      check(manifest.kinds.length > 0, 'manifest declares no evidence kinds');
      check(
        manifest.requiredFields.length > 0,
        'manifest declares no required fields; tolerant parsing needs a narrow set to depend on (ADR-0010)',
      );

      // Kinds are namespaced by the collector id, so a third-party collector
      // can define kinds without coordinating with anyone.
      checkEqual(
        manifest.kinds.filter((kind) => !kind.startsWith(`${manifest.id}.`)),
        [],
        `every kind must be namespaced as "${manifest.id}.*"`,
      );

      const h = harness();
      try {
        const report = await runCollection({
          collector,
          scope: await subject.scope(),
          store: h.store,
          cursors: h.cursors,
          backfill: true,
        });
        // The host skips undeclared kinds and invalid attributes, so a
        // dishonest manifest surfaces as skips rather than as silence.
        checkEqual(report.skipped, {}, 'the host rejected emitted evidence');
        check(report.emitted > 0, 'collector emitted nothing from a scope with real data');
      } finally {
        h.close();
      }
    });

    it('supports backfill — replaying history is not optional', async () => {
      const collector = subject.create();
      check(
        collector.describe().capabilities.backfill,
        'backfill is the acquisition model; a collector that can only watch the present is incomplete',
      );

      const h = harness();
      try {
        const report = await runCollection({
          collector,
          scope: await subject.scope(),
          store: h.store,
          cursors: h.cursors,
          backfill: true,
        });
        check(report.emitted > 0, 'backfill emitted nothing');
      } finally {
        h.close();
      }
    });

    it('is idempotent — a second identical run adds nothing', async () => {
      const h = harness();
      try {
        const scope = await subject.scope();
        const first = await runCollection({
          collector: subject.create(),
          scope,
          store: h.store,
          cursors: h.cursors,
          backfill: true,
        });
        const before = fingerprint(h.store);
        const count = h.store.count();

        const second = await runCollection({
          collector: subject.create(),
          scope,
          store: h.store,
          cursors: h.cursors,
          backfill: true,
        });

        check(second.inserted === 0, `re-run inserted ${second.inserted} new records`);
        check(second.superseded === 0, `re-run superseded ${second.superseded} records`);
        check(
          second.unchanged === first.emitted,
          `re-run recognised ${second.unchanged} of ${first.emitted} records as unchanged`,
        );
        check(h.store.count() === count, 'record count changed on a re-run');
        check(fingerprint(h.store) === before, 'stored evidence changed on a re-run');
      } finally {
        h.close();
      }
    });

    it('is deterministic — two fresh stores receive identical evidence', async () => {
      const scope = await subject.scope();
      const a = harness();
      const b = harness();
      try {
        for (const h of [a, b]) {
          await runCollection({
            collector: subject.create(),
            scope,
            store: h.store,
            cursors: h.cursors,
            backfill: true,
          });
        }
        check(
          fingerprint(a.store) === fingerprint(b.store),
          'two runs over the same source produced different evidence',
        );
      } finally {
        a.close();
        b.close();
      }
    });

    it('agrees with itself: backfill and incremental reach the same state', async () => {
      const scope = await subject.scope();
      const full = harness();
      const staged = harness();
      try {
        await runCollection({
          collector: subject.create(),
          scope,
          store: full.store,
          cursors: full.cursors,
          backfill: true,
        });

        // Collect a little, then resume from the cursor and finish.
        await runCollection({
          collector: subject.create(),
          scope,
          store: staged.store,
          cursors: staged.cursors,
          backfill: true,
          limit: 1,
        });
        await runCollection({
          collector: subject.create(),
          scope,
          store: staged.store,
          cursors: staged.cursors,
        });

        check(
          fingerprint(staged.store) === fingerprint(full.store),
          'incremental collection reached a different state than backfill',
        );
      } finally {
        full.close();
        staged.close();
      }
    });

    it('survives interruption — resuming leaves no gaps and no duplicates', async () => {
      const scope = await subject.scope();
      const reference = harness();
      const interrupted = harness();
      try {
        await runCollection({
          collector: subject.create(),
          scope,
          store: reference.store,
          cursors: reference.cursors,
          backfill: true,
        });

        // Killed partway, then run again.
        await runCollection({
          collector: subject.create(),
          scope,
          store: interrupted.store,
          cursors: interrupted.cursors,
          backfill: true,
          limit: 1,
        });
        await runCollection({
          collector: subject.create(),
          scope,
          store: interrupted.store,
          cursors: interrupted.cursors,
          backfill: true,
        });

        check(
          interrupted.store.count() === reference.store.count(),
          `after interruption and resume: ${interrupted.store.count()} records, expected ${reference.store.count()}`,
        );
        check(
          fingerprint(interrupted.store) === fingerprint(reference.store),
          'resuming after interruption produced different evidence',
        );
      } finally {
        reference.close();
        interrupted.close();
      }
    });

    it('is pure — it holds no store handle and cannot write', () => {
      // Invariant I6, held by the shape of the interface. A collector receives
      // a scope and a cursor; there is nowhere for a database to arrive.
      const collector = subject.create();
      const surface = new Set(Object.keys(collector));
      for (const forbidden of ['db', 'store', 'database', 'connection']) {
        check(!surface.has(forbidden), `collector exposes a "${forbidden}" property`);
      }
      for (const required of ['describe', 'discover', 'collect'] as const) {
        check(typeof collector[required] === 'function', `collector is missing ${required}()`);
      }
    });

    if (subject.malformedScopes !== undefined) {
      it('tolerates malformed input without throwing', async () => {
        // ADR-0010: unknown types, unknown fields, and unknown versions are
        // ignored, and a parse failure on one record never fails a run. The
        // scopes are resolved here rather than at definition time so fixtures
        // built in a `beforeAll` exist by now.
        const cases = await subject.malformedScopes!();
        check(cases.length > 0, 'malformedScopes returned nothing to test');

        for (const { label, scope } of cases) {
          const h = harness();
          try {
            const report = await runCollection({
              collector: subject.create(),
              scope,
              store: h.store,
              cursors: h.cursors,
              backfill: true,
            });
            // Not throwing is the assertion. The report records what was
            // skipped, which is what makes tolerance safe rather than silent.
            check(typeof report.seen === 'number', `malformed input "${label}" produced no report`);
          } catch (error) {
            throw new Error(
              `Conformance failure: malformed input "${label}" threw instead of being skipped. ` +
                'Tolerant parsing is a platform rule (ADR-0010).',
              { cause: error },
            );
          } finally {
            h.close();
          }
        }
      });
    }
  });
}
