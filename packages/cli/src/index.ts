/**
 * `@careerforge/cli`
 *
 * CareerForge command-line interface. Collection, enrichment, and generation
 * are commands so they can be scripted, scheduled, and driven from CI —
 * collection should feel like infrastructure, not an app to click through.
 *
 * Grown across every milestone. See IMPLEMENTATION_PLAN.md.
 */

export const PACKAGE_NAME = '@careerforge/cli' as const;

export { run, COMMAND_NAMES, type CliResult } from './cli.js';
export { main } from './main.js';
export * from './commands.js';
export {
  runChecks,
  formatChecks,
  checkNode,
  checkPlatform,
  checkHome,
  checkStore,
  parseNodeVersion,
  MINIMUM_NODE_MAJOR,
  MINIMUM_NODE_MINOR,
  type Check,
  type CheckStatus,
} from './doctor.js';
export { resolvePaths, careerforgeHome, type CareerforgePaths } from './paths.js';
export { readVersion } from './version.js';
