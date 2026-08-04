import { toInstant, type Instant } from '@careerforge/domain';
import {
  closeDatabase,
  EvidenceStore,
  nodePlatform,
  openDatabase,
  type Db,
} from '@careerforge/store';

import type { CareerforgePaths } from './paths.js';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', exitCode: 0 });

export const failure = (message: string, hint?: string): CommandResult => ({
  stdout: '',
  stderr: hint === undefined ? `${message}\n` : `${message}\n  -> ${hint}\n`,
  exitCode: 1,
});

/** Open the store, run something, always close. */
export function withStore<T>(
  paths: CareerforgePaths,
  body: (context: { db: Db; store: EvidenceStore }) => T,
): T {
  const { db } = openDatabase({ path: paths.database });
  try {
    return body({ db, store: new EvidenceStore(db, nodePlatform) });
  } finally {
    closeDatabase(db);
  }
}

/** Accepts a full instant or a plain date, which is what people actually type. */
export function parseBoundary(value: string, endOfDay: boolean): Instant {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return toInstant(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  return toInstant(value);
}
