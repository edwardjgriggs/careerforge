/**
 * The Claude Code adapter.
 *
 * One file, one job: turn Claude Code's session transcript records into a
 * neutral `SessionSummary`. It performs no I/O and knows nothing about
 * Evidence, stores, or CareerForge — which is what makes a second adapter
 * (Cursor, Codex, Aider) a sibling file rather than a rewrite. See
 * `docs/PreArchitecture-Findings.md` §1.6.
 *
 * ── Robustness over completeness ────────────────────────────────────────
 *
 * The measured corpus carried **14 distinct schema versions in 30 days** and
 * grew a record type (`custom-title`) between the survey and this
 * implementation. A parser that validates against a closed schema would break
 * roughly weekly.
 *
 * So: nothing is required, nothing is validated, nothing is rejected. Every
 * field is read defensively and every absence is normal. What is *not*
 * recognised is reported as drift (ADR-0016) rather than dropped in silence,
 * because the alternative to noisy failure is not safety — it is a field that
 * carries real evidence appearing upstream and never being noticed.
 */

/** Record types observed in the corpus. Recognised, not necessarily used. */
const KNOWN_RECORD_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'attachment',
  'ai-title',
  'custom-title',
  'last-prompt',
  'mode',
  'permission-mode',
  'bridge-session',
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'pr-link',
  // Found by the drift channel on the first run against a real corpus, after
  // this file was written. Recognised here so a genuinely new type is not
  // buried under types that are merely newer than the survey.
  'agent-name',
  'frame-link',
]);

/**
 * Fields observed on the two record types we extract from.
 *
 * Tracked only for these two: a new field on `mode` or `bridge-session` is
 * transport plumbing, but a new field on `user` or `assistant` could be
 * evidence we are now missing.
 */
const KNOWN_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  user: new Set([
    'classifierMetaLines',
    'cwd',
    'entrypoint',
    'forkedFrom',
    'gitBranch',
    'imagePasteIds',
    'interruptedMessageId',
    'isCompactSummary',
    'isMeta',
    'isSidechain',
    'isVisibleInTranscriptOnly',
    'mcpMeta',
    'message',
    'origin',
    'parentUuid',
    'permissionMode',
    'promptId',
    'promptSource',
    'queuePriority',
    'sessionId',
    'session_id',
    'slug',
    'sourceToolAssistantUUID',
    'sourceToolUseID',
    'timestamp',
    'toolDenialKind',
    'toolUseResult',
    'type',
    'userFeedback',
    'userType',
    'uuid',
    'version',
  ]),
  assistant: new Set([
    'attributionMcpServer',
    'attributionMcpTool',
    'attributionPlugin',
    'attributionSkill',
    'cwd',
    'effort',
    'entrypoint',
    'error',
    'forkedFrom',
    'gitBranch',
    'isAbortedMidStream',
    'isApiErrorMessage',
    'isSidechain',
    'message',
    'parentUuid',
    'requestId',
    'sessionId',
    'session_id',
    'slug',
    'timestamp',
    'type',
    'userType',
    'uuid',
    'version',
  ]),
};

const KNOWN_CONTENT_BLOCKS = new Set(['text', 'thinking', 'tool_use', 'tool_result']);

/**
 * Tool inputs whose values name a file that was worked on.
 *
 * Deliberately excludes `path`, which is where a *search* was run. A directory
 * someone globbed is not a file they touched, and the difference matters: this
 * list ends up in a resume claim, and "worked on 40 files" must mean it.
 */
const PATH_INPUT_KEYS = ['file_path', 'notebook_path'] as const;

// ── Defensive readers ─────────────────────────────────────────────────────
// Every one of these answers "is it there and is it the shape I expect", and
// never throws. Together they are why an unexpected record cannot fail a run.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

// ── Text extraction ───────────────────────────────────────────────────────

/**
 * Envelopes the harness injects into a user turn.
 *
 * These arrive inside a `user` record but nobody typed them. Treating them as
 * the user's own words would put machine-authored text into an Evidence field
 * that claims to be human-authored — a factual error, not a cosmetic one, and
 * exactly what ADR-0002 exists to prevent.
 *
 * Stripped rather than skipped: a real prompt frequently follows the envelope
 * in the same record, and dropping the record would lose it.
 */
const INJECTED_ENVELOPE =
  /<(system-reminder|local-command-[a-z-]+|command-name|command-message|command-args)\b[^>]*>[\s\S]*?<\/\1>/g;

export function stripInjectedEnvelopes(text: string): string {
  return text.replace(INJECTED_ENVELOPE, '').trim();
}

/**
 * The human-readable text of a message, if any.
 *
 * `message.content` is a string on some records and an array of blocks on
 * others — 340 and 2,430 occurrences respectively in the sample, so neither is
 * an edge case. Only `text` blocks contribute: `thinking` is the model's, and
 * `tool_result` is a tool's.
 */
export function messageText(message: unknown): string {
  const envelope = asRecord(message);
  if (envelope === null) return '';

  const content = envelope['content'];
  if (typeof content === 'string') return content;

  const parts: string[] = [];
  for (const item of asArray(content)) {
    const block = asRecord(item);
    if (block?.['type'] === 'text') {
      const text = asString(block['text']);
      if (text !== null) parts.push(text);
    }
  }
  return parts.join('\n');
}

// ── Accumulator ───────────────────────────────────────────────────────────

export interface SessionSummary {
  /** From the record stream. The file name is authoritative; see `index.ts`. */
  readonly sessionIds: ReadonlySet<string>;
  readonly cwd: string | null;
  readonly branches: ReadonlySet<string>;
  readonly entrypoints: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
  readonly promptSources: ReadonlySet<string>;
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
  /**
   * The first thing a *person* asked for, verbatim and unbounded.
   * Null when the session was driven entirely by a program.
   */
  readonly openingPrompt: string | null;
  readonly recordCount: number;
  readonly userPrompts: number;
  readonly humanPrompts: number;
  readonly programmaticPrompts: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly tools: ReadonlySet<string>;
  readonly workspacePaths: ReadonlySet<string>;
  readonly pathsOutsideWorkspace: number;
  readonly fileExtensions: ReadonlySet<string>;
  readonly gitOperations: ReadonlySet<string>;
  readonly gitCommandCount: number;
  readonly skills: ReadonlySet<string>;
  readonly plugins: ReadonlySet<string>;
  readonly mcpServers: ReadonlySet<string>;
  readonly version: string | null;
}

interface Accumulator {
  sessionIds: Set<string>;
  cwd: string | null;
  branches: Set<string>;
  entrypoints: Set<string>;
  models: Set<string>;
  promptSources: Set<string>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  openingPrompt: string | null;
  recordCount: number;
  userPrompts: number;
  humanPrompts: number;
  programmaticPrompts: number;
  assistantMessages: number;
  toolCalls: number;
  tools: Set<string>;
  absolutePaths: Set<string>;
  gitOperations: Set<string>;
  gitCommandCount: number;
  skills: Set<string>;
  plugins: Set<string>;
  mcpServers: Set<string>;
  version: string | null;
}

export function newAccumulator(): Accumulator {
  return {
    sessionIds: new Set(),
    cwd: null,
    branches: new Set(),
    entrypoints: new Set(),
    models: new Set(),
    promptSources: new Set(),
    firstTimestamp: null,
    lastTimestamp: null,
    openingPrompt: null,
    recordCount: 0,
    userPrompts: 0,
    humanPrompts: 0,
    programmaticPrompts: 0,
    assistantMessages: 0,
    toolCalls: 0,
    tools: new Set(),
    absolutePaths: new Set(),
    gitOperations: new Set(),
    gitCommandCount: 0,
    skills: new Set(),
    plugins: new Set(),
    mcpServers: new Set(),
    version: null,
  };
}

/** Compares `2.1.9` and `2.1.10` numerically, unlike a string compare. */
export function isNewerVersion(candidate: string, current: string | null): boolean {
  if (current === null) return true;
  const a = candidate.split('.').map((part) => Number.parseInt(part, 10));
  const b = current.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || Number.isNaN(left)) return false;
    if (right === undefined || Number.isNaN(right)) return true;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * Git subcommands, taken from a shell command line. Verbs only, never
 * arguments.
 *
 * `git remote add origin https://token@host/repo` is a routine command and a
 * credential. The verb is the evidence; everything after it is a liability,
 * so nothing after it is kept.
 *
 * A tokeniser rather than one regex, because global options come in three
 * shapes — `-C <path>`, `--git-dir=<path>`, `--no-pager` — and a pattern that
 * covers all three is a pattern nobody can check by reading.
 */
const VERB = /^[a-z][a-z-]*$/;

/** Global options that consume the token after them. */
const OPTIONS_WITH_ARGUMENTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
]);

export function gitVerbs(command: string): string[] {
  const tokens = command.split(/\s+/).filter((token) => token !== '');
  const verbs: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    // `git` may be the whole token, or the tail of a shell operator such as
    // `&&git`. It must not match `git-like-but-not`.
    if (!/(?:^|[;&|(])git$/.test(tokens[i]!)) continue;

    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j]!;
      if (OPTIONS_WITH_ARGUMENTS.has(token)) {
        j++;
        continue;
      }
      if (token.startsWith('-')) continue;
      if (VERB.test(token)) {
        verbs.push(token);
        i = j;
      }
      break;
    }
  }
  return verbs;
}

function fileExtension(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : null;
}

function collectPaths(input: Record<string, unknown>, into: Set<string>): void {
  for (const key of PATH_INPUT_KEYS) {
    const value = asString(input[key]);
    if (value !== null) into.add(value);
  }
  for (const item of asArray(input['files'])) {
    const value = asString(item);
    if (value !== null) into.add(value);
  }
}

export type DriftSink = (signal: string) => void;

/**
 * Fold one record into the accumulator.
 *
 * Order-independent except for `openingPrompt`, which takes the first
 * qualifying prompt and is the one place file order matters.
 */
export function observe(state: Accumulator, record: unknown, drift: DriftSink): void {
  const row = asRecord(record);
  if (row === null) {
    drift('record is not an object');
    return;
  }

  state.recordCount++;

  const type = asString(row['type']) ?? '(untyped)';
  if (!KNOWN_RECORD_TYPES.has(type)) {
    drift(`unrecognised record type: ${type}`);
    // Deliberately not an early return. An unknown record still carries a
    // timestamp and a cwd, and a session's span should not shrink because a
    // new record type appeared in the middle of it.
  }

  const known = KNOWN_FIELDS[type];
  if (known !== undefined) {
    for (const field of Object.keys(row)) {
      if (!known.has(field)) drift(`unrecognised field on ${type}: ${field}`);
    }
  }

  const sessionId = asString(row['sessionId']) ?? asString(row['session_id']);
  if (sessionId !== null) state.sessionIds.add(sessionId);

  const timestamp = asString(row['timestamp']);
  if (timestamp !== null && !Number.isNaN(Date.parse(timestamp))) {
    const iso = new Date(timestamp).toISOString();
    if (state.firstTimestamp === null || iso < state.firstTimestamp) state.firstTimestamp = iso;
    if (state.lastTimestamp === null || iso > state.lastTimestamp) state.lastTimestamp = iso;
  }

  // First writer wins. A session's working directory does not change, and if a
  // future version makes it change, the first is still the one the work
  // started in.
  state.cwd ??= asString(row['cwd']);

  const branch = asString(row['gitBranch']);
  if (branch !== null) state.branches.add(branch);

  const entrypoint = asString(row['entrypoint']);
  if (entrypoint !== null) state.entrypoints.add(entrypoint);

  const version = asString(row['version']);
  // Recorded as provenance, never branched on (ADR-0010).
  if (version !== null && isNewerVersion(version, state.version)) state.version = version;

  for (const [field, target] of [
    ['attributionSkill', state.skills],
    ['attributionPlugin', state.plugins],
    ['attributionMcpServer', state.mcpServers],
  ] as const) {
    const value = asString(row[field]);
    if (value !== null) target.add(value);
  }

  if (type === 'user') observeUser(state, row);
  if (type === 'assistant') observeAssistant(state, row, drift);
}

function observeUser(state: Accumulator, row: Record<string, unknown>): void {
  // A `user` record is not necessarily a person speaking. Tool results arrive
  // wrapped in one, and their content is program output that would read as a
  // prompt to anything that only looked at `message.content`.
  if (row['toolUseResult'] !== undefined || row['sourceToolUseID'] !== undefined) return;
  if (row['isMeta'] === true) return;

  // A resumed session opens with a model-written summary of the one before it,
  // filed as a `user` record with no other marking. Taken as a prompt it
  // becomes the title and excerpt of the Evidence — model prose in a row that
  // claims to hold the person's own words (ADR-0017). Over 90% of transcripts
  // are resumes or forks, so this is the common case, not an edge one.
  if (row['isCompactSummary'] === true || row['isVisibleInTranscriptOnly'] === true) return;

  const text = stripInjectedEnvelopes(messageText(row['message']));
  if (text === '') return;

  state.userPrompts++;
  const source = asString(row['promptSource']);
  if (source !== null) state.promptSources.add(source);

  if (isHumanAuthored(source)) {
    state.humanPrompts++;
    state.openingPrompt ??= text;
  } else {
    state.programmaticPrompts++;
  }
}

/**
 * Whether a prompt was written by a person.
 *
 * 93% of the measured corpus carried `promptSource: sdk` — sessions driven by
 * an automation harness or a subagent runner, whose "prompt" was composed by a
 * program. The work in them is real; the words are not the person's, and the
 * excerpt field claims they are.
 *
 * `queued` is typed and held. `system` is injected. An absent value means a
 * version that predates the field, and those are interactive sessions.
 */
export function isHumanAuthored(promptSource: string | null): boolean {
  return promptSource === null || promptSource === 'typed' || promptSource === 'queued';
}

function observeAssistant(
  state: Accumulator,
  row: Record<string, unknown>,
  drift: DriftSink,
): void {
  state.assistantMessages++;

  const message = asRecord(row['message']);
  if (message === null) return;

  const model = asString(message['model']);
  if (model !== null) state.models.add(model);

  const content = message['content'];
  if (typeof content === 'string') return;

  for (const item of asArray(content)) {
    const block = asRecord(item);
    if (block === null) continue;

    const blockType = asString(block['type']) ?? '(untyped)';
    if (!KNOWN_CONTENT_BLOCKS.has(blockType)) {
      drift(`unrecognised content block: ${blockType}`);
      continue;
    }
    if (blockType !== 'tool_use') continue;

    state.toolCalls++;
    const name = asString(block['name']);
    if (name !== null) state.tools.add(name);

    const input = asRecord(block['input']);
    if (input === null) continue;

    collectPaths(input, state.absolutePaths);

    const command = asString(input['command']);
    if (command !== null) {
      const verbs = gitVerbs(command);
      state.gitCommandCount += verbs.length;
      for (const verb of verbs) state.gitOperations.add(verb);
    }
  }
}

/**
 * Reduce absolute paths to workspace-relative ones.
 *
 * Absolute paths must never reach a hashed attribute. They carry a home
 * directory, they differ between machines for identical work, and M4 has
 * already paid for that lesson once: a path-derived attribute makes the same
 * artifact look different from two locations and supersede itself forever.
 *
 * Anything outside the workspace is counted, not recorded. A count is evidence
 * of breadth; a list of paths into someone's home directory is a liability.
 */
export function relativiseToWorkspace(
  paths: ReadonlySet<string>,
  cwd: string | null,
): { readonly inside: string[]; readonly outside: number } {
  if (cwd === null) return { inside: [], outside: paths.size };

  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const inside: string[] = [];
  let outside = 0;

  for (const path of paths) {
    const normalised = path.replace(/\\/g, '/');
    if (normalised === root) continue;
    if (normalised.startsWith(`${root}/`)) inside.push(normalised.slice(root.length + 1));
    else outside++;
  }
  return { inside: inside.sort(), outside };
}

export function summarise(state: Accumulator): SessionSummary {
  const { inside, outside } = relativiseToWorkspace(state.absolutePaths, state.cwd);
  const extensions = new Set<string>();
  for (const path of state.absolutePaths) {
    const extension = fileExtension(path);
    if (extension !== null) extensions.add(extension);
  }

  return {
    sessionIds: state.sessionIds,
    cwd: state.cwd,
    branches: state.branches,
    entrypoints: state.entrypoints,
    models: state.models,
    promptSources: state.promptSources,
    firstTimestamp: state.firstTimestamp,
    lastTimestamp: state.lastTimestamp,
    openingPrompt: state.openingPrompt,
    recordCount: state.recordCount,
    userPrompts: state.userPrompts,
    humanPrompts: state.humanPrompts,
    programmaticPrompts: state.programmaticPrompts,
    assistantMessages: state.assistantMessages,
    toolCalls: state.toolCalls,
    tools: state.tools,
    workspacePaths: new Set(inside),
    pathsOutsideWorkspace: outside,
    fileExtensions: extensions,
    gitOperations: state.gitOperations,
    gitCommandCount: state.gitCommandCount,
    skills: state.skills,
    plugins: state.plugins,
    mcpServers: state.mcpServers,
    version: state.version,
  };
}
