import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Negative tests for the architectural boundaries.
 *
 * A lint rule nobody has seen fail is a lint rule that might not work. These
 * tests write deliberately illegal source into each package, run the real
 * ESLint configuration against it, and assert the violation is reported.
 *
 * Invariants under test (`Architecture.md` §1.2):
 *   I1  domain imports no adapter, no network client, no AI SDK, no sibling
 *   I3  only `policy` may reach the network
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let counter = 0;

/**
 * Write a fixture into a real package source directory, lint it with the
 * project's actual config, then remove it. The path matters: the boundary
 * rules are scoped by package, so a fixture linted from a temp directory
 * would not exercise them.
 */
async function lintIn(pkg: string, source: string): Promise<string[]> {
  const name = `boundary-${process.pid}-${counter++}.boundary-fixture.ts`;
  const file = join(ROOT, 'packages', pkg, 'src', name);
  writeFileSync(file, source);
  try {
    const eslint = new ESLint({ cwd: ROOT });
    const results = await eslint.lintFiles([file]);
    return results.flatMap((r) => r.messages.map((m) => m.message));
  } finally {
    rmSync(file, { force: true });
  }
}

const hasI1 = (messages: string[]) => messages.some((m) => m.includes('Invariant I1'));
const hasI3 = (messages: string[]) => messages.some((m) => m.includes('Invariant I3'));

describe('I1 — the domain layer stays pure', () => {
  it('rejects a network import', async () => {
    const messages = await lintIn(
      'domain',
      `import http from 'node:http';\nexport const x = http;\n`,
    );
    expect(hasI1(messages)).toBe(true);
  });

  it('rejects a filesystem import', async () => {
    const messages = await lintIn(
      'domain',
      `import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n`,
    );
    expect(hasI1(messages)).toBe(true);
  });

  it('rejects an AI SDK import', async () => {
    const messages = await lintIn(
      'domain',
      `import OpenAI from 'openai';\nexport const x = OpenAI;\n`,
    );
    expect(hasI1(messages)).toBe(true);
  });

  it('rejects a database driver import', async () => {
    const messages = await lintIn(
      'domain',
      `import Database from 'better-sqlite3';\nexport const x = Database;\n`,
    );
    expect(hasI1(messages)).toBe(true);
  });

  it('rejects importing a sibling package — dependencies point inward', async () => {
    const messages = await lintIn(
      'domain',
      `import { PACKAGE_NAME } from '@careerforge/store';\nexport const x = PACKAGE_NAME;\n`,
    );
    expect(hasI1(messages)).toBe(true);
  });

  it('has no runtime dependencies declared', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/domain/package.json'), 'utf8'),
    );
    const deps = (manifest as { dependencies?: Record<string, string> }).dependencies;
    expect(deps ?? {}).toEqual({});
  });
});

describe('I3 — only policy may reach the network', () => {
  it('rejects a network import from store', async () => {
    const messages = await lintIn(
      'store',
      `import https from 'node:https';\nexport const x = https;\n`,
    );
    expect(hasI3(messages)).toBe(true);
  });

  it('rejects an AI SDK import from enrich', async () => {
    const messages = await lintIn(
      'enrich',
      `import OpenAI from 'openai';\nexport const x = OpenAI;\n`,
    );
    expect(hasI3(messages)).toBe(true);
  });

  it('rejects an HTTP client import from cli', async () => {
    const messages = await lintIn(
      'cli',
      `import { request } from 'undici';\nexport const x = request;\n`,
    );
    expect(hasI3(messages)).toBe(true);
  });

  it('rejects use of the global fetch outside policy', async () => {
    const messages = await lintIn(
      'collect',
      `export const get = () => fetch('https://example.com');\n`,
    );
    expect(hasI3(messages)).toBe(true);
  });

  it('permits a network import inside policy — it is the choke point', async () => {
    const messages = await lintIn(
      'policy',
      `import https from 'node:https';\nexport const x = https;\n`,
    );
    expect(hasI3(messages)).toBe(false);
  });

  it('permits the global fetch inside policy', async () => {
    const messages = await lintIn(
      'policy',
      `export const get = () => fetch('https://example.com');\n`,
    );
    expect(hasI3(messages)).toBe(false);
  });
});

describe('enrichment and generation produce interpretation, never fact', () => {
  const hasNoWriteRoute = (messages: string[]) =>
    messages.some((m) => m.includes('never write fact'));

  it('rejects importing the store from enrich', async () => {
    // "AI never writes evidence" (ADR-0002) is easy to state and easy to erode
    // one convenience import at a time. The package that talks to models has
    // no route to the tables that hold fact.
    const messages = await lintIn(
      'enrich',
      `import { EvidenceStore } from '@careerforge/store';\nexport const x = EvidenceStore;\n`,
    );
    expect(hasNoWriteRoute(messages)).toBe(true);
  });

  it('rejects a database driver import from enrich', async () => {
    const messages = await lintIn(
      'enrich',
      `import Database from 'better-sqlite3';\nexport const x = Database;\n`,
    );
    expect(hasNoWriteRoute(messages)).toBe(true);
  });

  it('rejects importing the store from generate', async () => {
    // The package that writes résumé bullets is the one with the most reason
    // to want a shortcut into the evidence table, and the least business
    // having one.
    const messages = await lintIn(
      'generate',
      `import { AssetStore } from '@careerforge/store';
export const x = AssetStore;
`,
    );
    expect(hasNoWriteRoute(messages)).toBe(true);
  });

  it('declares no dependency on the store', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/enrich/package.json'), 'utf8'),
    );
    const deps = Object.keys(
      (manifest as { dependencies?: Record<string, string> }).dependencies ?? {},
    );
    expect(deps).not.toContain('@careerforge/store');
    // The one route out is a ProviderPort that takes a PolicyDecision rather
    // than a payload, so a call skipping the consent gate is unspellable.
    expect(deps).toContain('@careerforge/policy');
  });
});

describe('the UI may listen and may not send', () => {
  it('permits a server import — it accepts connections and cannot originate one', async () => {
    // `node:http` exports two unrelated capabilities that share a module.
    // Only `request` can move evidence off the machine. See ADR-0028.
    const messages = await lintIn(
      'ui',
      `import { createServer } from 'node:http';
export const x = createServer;
`,
    );
    expect(hasI3(messages)).toBe(false);
  });

  it('still rejects a dedicated HTTP client there', async () => {
    const messages = await lintIn(
      'ui',
      `import { request } from 'undici';
export const x = request;
`,
    );
    expect(hasI3(messages)).toBe(true);
  });

  it('still rejects the global fetch there', async () => {
    const messages = await lintIn(
      'ui',
      `export const get = () => fetch('https://example.com');
`,
    );
    expect(hasI3(messages)).toBe(true);
  });

  it('still rejects an AI SDK there', async () => {
    const messages = await lintIn(
      'ui',
      `import OpenAI from 'openai';
export const x = OpenAI;
`,
    );
    expect(hasI3(messages)).toBe(true);
  });
});

describe('protocol stays standalone for plugin authors', () => {
  it('rejects importing a sibling package', async () => {
    const messages = await lintIn(
      'protocol',
      `import { PACKAGE_NAME } from '@careerforge/domain';\nexport const x = PACKAGE_NAME;\n`,
    );
    expect(messages.some((m) => m.includes('published standalone'))).toBe(true);
  });
});

describe('permitted dependencies still lint clean', () => {
  it('allows store to depend on domain — dependencies point inward', async () => {
    const messages = await lintIn(
      'store',
      `import { PACKAGE_NAME } from '@careerforge/domain';\nexport const x = PACKAGE_NAME;\n`,
    );
    expect(messages).toEqual([]);
  });

  it('keeps store independent of enrichment, generation, and policy adapters', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/store/package.json'), 'utf8'),
    );
    const dependencies = Object.keys(
      (manifest as { dependencies?: Record<string, string> }).dependencies ?? {},
    );
    expect(dependencies.sort()).toEqual(['@careerforge/domain', 'better-sqlite3']);

    const tsconfig = readFileSync(join(ROOT, 'packages/store/tsconfig.json'), 'utf8');
    expect(tsconfig).not.toMatch(/\.\.\/(enrich|generate|policy)/);
  });
});
