import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { toInstant, type AttributeMap, type EvidenceDraft } from '@careerforge/domain';
import { isoWeek } from '@careerforge/collect';
import type {
  CollectorEvent,
  CollectorManifest,
  CollectorPort,
  Cursor,
  Scope,
  SourceRef,
} from '@careerforge/collect';

import {
  newAccumulator,
  observe,
  summarise,
  type DriftSink,
  type SessionSummary,
} from './claude-code.js';
import { readJsonLines } from './lines.js';

/**
 * The AI Coding Session collector.
 *
 * `git log` records what changed. It discards what problem was being solved,
 * what was tried, and why an approach was chosen — which is exactly what a
 * STAR story needs and exactly what a person forgets first. A session
 * transcript has all three, and no competitor has it.
 *
 * It is also the most sensitive data CareerForge will ever hold. A diff shows
 * what changed; a transcript shows everything the person looked at, pasted,
 * and said, including credentials, client names, and unguarded opinions about
 * colleagues. Every design decision below leans conservative for that reason:
 *
 *   · Nothing is extracted that is not load-bearing evidence.
 *   · Absolute paths are counted, never recorded.
 *   · Shell commands contribute a verb, never their arguments.
 *   · Evidence defaults to `restricted`, the highest level in the product.
 *   · The transcript is referenced and hashed. It is never copied.
 *
 * See `docs/PreArchitecture-Findings.md` §1.5.
 */

const ID = 'session';
const VERSION = '1.0.0';

/**
 * The opening prompt, bounded.
 *
 * Prompts average 5,171 characters and the store keeps excerpts, not
 * transcripts. Long enough to carry a real problem statement into a STAR
 * story; short enough that the store never becomes a copy of the source.
 */
const EXCERPT_LIMIT = 2_000;
const TITLE_LIMIT = 120;

/** Bounds on set-valued attributes, so one enormous session cannot dominate. */
const MAX_PATHS = 50;
const MAX_TOOLS = 40;

/**
 * Distinct drift signals reported per collection run.
 *
 * A wholesale format change could otherwise produce a report with thousands of
 * distinct lines, which communicates less than a dozen would.
 */
const MAX_DRIFT_SIGNALS = 100;

function truncate(text: string, limit: number): string {
  const collapsed = text.trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit).trimEnd()}…`;
}

/** The first line of the prompt, which is where people put the ask. */
function titleFrom(prompt: string): string {
  const firstLine = prompt.split('\n').find((line) => line.trim() !== '') ?? prompt;
  return truncate(firstLine, TITLE_LIMIT);
}

function sorted(values: ReadonlySet<string>, limit: number): string[] {
  return [...values].sort().slice(0, limit);
}

const MANIFEST: CollectorManifest = {
  id: ID,
  version: VERSION,
  description: 'Collects AI-assisted coding sessions. Claude Code is the first adapter.',
  kinds: ['session.fragment'],
  attributeSchema: {
    sessionId: {
      type: 'string',
      description: 'Session identifier, taken from the transcript file name',
      required: true,
    },
    transcriptSha256: {
      type: 'string',
      description: 'Hash of the transcript bytes read, so provenance survives the source',
      required: true,
    },
    transcriptBytes: { type: 'number', description: 'Size of the transcript read' },
    recordCount: { type: 'number', description: 'Records in the transcript' },
    userPrompts: { type: 'number', description: 'Prompts in the session, of any origin' },
    humanPrompts: { type: 'number', description: 'Prompts a person typed' },
    programmaticPrompts: { type: 'number', description: 'Prompts composed by a program' },
    promptAuthorship: {
      type: 'string',
      description: '"human" when a person asked for this work, "programmatic" when a tool did',
      required: true,
    },
    assistantMessages: { type: 'number', description: 'Model replies' },
    toolCalls: { type: 'number', description: 'Tool invocations' },
    tools: { type: 'string[]', description: 'Distinct tools used' },
    workspacePaths: {
      type: 'string[]',
      description: 'Files touched, relative to the working directory',
    },
    pathsOutsideWorkspace: {
      type: 'number',
      description: 'Files touched outside the working directory, counted but not named',
    },
    fileExtensions: { type: 'string[]', description: 'File types touched — technology evidence' },
    gitOperations: { type: 'string[]', description: 'Git subcommands observed, without arguments' },
    gitCommandCount: { type: 'number', description: 'Git invocations observed' },
    skills: { type: 'string[]', description: 'Skills invoked' },
    plugins: { type: 'string[]', description: 'Plugins invoked' },
    mcpServers: { type: 'string[]', description: 'MCP servers used' },
    models: { type: 'string[]', description: 'Models that participated' },
    branches: { type: 'string[]', description: 'Git branches observed during the session' },
    entrypoints: { type: 'string[]', description: 'How the session was started' },
    promptSources: { type: 'string[]', description: 'Whether prompts were typed or programmatic' },
    durationMinutes: { type: 'number', description: 'First record to last' },
  },
  capabilities: { backfill: true, incremental: true, watch: false },
  // The highest level in the product, and the reason the level exists.
  defaultSensitivity: 'restricted',
  requiredFields: ['type', 'timestamp', 'sessionId', 'cwd', 'message.content'],
};

/** Where Claude Code keeps transcripts. */
export function defaultTranscriptRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

export function sessionScopeFor(path: string): Scope {
  const root = resolve(path);
  return { key: `session:${root}`, location: root };
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function transcriptsIn(directory: string): string[] {
  if (!isDirectory(directory)) return [];
  try {
    // Sorted, so collection order is the same on every machine and every run.
    return readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
  } catch {
    return [];
  }
}

export class SessionCollector implements CollectorPort {
  describe(): CollectorManifest {
    return MANIFEST;
  }

  /**
   * A project's transcripts, or every project under a root.
   *
   * One scope per project directory rather than one per file, because the
   * project is the unit of consent: enabling `personal-project` while
   * excluding `client-work` is the requirement this source exists to justify
   * (ADR-0009).
   */
  discover(location: string): Promise<readonly SourceRef[]> {
    const root = resolve(location);
    if (!isDirectory(root)) return Promise.resolve([]);

    if (transcriptsIn(root).length > 0) {
      return Promise.resolve([{ scope: sessionScopeFor(root), label: basename(root) }]);
    }

    const found: SourceRef[] = [];
    for (const entry of readdirSync(root).sort()) {
      const candidate = join(root, entry);
      if (isDirectory(candidate) && transcriptsIn(candidate).length > 0) {
        found.push({ scope: sessionScopeFor(candidate), label: entry });
      }
    }
    return Promise.resolve(found);
  }

  async *collect(scope: Scope, cursor: Cursor | null): AsyncIterable<CollectorEvent> {
    const directory = scope.location;
    const files = transcriptsIn(directory);
    if (files.length === 0) {
      yield { kind: 'skipped', reason: 'no session transcripts found' };
      return;
    }

    // The cursor is the newest modification time already collected. A session
    // that is resumed days later is rewritten, so its mtime moves and it is
    // re-read — which is correct, because it now contains more work.
    const since = cursor === null ? 0 : Number(cursor);
    const floor = Number.isFinite(since) ? since : 0;

    let newestMtime = floor;
    /** Every signal reported this run, so the cap below is a run-wide cap. */
    const allSignals = new Set<string>();
    let driftOverflow = 0;

    for (const name of files) {
      const path = join(directory, name);

      let mtime: number;
      let size: number;
      try {
        const stats = statSync(path);
        mtime = Math.floor(stats.mtimeMs);
        size = stats.size;
      } catch {
        yield { kind: 'skipped', reason: 'transcript disappeared while collecting' };
        continue;
      }

      if (mtime > newestMtime) newestMtime = mtime;
      if (mtime <= floor) continue;

      // Counted once per transcript, not once per record. "Six sessions carry
      // a field we do not know" is the useful number; the record count of a
      // field present on every line is not.
      const signals = new Set<string>();
      const sink: DriftSink = (signal) => {
        if (signals.has(signal)) return;
        if (!allSignals.has(signal) && allSignals.size >= MAX_DRIFT_SIGNALS) {
          driftOverflow++;
          return;
        }
        allSignals.add(signal);
        signals.add(signal);
      };

      const result = await readTranscript(path, size, sink);

      for (const signal of [...signals].sort()) yield { kind: 'drift', signal };

      if (result.kind === 'skipped') {
        yield { kind: 'skipped', reason: result.reason };
        continue;
      }
      yield { kind: 'evidence', draft: result.draft };
    }

    if (driftOverflow > 0) {
      yield { kind: 'drift', signal: `${driftOverflow} further signal(s) suppressed` };
    }

    if (newestMtime > floor) {
      yield { kind: 'cursor', cursor: String(newestMtime) };
    }
  }
}

type TranscriptResult =
  | { readonly kind: 'evidence'; readonly draft: EvidenceDraft }
  | { readonly kind: 'skipped'; readonly reason: string };

/**
 * Read one transcript, streaming, and turn it into at most one Evidence draft.
 *
 * One file, one draft, `kind: session.fragment` — and *fragment* is the honest
 * word. Over 90% of transcripts are under thirty seconds: resumes, forks, and
 * aborted starts. Rolling those up into units of real work is M6's job, and
 * doing it here would be a collector deciding what a Work Unit is (ADR-0006).
 */
async function readTranscript(
  path: string,
  size: number,
  drift: DriftSink,
): Promise<TranscriptResult> {
  const state = newAccumulator();
  const hash = createHash('sha256');
  let bytes = 0;
  let malformed = 0;

  try {
    for await (const line of readJsonLines(path, {
      onBytes: (chunk) => {
        // Hashing what was read, rather than re-reading the file to hash it.
        // A live session is appended to while we are reading it, so those two
        // are routinely different, and only one of them is what we parsed.
        hash.update(chunk);
        bytes += chunk.length;
      },
    })) {
      if (!line.ok) {
        malformed++;
        continue;
      }
      observe(state, line.value, drift);
    }
  } catch {
    return { kind: 'skipped', reason: 'transcript could not be read' };
  }

  // A fixed string, not a count. Signals are aggregation keys, so embedding a
  // number in one would split "2 bad lines" and "3 bad lines" into separate
  // findings and hide how widespread the problem is.
  if (malformed > 0) drift('lines that were not valid JSON');

  const summary = summarise(state);
  const sessionId = basename(path, '.jsonl');

  // The file name is authoritative. Records carry a `sessionId` too, and in
  // 250 files checked the two always agreed — but a resumed session that
  // replayed its parent's records would break that, and identity derived from
  // content that might have been copied is identity that can collide.
  if (summary.sessionIds.size > 0 && !summary.sessionIds.has(sessionId)) {
    drift('session id in records differs from the file name');
  }

  if (summary.userPrompts === 0) {
    // Nobody and nothing asked for anything here: a transport stub, a mode
    // change, an aborted start. There is no factual assertion to make.
    return { kind: 'skipped', reason: 'no prompt in transcript' };
  }
  const started = summary.firstTimestamp;
  if (started === null) {
    return { kind: 'skipped', reason: 'no usable timestamp in transcript' };
  }

  return {
    kind: 'evidence',
    draft: draftFor({
      summary,
      sessionId,
      started,
      transcriptSha256: hash.digest('hex'),
      bytes: bytes || size,
    }),
  };
}

interface DraftInput {
  readonly summary: SessionSummary;
  readonly sessionId: string;
  readonly started: string;
  readonly transcriptSha256: string;
  readonly bytes: number;
}

function draftFor({
  summary,
  sessionId,
  started,
  transcriptSha256,
  bytes,
}: DraftInput): EvidenceDraft {
  const occurredAt = toInstant(started);
  const end = summary.lastTimestamp ?? started;
  const durationMinutes =
    Math.round(((Date.parse(end) - Date.parse(occurredAt)) / 60_000) * 100) / 100;

  const attributes: AttributeMap = {
    sessionId,
    transcriptSha256,
    transcriptBytes: bytes,
    recordCount: summary.recordCount,
    userPrompts: summary.userPrompts,
    humanPrompts: summary.humanPrompts,
    programmaticPrompts: summary.programmaticPrompts,
    promptAuthorship: summary.openingPrompt === null ? 'programmatic' : 'human',
    assistantMessages: summary.assistantMessages,
    toolCalls: summary.toolCalls,
    tools: sorted(summary.tools, MAX_TOOLS),
    workspacePaths: sorted(summary.workspacePaths, MAX_PATHS),
    pathsOutsideWorkspace: summary.pathsOutsideWorkspace,
    fileExtensions: sorted(summary.fileExtensions, MAX_TOOLS),
    gitOperations: sorted(summary.gitOperations, MAX_TOOLS),
    gitCommandCount: summary.gitCommandCount,
    skills: sorted(summary.skills, MAX_TOOLS),
    plugins: sorted(summary.plugins, MAX_TOOLS),
    mcpServers: sorted(summary.mcpServers, MAX_TOOLS),
    models: sorted(summary.models, MAX_TOOLS),
    branches: sorted(summary.branches, MAX_TOOLS),
    entrypoints: sorted(summary.entrypoints, MAX_TOOLS),
    promptSources: sorted(summary.promptSources, MAX_TOOLS),
    durationMinutes,
  };

  const projectKey = summary.cwd === null ? null : basename(summary.cwd.replace(/[/\\]+$/, ''));
  // The branch the session started on, not the alphabetically first one. A
  // session that switches branches did its work on the one it began with, and
  // sorting would pick a different answer for no reason anyone could explain.
  const branch = [...summary.branches][0] ?? null;

  return {
    collectorId: ID,
    // Keyed on the session, not on the path. The transcript directory is
    // derived from the working directory, and a project that moves would
    // otherwise duplicate its entire history under a new key.
    sourceUri: `session://${sessionId}`,
    kind: 'session.fragment',
    evidenceClass: 'imported',
    sensitivity: MANIFEST.defaultSensitivity,
    occurredAt,
    occurredEnd: toInstant(end),
    context: { projectKey, workspace: summary.cwd, stream: branch },
    // Taken verbatim from what the person typed — and only from that. The
    // transcript also holds a model-written `ai-title` that would make a
    // tidier title, and a summary of the previous conversation filed as a user
    // turn; importing either would put model prose in a row that asserts fact.
    //
    // 93% of transcripts were driven by a program rather than typed. Those
    // still record real work, so they are collected — with a title that
    // describes the artifact instead of quoting a machine, and no excerpt,
    // because there is no problem statement to excerpt. See ADR-0017.
    title:
      summary.openingPrompt === null
        ? `Programmatic session${projectKey === null ? '' : ` in ${projectKey}`}`
        : titleFrom(summary.openingPrompt),
    summary: null,
    excerpt: summary.openingPrompt === null ? null : truncate(summary.openingPrompt, EXCERPT_LIMIT),
    // The blob store does not exist yet. The transcript is referenced by
    // `sourceUri` and verifiable by `transcriptSha256`; archiving the bytes
    // themselves is a later, opt-in decision.
    payloadRef: null,
    attributes,
    // Working directory, branch, and week. The core groups; collectors hint
    // (ADR-0006). Matching the Git collector's bucket is deliberate: a commit
    // and the session that produced it should land in the same week.
    groupingHint: `${projectKey ?? 'unknown'}:${branch ?? 'none'}:${isoWeek(occurredAt)}`,
    collectorVersion: VERSION,
    sourceFormatVersion: summary.version,
  };
}

export const sessionCollector = new SessionCollector();
