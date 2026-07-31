import { run } from './cli.js';

/**
 * The process entry point.
 *
 * Shared by this package's own `careerforge` bin and by the unscoped
 * `careerforge` wrapper package, which exists because `npm install -g
 * careerforge` is what a person actually types.
 *
 * Two entry points, one implementation. A wrapper that reimplemented the
 * stream writing and the exit code would eventually disagree with this one
 * about what counts as a failure, and the disagreement would show up in
 * somebody's CI rather than in our tests.
 */
export async function main(argv: readonly string[]): Promise<void> {
  const result = await run(argv);
  if (result.stdout !== '') process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
