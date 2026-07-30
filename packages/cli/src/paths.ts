import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolution order for the CareerForge home directory:
 *
 *   1. `CAREERFORGE_HOME`
 *   2. `~/.careerforge`
 *
 * Everything CareerForge writes lives beneath this single directory, so a user
 * can back it up, move it, or delete it without hunting through the filesystem.
 */
export function careerforgeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CAREERFORGE_HOME'];
  if (override !== undefined && override.trim() !== '') return override;
  return join(homedir(), '.careerforge');
}

export interface CareerforgePaths {
  home: string;
  database: string;
  blobs: string;
  exportDir: string;
  backups: string;
  config: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): CareerforgePaths {
  const home = careerforgeHome(env);
  return {
    home,
    database: join(home, 'careerforge.db'),
    blobs: join(home, 'blobs'),
    exportDir: join(home, 'export'),
    backups: join(home, 'backups'),
    config: join(home, 'config'),
  };
}
