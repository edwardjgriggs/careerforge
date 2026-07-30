import {
  collect,
  exportCommand,
  init,
  rebuild,
  reindex,
  search,
  timeline,
  type CommandResult,
} from './commands.js';
import { formatChecks, runChecks } from './doctor.js';
import { readVersion } from './version.js';

export type CliResult = CommandResult;

interface CommandSpec {
  readonly summary: string;
  readonly usage: string;
  readonly example: string;
  readonly run: (args: readonly string[], env: NodeJS.ProcessEnv) => CliResult | Promise<CliResult>;
}

const ok = (stdout: string): CliResult => ({ stdout, stderr: '', exitCode: 0 });

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
    summary: 'Collect evidence from local Git repositories',
    usage: 'careerforge collect [--path <dir>] [--backfill] [--limit <n>]',
    example: 'careerforge collect --path ~/code --backfill',
    run: (args, env) =>
      collect(env, {
        path: flag(args, 'path') ?? process.cwd(),
        backfill: args.includes('--backfill'),
        ...(flag(args, 'limit') === undefined ? {} : { limit: numericFlag(args, 'limit', 1000) }),
      }),
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

  return `CareerForge - an AI-powered Career Intelligence Platform

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
