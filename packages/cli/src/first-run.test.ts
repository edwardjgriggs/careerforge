import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkCollectors, checkConsent, checkExport, checkProvider, runChecks } from './doctor.js';
import { COMMAND_NAMES, run } from './cli.js';
import { tour } from './tour.js';

/**
 * The first fifteen minutes.
 *
 * A stranger with no context has to reach a generated bullet without help, on
 * a machine with no API key, and come away trusting the thing rather than
 * merely having operated it. Everything here tests that experience rather than
 * any single feature.
 */

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cf-first-'));
  env = { CAREERFORGE_HOME: home };
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly; the OS reclaims temp directories.
  }
});

describe('the guided tour', () => {
  /** Run it and collect everything it said. */
  async function runTour(): Promise<string> {
    const lines: string[] = [];
    await tour(env, { reset: false, pause: false }, (text) => lines.push(text));
    return lines.join('\n');
  }

  it('runs end to end with no API key and no network', async () => {
    // The tour exists for somebody who has not decided to trust this yet.
    // Requiring a key would make it unavailable to exactly that person.
    const output = await runTour();
    expect(output).toContain('A guided tour of CareerForge');
    expect(output).toContain('No API key is used and nothing reaches the network.');
  });

  it('covers every idea a new user has to understand', async () => {
    const output = await runTour();
    for (const step of [
      'Collecting evidence',
      'Refusing what the evidence cannot carry',
      'Why the surviving claim is believed',
      'Answering the question it asked instead',
      'Regenerating, and what that does not mean',
      'Seeing exactly what would leave your machine',
      'Consent, per project',
      'Nothing leaves without you reading it',
    ]) {
      expect(output, `the tour skipped: ${step}`).toContain(step);
    }
  });

  it('shows a real refusal, with the claim removed rather than softened', async () => {
    const output = await runTour();
    expect(output).toContain('led the redesign of the export pipeline');
    expect(output).toContain('Leadership and responsibility cannot be inferred from activity');
    expect(output).toContain('cutting export time by 80%');
    // The first bullet says only what the evidence carries.
    expect(output).toContain('Rebuilt the nightly export to run incrementally.');
  });

  it('shows a claim becoming supported after the question is answered', async () => {
    // The payoff, and the thing a feature list cannot convey: a refusal is not
    // a dead end, it is a question with an answer.
    const output = await runTour();
    expect(output).toContain(
      'Rebuilt the nightly export to run incrementally and led the redesign of the export pipeline.',
    );
    expect(output).toContain('Your role is confirmed rather than assumed from activity');
  });

  it('is honest that answering did not change what was already written', async () => {
    const output = await runTour();
    expect(output).toContain('did not change the words already written');
  });

  it('shows a real egress refusal and the exact bytes anyway', async () => {
    const output = await runTour();
    expect(output).toContain('consent-required@1');
    expect(output).toContain('Shown anyway');
    expect(output).toContain('restricted-default@1');
  });

  it('leaves the user with a next step on their own data', async () => {
    const output = await runTour();
    expect(output).toContain('careerforge collect --backfill');
    expect(output).toContain('careerforge tour --reset');
  });

  it('writes only to its own sandbox, never to the real store', async () => {
    // A first-run experience that wrote to somebody's real career history
    // would be teaching distrust in the first ninety seconds.
    await runTour();
    expect(existsSync(join(home, 'tour', 'careerforge.db'))).toBe(true);
    expect(existsSync(join(home, 'careerforge.db'))).toBe(false);
  });

  it('starts fresh each run rather than resuming whatever was left', async () => {
    const first = await runTour();
    const second = await runTour();
    // Ids differ between runs; the narrative must not.
    const strip = (text: string) => text.replace(/01[0-9A-HJKMNP-TV-Z]{24}/g, '<id>');
    expect(strip(second)).toBe(strip(first));
  });

  it('removes its sandbox on request, and says where it was', async () => {
    await runTour();
    const result = await tour(env, { reset: true, pause: false }, () => undefined);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed the tour store');
    expect(existsSync(join(home, 'tour'))).toBe(false);
  });

  it('is reachable from the CLI', async () => {
    const result = await run(['tour', '--no-pause', '--reset'], env);
    expect(result.exitCode).toBe(0);
  });
});

describe('doctor diagnoses what a new user will actually hit', () => {
  it('never fails on a machine that has simply not started yet', () => {
    // An empty store and a broken installation look identical from outside.
    // Calling the first one a failure tells somebody their install is broken
    // when it is complete.
    const checks = runChecks(env);
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
  });

  it('says no collector has run, and what to run', () => {
    const check = checkCollectors(env);
    expect(check.status).toBe('warn');
    expect(check.fix).toContain('careerforge collect');
  });

  it('treats a missing API key as a warning, not a failure', () => {
    const check = checkProvider({ ...env, OPENAI_API_KEY: '' });
    expect(check.status).toBe('warn');
    expect(check.fix).toContain('work without one');
  });

  it('says plainly that nothing may leave, because that is the default', async () => {
    await run(['init'], env);
    expect(checkConsent(env).detail).toContain('nothing may leave this machine');
  });

  it('notices an export that was never taken', async () => {
    await run(['init'], env);
    const check = checkExport(env);
    expect(check.status).toBe('warn');
    expect(check.fix).toContain('careerforge export');
  });

  it('gives every check that is not ok something to do about it', () => {
    // A diagnosis with no next step is an accusation.
    for (const check of runChecks(env)) {
      if (check.status === 'ok') continue;
      expect(check.fix, `${check.id} has no fix`).toBeDefined();
      expect(check.fix!.length).toBeGreaterThan(15);
    }
  });
});

describe('the command surface is consistent', () => {
  it('gives every command help with a usage line and an example', async () => {
    for (const name of COMMAND_NAMES) {
      const result = await run([name, '--help'], env);
      expect(result.exitCode, `${name} --help failed`).toBe(0);
      expect(result.stdout, `${name} has no usage line`).toContain('Usage:');
      expect(result.stdout, `${name} has no example`).toContain('Example:');
      expect(result.stdout, `${name} example does not invoke it`).toContain(`careerforge ${name}`);
    }
  });

  it('lists every command in the top-level help', async () => {
    const usage = (await run([], env)).stdout;
    for (const name of COMMAND_NAMES) {
      expect(usage, `${name} is missing from the command list`).toContain(name);
    }
  });

  it('names a next step on every usage error', async () => {
    const result = await run(['definitely-not-a-command'], env);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('careerforge --help');
  });

  it('separates a usage error from a runtime failure by exit code', async () => {
    // 2 means "you typed something wrong", 1 means "CareerForge could not do
    // it". A script can tell them apart; so can a person.
    expect((await run(['nonsense'], env)).exitCode).toBe(2);
    expect((await run(['search', 'anything'], env)).exitCode).toBe(1);
  });

  it('never surfaces a stack trace', async () => {
    for (const argv of [['explain', 'nope'], ['review', 'nope'], ['units'], ['assets']]) {
      const result = await run(argv, env);
      expect(result.stderr).not.toContain('    at ');
      expect(result.stdout).not.toContain('    at ');
    }
  });

  it('answers --version and --help before touching the store', async () => {
    expect((await run(['--version'], env)).exitCode).toBe(0);
    expect((await run(['--help'], env)).exitCode).toBe(0);
    expect(existsSync(join(home, 'careerforge.db'))).toBe(false);
  });
});
