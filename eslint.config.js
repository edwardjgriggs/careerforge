import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Architectural boundaries, enforced by lint rather than by review.
 *
 * `Architecture.md` §1.2 defines six invariants. Two of them are import rules,
 * and this file is their enforcement:
 *
 *   I1  The domain layer imports no adapter, no network client, and no AI SDK.
 *   I3  Only `policy` may reach the network, so every outbound enrichment call
 *       passes through the Policy Engine.
 *
 * See ADR-0005 (AI is additive) and ADR-0009 (egress separated from network).
 * A conventions document erodes; a failing build does not.
 */

/** Modules capable of opening a network connection. */
const NETWORK_MODULES = [
  'http',
  'https',
  'http2',
  'net',
  'dgram',
  'tls',
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:dgram',
  'node:tls',
  'undici',
  'axios',
  'node-fetch',
  'got',
  'superagent',
  'ky',
];

/** Provider SDKs. Only `enrich` adapters may name one, and only via `policy`. */
const AI_SDKS = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@mistralai/mistralai',
  'cohere-ai',
  'ollama',
  'langchain',
  '@langchain/core',
];

/** Storage and I/O adapters the pure domain layer must never reach for. */
const ADAPTER_MODULES = [
  'better-sqlite3',
  'node:sqlite',
  'sqlite3',
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
  'node:child_process',
  'child_process',
];

const restrict = (paths, message) => ({
  'no-restricted-imports': ['error', { paths: paths.map((name) => ({ name, message })) }],
});

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // ── I3 ──────────────────────────────────────────────────────────────────
  // Everything except `policy` is cut off from the network. The Policy Engine
  // is the single choke point through which evidence may leave the machine.
  {
    files: ['packages/**/*.ts'],
    ignores: ['packages/policy/**/*.ts', 'packages/ui/**/*.ts'],
    rules: {
      ...restrict(
        [...NETWORK_MODULES, ...AI_SDKS],
        'Invariant I3: only @careerforge/policy may reach the network. Route the call through the Policy Engine. See ADR-0009.',
      ),
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Invariant I3: only @careerforge/policy may reach the network. See ADR-0009.',
        },
      ],
    },
  },

  // ── I1 ──────────────────────────────────────────────────────────────────
  // The domain layer is pure: no I/O, no AI, no sibling packages. This is what
  // makes "AI is never required" a property of the build graph rather than a
  // promise in a README. See ADR-0005.
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...NETWORK_MODULES, ...AI_SDKS, ...ADAPTER_MODULES].map((name) => ({
            name,
            message:
              'Invariant I1: @careerforge/domain must stay pure — no I/O, no network, no AI. See ADR-0005.',
          })),
          patterns: [
            {
              group: ['@careerforge/*'],
              message:
                'Invariant I1: @careerforge/domain depends on nothing. Dependencies point inward.',
            },
          ],
        },
      ],
    },
  },

  // ── Enrichment and generation cannot write anything. ────────────────────
  // "AI never writes evidence" (ADR-0002) is easy to state and easy to erode
  // one convenience import at a time. Cutting `enrich` and `generate` off from
  // the store and from every database driver makes it structural: the packages
  // that talk to models have no route to the tables that hold fact, so the rule
  // is not something a contributor has to remember.
  {
    files: ['packages/enrich/**/*.ts', 'packages/generate/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...NETWORK_MODULES, ...AI_SDKS].map((name) => ({
            name,
            message:
              'Invariant I3: only @careerforge/policy may reach the network. Route the call through the Policy Engine. See ADR-0009.',
          })),
          patterns: [
            {
              group: ['better-sqlite3', 'node:sqlite', 'sqlite3', '@careerforge/store'],
              message:
                'Enrichment and generation produce interpretation and never write fact. Neither package has a route to the store by design — hand results back to the caller. See ADR-0002.',
            },
          ],
        },
      ],
    },
  },

  // ── Listening is not sending. ───────────────────────────────────────────
  // `packages/ui` serves the Evidence Explorer to the user's own browser, so
  // it needs `node:http` — which exports two unrelated capabilities that
  // happen to share a module. `createServer` accepts a connection and cannot
  // originate one; `request` can. Only the second moves evidence off the
  // machine, so only the second stays banned, along with every dedicated
  // client and the global fetch. The bind host is a constant, not an option.
  // See ADR-0028.
  {
    files: ['packages/ui/**/*.ts'],
    rules: {
      ...restrict(
        [...NETWORK_MODULES.filter((name) => name !== 'http' && name !== 'node:http'), ...AI_SDKS],
        'Invariant I3: @careerforge/ui may listen, never send. Only node:http (createServer) is permitted here. See ADR-0028.',
      ),
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Invariant I3: @careerforge/ui may listen, never send. Route any outbound call through the Policy Engine. See ADR-0028.',
        },
      ],
    },
  },

  // ── Protocol is published for plugin authors in other languages. ────────
  // It must stay dependency-free so consuming it never means consuming the app.
  {
    files: ['packages/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@careerforge/*'],
              message:
                '@careerforge/protocol is published standalone for plugin authors and must have no dependencies. See ADR-0008.',
            },
          ],
        },
      ],
    },
  },

  // Repository tooling runs under Node directly rather than through the
  // package graph, so it gets Node globals that the packages deliberately do
  // not have ambient access to.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },

  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
