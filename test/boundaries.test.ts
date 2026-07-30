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
});
