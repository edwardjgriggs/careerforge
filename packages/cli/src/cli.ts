import {
  COLLECTOR_NAMES,
  assets,
  collect,
  consent,
  enrich,
  enrichments,
  explain,
  generate,
  group,
  interview,
  previewEgress,
  exportCommand,
  init,
  isCollectorName,
  rebuild,
  reindex,
  review,
  search,
  timeline,
  ui,
  units,
  type CommandResult,
} from './commands.js';
import { formatChecks, runChecks } from './doctor.js';
import { tour } from './tour.js';
import { readVersion } from './version.js';

export type CliResult = CommandResult;

interface CommandSpec {
  readonly summary: string;
  readonly usage: string;
  readonly example: string;
  readonly run: (args: readonly string[], env: NodeJS.ProcessEnv) => CliResult | Promise<CliResult>;
}

const ok = (stdout: string): CliResult => ({ stdout, stderr: '', exitCode: 0 });

/** Wait for a keypress. Only ever reached when stdin is a terminal. */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

function usageError(message: string): CliResult {
  return {
    stdout: '',
    stderr: `${message}\n\nRun \`careerforge --help\` to see available commands.\n`,
    exitCode: 2,
  };
}

/** Read `--name value`. Returns undefined when absent. */
function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function numericFlag(args: readonly string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const COMMANDS: Record<string, CommandSpec> = {
  collect: {
    summary: 'Collect evidence from Git and your AI coding sessions',
    usage:
      'careerforge collect [--collector git|session] [--path <dir>] [--backfill] [--limit <n>]',
    example: 'careerforge collect --backfill',
    run: (args, env) => {
      const requested = flag(args, 'collector');
      if (requested !== undefined && !isCollectorName(requested)) {
        return usageError(
          `Unknown collector: ${requested}. Available: ${COLLECTOR_NAMES.join(', ')}.`,
        );
      }
      return collect(env, {
        ...(requested === undefined ? {} : { collectors: [requested] }),
        ...(flag(args, 'path') === undefined ? {} : { path: flag(args, 'path')! }),
        backfill: args.includes('--backfill'),
        ...(flag(args, 'limit') === undefined ? {} : { limit: numericFlag(args, 'limit', 1000) }),
      });
    },
  },
  init: {
    summary: 'Create the local store',
    usage: 'careerforge init',
    example: 'careerforge init',
    run: (_args, env) => init(env),
  },
  doctor: {
    summary: 'Check the environment and the store',
    usage: 'careerforge doctor',
    example: 'careerforge doctor',
    run: (_args, env) => {
      const checks = runChecks(env);
      const failed = checks.some((c) => c.status === 'fail');
      return { stdout: `${formatChecks(checks)}\n`, stderr: '', exitCode: failed ? 1 : 0 };
    },
  },
  export: {
    summary: 'Write the durable JSON copy of your store',
    usage: 'careerforge export [--out <dir>]',
    example: 'careerforge export --out ./my-career-backup',
    run: (args, env) => exportCommand(env, flag(args, 'out')),
  },
  rebuild: {
    summary: 'Reconstruct the database from an export',
    usage: 'careerforge rebuild [--from <dir>]',
    example: 'careerforge rebuild --from ./my-career-backup',
    run: (args, env) => rebuild(env, flag(args, 'from')),
  },
  search: {
    summary: 'Search your evidence (no API key required)',
    usage: 'careerforge search <query> [--limit <n>]',
    example: 'careerforge search "compliance policies"',
    run: (args, env) => {
      const query = args.filter((a) => !a.startsWith('--')).join(' ');
      if (query === '') return usageError('search needs something to search for.');
      return search(env, query, numericFlag(args, 'limit', 50));
    },
  },
  timeline: {
    summary: 'Show what you worked on, by month',
    usage: 'careerforge timeline [--from <date>] [--to <date>] [--limit <n>]',
    example: 'careerforge timeline --from 2026-01-01',
    run: (args, env) =>
      timeline(env, {
        ...(flag(args, 'from') === undefined ? {} : { from: flag(args, 'from')! }),
        ...(flag(args, 'to') === undefined ? {} : { to: flag(args, 'to')! }),
        limit: numericFlag(args, 'limit', 500),
      }),
  },
  group: {
    summary: 'Turn collected evidence into units of work',
    usage: 'careerforge group [--dry-run] [--idle-gap <minutes>] [--min-active <minutes>]',
    example: 'careerforge group --dry-run',
    run: (args, env) =>
      group(env, {
        dryRun: args.includes('--dry-run'),
        ...(flag(args, 'idle-gap') === undefined
          ? {}
          : { idleGap: numericFlag(args, 'idle-gap', 1200) }),
        ...(flag(args, 'min-active') === undefined
          ? {}
          : { minActiveMinutes: numericFlag(args, 'min-active', 15) }),
      }),
  },
  units: {
    summary: 'Show your work units',
    usage: 'careerforge units [--project <key>] [--limit <n>] [--json]',
    example: 'careerforge units --project careerforge',
    run: (args, env) =>
      units(env, {
        ...(flag(args, 'project') === undefined ? {} : { project: flag(args, 'project')! }),
        limit: numericFlag(args, 'limit', 100),
        json: args.includes('--json'),
      }),
  },
  explain: {
    summary: 'Show why a claim is true, and what merely worded it',
    usage: 'careerforge explain <claim-id>',
    example: 'careerforge explain 01JEXAMPLE',
    run: (args, env) => {
      const claimId = args.find((arg) => !arg.startsWith('--'));
      if (claimId === undefined) return usageError('explain needs a claim id.');
      return explain(env, claimId);
    },
  },
  interview: {
    summary: 'Answer the questions CareerForge will not guess',
    usage: 'careerforge interview [--unit <id>] [--gap <id> --answer <text> | --decline]',
    example: 'careerforge interview --gap 01JEXAMPLE --answer "I led it"',
    run: (args, env) =>
      interview(env, {
        ...(flag(args, 'unit') === undefined ? {} : { workUnitId: flag(args, 'unit')! }),
        ...(flag(args, 'gap') === undefined ? {} : { gapId: flag(args, 'gap')! }),
        ...(flag(args, 'answer') === undefined ? {} : { answer: flag(args, 'answer')! }),
        decline: args.includes('--decline'),
        limit: numericFlag(args, 'limit', 20),
      }),
  },
  consent: {
    summary: 'Control what may leave this machine, per project',
    usage:
      'careerforge consent list | grant --provider <id> [--project <key>] [--level <level>] | revoke --provider <id> [--project <key>]',
    example: 'careerforge consent grant --provider openai --project my-repo --level confidential',
    run: (args, env) => {
      const action = args.find((arg) => !arg.startsWith('--')) ?? 'list';
      if (action !== 'list' && action !== 'grant' && action !== 'revoke') {
        return usageError(`Unknown consent action: ${action}. Use list, grant, or revoke.`);
      }
      return consent(env, {
        action,
        ...(flag(args, 'provider') === undefined ? {} : { providerId: flag(args, 'provider')! }),
        ...(flag(args, 'project') === undefined ? {} : { projectKey: flag(args, 'project')! }),
        ...(flag(args, 'level') === undefined ? {} : { level: flag(args, 'level')! }),
        ...(flag(args, 'reason') === undefined ? {} : { reason: flag(args, 'reason')! }),
      });
    },
  },
  preview: {
    summary: 'Show exactly what would be sent to a provider',
    usage: 'careerforge preview --unit <id> --provider <id> [--full]',
    example: 'careerforge preview --unit 01JEXAMPLE --provider openai',
    run: (args, env) => {
      const unit = flag(args, 'unit');
      const provider = flag(args, 'provider');
      if (unit === undefined) return usageError('preview needs --unit <id>.');
      if (provider === undefined) return usageError('preview needs --provider <id>.');
      return previewEgress(env, {
        workUnitId: unit,
        providerId: provider,
        full: args.includes('--full'),
      });
    },
  },
  enrich: {
    summary: 'Ask a model to interpret a work unit (needs a key and consent)',
    usage:
      'careerforge enrich --unit <id> [--type skills|technologies|star_candidate] [--provider <id>] [--model <name>] [--dry-run] [--force]',
    example: 'careerforge enrich --unit 01JEXAMPLE --type skills --dry-run',
    run: (args, env) => {
      const unit = flag(args, 'unit');
      if (unit === undefined) return usageError('enrich needs --unit <id>.');
      return enrich(env, {
        workUnitId: unit,
        ...(flag(args, 'type') === undefined ? {} : { enrichmentType: flag(args, 'type')! }),
        providerId: flag(args, 'provider') ?? 'openai',
        ...(flag(args, 'model') === undefined ? {} : { model: flag(args, 'model')! }),
        dryRun: args.includes('--dry-run'),
        force: args.includes('--force'),
      });
    },
  },
  interpretations: {
    summary: 'Review what a model has said, and what it cited',
    usage: 'careerforge interpretations --unit <id> [--runs]',
    example: 'careerforge interpretations --unit 01JEXAMPLE --runs',
    run: (args, env) => {
      const unit = flag(args, 'unit');
      if (unit === undefined) return usageError('interpretations needs --unit <id>.');
      return enrichments(env, { workUnitId: unit, showRuns: args.includes('--runs') });
    },
  },
  generate: {
    summary: 'Write a résumé bullet, and check every claim in it',
    usage:
      'careerforge generate resume-bullet --unit <id> [--provider <id>] [--model <name>] [--dry-run]',
    example: 'careerforge generate resume-bullet --unit 01JEXAMPLE',
    run: (args, env) => {
      const kind = args.find((arg) => !arg.startsWith('--')) ?? 'resume-bullet';
      if (kind !== 'resume-bullet') {
        return usageError(`Unknown asset kind: ${kind}. Only resume-bullet exists so far.`);
      }
      const unit = flag(args, 'unit');
      if (unit === undefined) return usageError('generate needs --unit <id>.');
      return generate(env, {
        workUnitId: unit,
        providerId: flag(args, 'provider') ?? 'openai',
        ...(flag(args, 'model') === undefined ? {} : { model: flag(args, 'model')! }),
        dryRun: args.includes('--dry-run'),
        force: args.includes('--force'),
      });
    },
  },
  review: {
    summary: 'Read a draft and decide about it — nothing exports until you do',
    usage: 'careerforge review <asset-id> [--accept | --reject | --edit "<text>"]',
    example: 'careerforge review 01JEXAMPLE --accept',
    run: (args, env) => {
      const assetId = args.find((arg) => !arg.startsWith('--'));
      if (assetId === undefined) return usageError('review needs an asset id.');
      if (args.includes('--accept') && args.includes('--reject')) {
        return usageError('Pass one of --accept or --reject, not both.');
      }
      return review(env, {
        assetId,
        ...(args.includes('--accept')
          ? { decision: 'accept' as const }
          : args.includes('--reject')
            ? { decision: 'reject' as const }
            : {}),
        ...(flag(args, 'edit') === undefined ? {} : { edit: flag(args, 'edit')! }),
      });
    },
  },
  assets: {
    summary: 'List what has been generated, or export what you have approved',
    usage: 'careerforge assets [--unit <id>] [--markdown] [--json]',
    example: 'careerforge assets --markdown',
    run: (args, env) => {
      if (args.includes('--json') && args.includes('--markdown')) {
        return usageError('Pass one of --json or --markdown, not both.');
      }
      return assets(env, {
        ...(flag(args, 'unit') === undefined ? {} : { workUnitId: flag(args, 'unit')! }),
        markdown: args.includes('--markdown'),
        json: args.includes('--json'),
      });
    },
  },
  tour: {
    summary: 'A guided tour — sample data, real commands, and why it works this way',
    usage: 'careerforge tour [--no-pause] [--reset]',
    example: 'careerforge tour',
    run: (args, env) =>
      tour(
        env,
        {
          reset: args.includes('--reset'),
          // Guided when a person is watching, and a plain transcript when
          // something else is reading — a script or CI must never block on a
          // prompt nobody is there to answer.
          pause: !args.includes('--no-pause') && process.stdin.isTTY === true,
        },
        undefined,
        waitForEnter,
      ),
  },
  ui: {
    summary: 'Open Evidence Explorer in your browser',
    usage: 'careerforge ui [--port <n>] [--no-open]',
    example: 'careerforge ui',
    run: (args, env) =>
      ui(env, {
        port: numericFlag(args, 'port', 7777),
        open: !args.includes('--no-open'),
      }),
  },
  reindex: {
    summary: 'Rebuild the search index from the store',
    usage: 'careerforge reindex',
    example: 'careerforge reindex',
    run: (_args, env) => reindex(env),
  },
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const commands = Object.entries(COMMANDS)
    .map(([name, spec]) => `  ${name.padEnd(width)}   ${spec.summary}`)
    .join('\n');

  return `CareerForge - a local-first evidence engine for your work history

Usage:
  careerforge <command> [options]

Commands:
${commands}

Options:
  -v, --version       Print the version and exit
  -h, --help          Print this help and exit

Examples:
  careerforge init
  careerforge timeline --from 2026-01-01
  careerforge export

CareerForge is local-first: nothing leaves your machine without explicit consent.
Docs: https://github.com/edwardjgriggs/careerforge
`;
}

function commandHelp(name: string, spec: CommandSpec): string {
  return `careerforge ${name} - ${spec.summary}

Usage:
  ${spec.usage}

Example:
  ${spec.example}
`;
}

/**
 * Pure argument handling: takes argv, returns what to print and the exit code.
 *
 * Keeping the process boundary out of here is what makes the whole command
 * surface testable without spawning.
 */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return ok(usage());
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    return ok(`${readVersion()}\n`);
  }

  const spec = COMMANDS[command];
  if (spec === undefined) {
    return usageError(
      command.startsWith('-') ? `Unknown option: ${command}` : `Unknown command: ${command}`,
    );
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    return ok(commandHelp(command, spec));
  }

  try {
    return await spec.run(rest, env);
  } catch (error) {
    // A command must never surface a raw stack trace. Anything unhandled is a
    // bug, and the message should still tell the user what to do next.
    return {
      stdout: '',
      stderr: `careerforge ${command} failed: ${error instanceof Error ? error.message : String(error)}\n  -> Run \`careerforge doctor\` to check the store.\n`,
      exitCode: 1,
    };
  }
}

export const COMMAND_NAMES = Object.keys(COMMANDS);
