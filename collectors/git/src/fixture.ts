import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The golden fixture repository.
 *
 * Built rather than committed, because a checked-in `.git` directory is opaque
 * binary that nobody can review. Every input that feeds git's object hashing
 * is pinned here — author, committer, timestamps, file bytes, line endings,
 * signing — so the commit SHAs are identical on every machine and every run.
 *
 * That reproducibility is what makes the golden test meaningful: the expected
 * Evidence is checked in as JSON, and any change to collection semantics shows
 * up as a diff a reviewer can read.
 *
 * Changing anything in this file changes the SHAs and will fail the golden
 * test. That is the intended behaviour, not an inconvenience — if collection
 * semantics change, someone should have to look at exactly how.
 */

const FIXED_ENV = {
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'author@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.invalid',
} as const;

interface FixtureCommit {
  readonly at: string;
  readonly message: string;
  readonly files: Readonly<Record<string, string>>;
  readonly deletes?: readonly string[];
}

/**
 * Deliberately varied, so the golden output covers the shapes that actually
 * occur: a first commit, a multi-file change, a body and a co-author trailer,
 * a deletion, a file with no trailing newline, and a non-ASCII message.
 */
const COMMITS: readonly FixtureCommit[] = [
  {
    at: '2026-01-15T09:00:00+0000',
    message: 'Add project skeleton',
    files: { 'README.md': '# Fixture\n', 'src/main.ts': 'export const main = () => 0;\n' },
  },
  {
    at: '2026-01-16T14:30:00+0000',
    message:
      'Implement parsing\n\nHandles the three record shapes we see in practice.\n\nCo-authored-by: Ada Lovelace <ada@example.invalid>',
    files: {
      'src/parse.ts': 'export function parse(input: string) {\n  return input.trim();\n}\n',
      'src/main.ts': 'import { parse } from "./parse.js";\nexport const main = () => parse("x");\n',
    },
  },
  {
    at: '2026-02-02T11:05:00+0000',
    message: 'Remove dead helper',
    files: { 'src/main.ts': 'export const main = () => "done";\n' },
    deletes: ['src/parse.ts'],
  },
  {
    at: '2026-02-20T16:45:00+0000',
    // Non-ASCII, because commit messages are UTF-8 and a byte-level bug here
    // would otherwise surface first on a user's machine.
    message: 'Améliorer la journalisation — 日本語 too',
    files: { 'src/log.ts': 'export const log = (m: string) => m;' },
  },
];

function run(cwd: string, args: readonly string[], env: Record<string, string> = {}): void {
  execFileSync('git', [...args], {
    cwd,
    env: { ...process.env, ...FIXED_ENV, ...env },
    stdio: 'pipe',
    windowsHide: true,
  });
}

/** Build the fixture repository at `path`. Returns the path. */
export function buildFixtureRepository(path: string): string {
  mkdirSync(path, { recursive: true });
  run(path, ['init', '--quiet', '--initial-branch=main']);

  // Pinned so a contributor's global git config cannot change the object
  // hashes. autocrlf especially: on Windows it would rewrite blob contents.
  run(path, ['config', 'core.autocrlf', 'false']);
  run(path, ['config', 'core.eol', 'lf']);
  run(path, ['config', 'commit.gpgsign', 'false']);
  run(path, ['config', 'user.name', FIXED_ENV.GIT_AUTHOR_NAME]);
  run(path, ['config', 'user.email', FIXED_ENV.GIT_AUTHOR_EMAIL]);

  for (const commit of COMMITS) {
    for (const [file, contents] of Object.entries(commit.files)) {
      const full = join(path, file);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents, 'utf8');
    }
    for (const file of commit.deletes ?? []) {
      run(path, ['rm', '--quiet', file]);
    }
    run(path, ['add', '--all']);
    run(path, ['commit', '--quiet', '-m', commit.message], {
      GIT_AUTHOR_DATE: commit.at,
      GIT_COMMITTER_DATE: commit.at,
    });
  }

  return path;
}

export const FIXTURE_COMMIT_COUNT = COMMITS.length;
