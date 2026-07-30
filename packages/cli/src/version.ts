import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read the version from the CLI package manifest.
 *
 * Deliberately read at runtime rather than inlined at build time so that a
 * published artifact and a source checkout always report the same value.
 */
export function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/version.js -> package root
  const manifest = join(here, '..', 'package.json');
  const raw = readFileSync(manifest, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof (parsed as { version: unknown }).version === 'string'
  ) {
    return (parsed as { version: string }).version;
  }
  throw new Error(`Could not read a version string from ${manifest}`);
}
