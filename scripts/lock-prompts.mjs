import { spawnSync } from 'node:child_process';

/**
 * Regenerate the prompt lockfile.
 *
 * Deliberately its own command rather than a flag on `test`. Rewriting the
 * lock is the act of publishing a prompt, and it should be something a
 * contributor chose to do and a reviewer can see in the diff — not something
 * a test run does quietly when the hash stops matching.
 *
 * A wrapper rather than an inline `VAR=x vitest` because that syntax is not
 * portable to Windows shells, and CareerForge is developed on one.
 */
const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'packages/enrich/src/templates.test.ts'],
  { stdio: 'inherit', env: { ...process.env, UPDATE_PROMPT_LOCK: '1' } },
);

process.exit(result.status ?? 1);
