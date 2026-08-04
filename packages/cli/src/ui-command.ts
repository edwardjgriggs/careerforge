import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { closeDatabase, openDatabase } from '@careerforge/store';
import { createExplorerServer } from '@careerforge/ui';

import { failure, ok, type CommandResult } from './command-runtime.js';
import { resolvePaths } from './paths.js';

export interface UiOptions {
  readonly port: number;
  readonly open: boolean;
}

/**
 * Serve the Evidence Explorer to this machine's browser.
 *
 * Long-running, unlike every other command here: it returns when the server
 * stops. The store connection is held open for the life of the server and
 * closed on shutdown, which is the one place in the CLI where that is correct
 * — every request needs it, and reopening per request would be a lie about
 * consistency.
 */
export async function ui(env: NodeJS.ProcessEnv, options: UiOptions): Promise<CommandResult> {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  const { db } = openDatabase({ path: paths.database });
  let explorer: Awaited<ReturnType<typeof createExplorerServer>>;
  try {
    explorer = await createExplorerServer({ db, port: options.port });
  } catch (error) {
    closeDatabase(db);
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      `Could not start the Explorer: ${message}`,
      message.includes('EADDRINUSE')
        ? `Something is already listening on port ${options.port}. Try --port ${options.port + 1}.`
        : 'Check that nothing else is using the port.',
    );
  }

  process.stdout.write(
    [
      `Evidence Explorer is running at ${explorer.url}`,
      '',
      'It is bound to this machine only — 127.0.0.1, and not configurable. Nothing',
      'on the page has left your computer, and the Explorer holds no API key and no',
      'network client of its own.',
      '',
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );

  if (options.open) openInBrowser(explorer.url);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void explorer.close().then(() => {
        closeDatabase(db);
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return ok('Evidence Explorer stopped.\n');
}

/**
 * Open the user's browser, and shrug if it does not work.
 *
 * Best effort by design: a failure here means the user pastes a URL, a mild
 * inconvenience, whereas treating it as fatal would make the Explorer unusable
 * on any system whose opener is unusual.
 */
function openInBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(command, [url], { shell: process.platform === 'win32', detached: true, stdio: 'ignore' })
      .on('error', () => undefined)
      .unref();
  } catch {
    // The URL is already printed above.
  }
}
