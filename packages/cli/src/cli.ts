import { formatChecks, runChecks } from './doctor.js';
import { readVersion } from './version.js';

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const USAGE = `CareerForge - an AI-powered Career Intelligence Platform

Usage:
  careerforge <command> [options]

Commands:
  doctor              Check the environment and report what CareerForge can see

Options:
  -v, --version       Print the version and exit
  -h, --help          Print this help and exit

Examples:
  careerforge doctor
  careerforge --version

CareerForge is local-first: nothing leaves your machine without explicit consent.
Docs: https://github.com/edwardjgriggs/careerforge
`;

const DOCTOR_HELP = `careerforge doctor - check the environment

Usage:
  careerforge doctor

Reports the Node.js version, platform, and where CareerForge stores its data.
Exits non-zero if any check fails.

Example:
  careerforge doctor
`;

function ok(stdout: string): CliResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function usageError(message: string): CliResult {
  return {
    stdout: '',
    stderr: `${message}\n\nRun \`careerforge --help\` to see available commands.\n`,
    exitCode: 2,
  };
}

/**
 * Pure argument handling: takes argv, returns what to print and the exit code.
 * Keeping the process boundary out of here is what makes the CLI testable
 * without spawning.
 */
export function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliResult {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return ok(USAGE);
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    return ok(`${readVersion()}\n`);
  }

  if (command === 'doctor') {
    if (rest.includes('--help') || rest.includes('-h')) return ok(DOCTOR_HELP);
    const checks = runChecks(env);
    const failed = checks.some((c) => c.status === 'fail');
    return { stdout: `${formatChecks(checks)}\n`, stderr: '', exitCode: failed ? 1 : 0 };
  }

  if (command.startsWith('-')) {
    return usageError(`Unknown option: ${command}`);
  }
  return usageError(`Unknown command: ${command}`);
}
