import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { toInstant, type AttributeMap, type EvidenceDraft } from '@careerforge/domain';
import type {
  CollectorEvent,
  CollectorManifest,
  CollectorPort,
  Cursor,
  Scope,
  SourceRef,
} from '@careerforge/collect';

/**
 * The Git collector.
 *
 * Shells out to `git` rather than reimplementing it. Git is present on every
 * machine in the target audience, `git log` is a stable machine-readable
 * interface, and a JavaScript reimplementation would be slower and would fail
 * on repository shapes real users have.
 */

const ID = 'git';
const VERSION = '1.0.0';

/**
 * ASCII control characters as delimiters. None can appear in git metadata.
 *
 *   RS  separates commits
 *   US  separates fields within a commit
 *   ETX marks the end of the metadata block
 *   GS  separates trailer values
 *
 * ETX matters: a commit body contains newlines, and `--numstat` appends its
 * lines after the formatted output. Without an explicit end-of-metadata
 * marker, a multi-line body is indistinguishable from file statistics.
 */
const RS = '';
const US = '';
const ETX = '';
const GS = '\u001d';

const LOG_FORMAT =
  [
    `${RS}%H`,
    '%aI',
    '%cI',
    '%an',
    '%ae',
    '%P',
    '%s',
    '%b',
    '%(trailers:key=Co-authored-by,valueonly,separator=%x1d)',
  ].join(US) + ETX;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    // Capture stderr rather than inheriting it. Probing a directory that is
    // not a repository is a normal, expected outcome here, and git's
    // complaint about it should not appear in the user's terminal — the
    // CollectionReport is where that belongs.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function isGitRepository(path: string): boolean {
  if (!existsSync(path) || !statSync(path).isDirectory()) return false;
  try {
    return git(path, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * A repository's identity: the SHA of its first commit.
 *
 * Stable across clones, renames, and moves — so re-cloning a repository into a
 * different directory does not duplicate its entire history under a new
 * natural key. The path would be the obvious choice and is exactly wrong.
 */
function repositoryId(path: string): string {
  const roots = git(path, ['rev-list', '--max-parents=0', 'HEAD'])
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .sort();
  // Multiple roots happen after a subtree merge; the earliest sorted one is
  // stable, which is all identity requires.
  return roots[0] ?? basename(resolve(path));
}

interface ParsedCommit {
  sha: string;
  authoredAt: string;
  committedAt: string;
  authorName: string;
  authorEmail: string;
  parents: string[];
  subject: string;
  body: string;
  coauthors: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * Parse one `--numstat` record.
 *
 * Returns null rather than throwing on anything unrecognised: a repository is
 * decades of accumulated history written by many git versions, and one odd
 * commit must never fail a collection run (ADR-0010).
 */
function parseCommit(record: string): ParsedCommit | null {
  // Everything before ETX is metadata; everything after is `--numstat` output.
  //
  // The boundary is explicit because a commit body contains newlines. Splitting
  // on newlines instead would let a multi-line body run into the file
  // statistics — and would silently drop every field after the body, which is
  // where trailers like Co-authored-by live.
  const boundary = record.indexOf(ETX);
  if (boundary === -1) return null;

  const fields = record.slice(0, boundary).split(US);
  const statLines = record.slice(boundary + 1).split('\n');

  const [sha, authoredAt, committedAt, authorName, authorEmail, parents, subject] = fields;

  // The required field set, declared in the manifest. Everything else is
  // optional, and its absence is not an error.
  if (sha === undefined || sha === '' || authoredAt === undefined || subject === undefined) {
    return null;
  }

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of statLines) {
    if (line.trim() === '') continue;
    const [added, removed] = line.split('\t');
    if (added === undefined || removed === undefined) continue;
    filesChanged++;
    // Binary files report "-" rather than a count. Not an error, just absent.
    if (added !== '-') insertions += Number(added) || 0;
    if (removed !== '-') deletions += Number(removed) || 0;
  }

  return {
    sha,
    authoredAt,
    committedAt: committedAt === undefined || committedAt === '' ? authoredAt : committedAt,
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    parents: (parents ?? '').split(' ').filter((p) => p !== ''),
    subject,
    body: (fields[7] ?? '').trim(),
    coauthors: (fields[8] ?? '')
      // Git separates trailers with the requested character on some
      // versions and a newline on others. Accept either rather than
      // depending on which one this machine happens to have.
      .split(GS)
      .flatMap((entry) => entry.split('\n'))
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
    filesChanged,
    insertions,
    deletions,
  };
}

const MANIFEST: CollectorManifest = {
  id: ID,
  version: VERSION,
  description: 'Collects commit history from local Git repositories.',
  kinds: ['git.commit'],
  attributeSchema: {
    // The directory name is deliberately NOT here. Attributes feed the
    // content hash, so a path-derived value would make the same repository
    // collected from two locations look like two different states of the
    // same artifact, superseding each other on every run. The display name
    // lives in context.projectKey, which is not hashed.
    repositoryId: {
      type: 'string',
      description: 'Root commit SHA; stable across clones, moves, and renames',
      required: true,
    },
    sha: { type: 'string', description: 'Commit SHA', required: true },
    authorName: { type: 'string', description: 'Commit author' },
    authorEmail: { type: 'string', description: 'Author email' },
    coauthors: { type: 'string[]', description: 'Co-authored-by trailers' },
    filesChanged: { type: 'number', description: 'Files touched' },
    insertions: { type: 'number', description: 'Lines added' },
    deletions: { type: 'number', description: 'Lines removed' },
    isMerge: { type: 'boolean', description: 'More than one parent' },
    committedAt: { type: 'instant', description: 'Commit timestamp' },
  },
  capabilities: { backfill: true, incremental: true, watch: false },
  // Commit messages and diffs are work product, and most work product is not
  // the user's property (Vision.md §6).
  defaultSensitivity: 'confidential',
  requiredFields: ['%H', '%aI', '%s'],
};

export class GitCollector implements CollectorPort {
  describe(): CollectorManifest {
    return MANIFEST;
  }

  /** A repository, or the repositories immediately inside a directory. */
  discover(location: string): Promise<readonly SourceRef[]> {
    const root = resolve(location);
    if (isGitRepository(root)) {
      return Promise.resolve([{ scope: scopeFor(root), label: basename(root) }]);
    }
    if (!existsSync(root) || !statSync(root).isDirectory()) return Promise.resolve([]);

    const found: SourceRef[] = [];
    for (const entry of readdirSync(root).sort()) {
      const candidate = join(root, entry);
      if (isGitRepository(candidate)) {
        found.push({ scope: scopeFor(candidate), label: entry });
      }
    }
    return Promise.resolve(found);
  }

  async *collect(scope: Scope, cursor: Cursor | null): AsyncIterable<CollectorEvent> {
    const path = scope.location;

    if (!isGitRepository(path)) {
      yield { kind: 'skipped', reason: 'not a git repository' };
      return;
    }

    const repository = basename(resolve(path));
    let repoId: string;
    try {
      repoId = repositoryId(path);
    } catch {
      // An empty repository has no commits and therefore no root.
      yield { kind: 'skipped', reason: 'repository has no commits' };
      return;
    }

    const args = ['log', '--all', '--numstat', `--format=${LOG_FORMAT}`, '--date=iso-strict'];
    // The cursor is a commit SHA. `<sha>..HEAD` is the incremental window; a
    // rewritten history makes it invalid, so a failure falls back to a full
    // replay rather than silently collecting nothing.
    if (cursor !== null) {
      try {
        git(path, ['cat-file', '-e', `${cursor}^{commit}`]);
        args.push(`${cursor}..`);
      } catch {
        yield { kind: 'skipped', reason: 'stored cursor no longer exists; replaying in full' };
      }
    }

    let output: string;
    try {
      output = git(path, args);
    } catch {
      yield { kind: 'skipped', reason: 'git log failed' };
      return;
    }

    let newestSha: string | null = null;

    for (const record of output.split(RS)) {
      if (record.trim() === '') continue;

      const commit = parseCommit(record);
      if (commit === null) {
        yield { kind: 'unknown', recordType: 'unparseable commit record' };
        continue;
      }

      // `git log` is newest-first, so the first commit seen is the newest.
      newestSha ??= commit.sha;

      yield { kind: 'evidence', draft: draftFor(commit, path, repository, repoId) };
    }

    if (newestSha !== null) {
      yield { kind: 'cursor', cursor: newestSha };
    }
  }
}

function scopeFor(path: string): Scope {
  const root = resolve(path);
  return { key: `git:${root}`, location: root };
}

function draftFor(
  commit: ParsedCommit,
  path: string,
  repository: string,
  repoId: string,
): EvidenceDraft {
  const attributes: AttributeMap = {
    repositoryId: repoId,
    sha: commit.sha,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    coauthors: commit.coauthors,
    filesChanged: commit.filesChanged,
    insertions: commit.insertions,
    deletions: commit.deletions,
    isMerge: commit.parents.length > 1,
    committedAt: toInstant(new Date(commit.committedAt).toISOString()),
  };

  const occurredAt = toInstant(new Date(commit.authoredAt).toISOString());

  return {
    collectorId: ID,
    // Keyed on repository identity, not path, so a re-clone is the same
    // history rather than a second copy of it.
    sourceUri: `git://${repoId}/commit/${commit.sha}`,
    kind: 'git.commit',
    evidenceClass: 'imported',
    sensitivity: MANIFEST.defaultSensitivity,
    occurredAt,
    occurredEnd: null,
    context: {
      projectKey: repository,
      workspace: resolve(path),
      // Branch is deliberately absent: a commit belongs to every branch that
      // contains it, so recording one would be arbitrary. Grouping uses the
      // hint below instead.
      stream: null,
    },
    title: commit.subject,
    // Source-authored, never AI (ADR-0002).
    summary: commit.body === '' ? null : commit.body,
    excerpt: null,
    payloadRef: null,
    attributes,
    // Repository plus ISO week. The core does the grouping; collectors only
    // hint (ADR-0006).
    groupingHint: `${repository}:${isoWeek(occurredAt)}`,
    collectorVersion: VERSION,
    sourceFormatVersion: null,
  };
}

/** ISO-8601 week, as `YYYY-Www`. */
function isoWeek(instant: string): string {
  const date = new Date(instant);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weeks run Monday to Sunday and belong to the year containing their
  // Thursday.
  const day = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const gitCollector = new GitCollector();
export { scopeFor as gitScopeFor };
