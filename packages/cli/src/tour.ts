import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { toInstant, type AttributeMap, type EvidenceDraft } from '@careerforge/domain';
import {
  closeDatabase,
  EvidenceStore,
  openDatabase,
  ProvenanceStore,
  WorkUnitStore,
  deterministicPlatform,
} from '@careerforge/store';

import {
  consent,
  explain,
  generate,
  group,
  init,
  interview,
  payloadForUnit,
  previewEgress,
  review,
  units,
  type CommandResult,
} from './commands.js';
import { resolvePaths } from './paths.js';

/**
 * The guided tour.
 *
 * CareerForge's hardest problem at this point is not teaching commands. It is
 * teaching *why the system works the way it does* — why a bullet came out
 * shorter than expected, why a claim was refused, why answering a question is
 * not the same as improving a sentence. Those are the ideas that make the
 * product worth using, and none of them survive a feature list.
 *
 * So the tour is a demonstration with an argument. Each step does something
 * real, then says what just happened and what principle it illustrates.
 *
 * ── It runs the shipped code ─────────────────────────────────────────────
 *
 * Every step calls the same command function the CLI calls. Nothing here is
 * simulated, mocked, or narrated over a script — if the tour works, the
 * product works, and if the product breaks the tour breaks with it. A
 * demonstration that cannot fail is a marketing asset, not a demonstration.
 *
 * ── It touches nothing of the user's ─────────────────────────────────────
 *
 * The tour builds its own store under `<home>/tour/` and never opens the real
 * one. A first-run experience that wrote to somebody's real career history
 * would be teaching distrust in the first ninety seconds.
 *
 * ── It needs no key and no network ───────────────────────────────────────
 *
 * Generation runs against a recorded provider whose answer is matched to the
 * real payload the policy engine produces. That is the same mechanism CI uses
 * (ADR-0023), which is also the point: a tour that required an API key would
 * be unavailable to exactly the person it exists for.
 */

/** Fixture evidence: structurally real, textually synthetic. */
const FIXTURES: readonly {
  collector: string;
  kind: string;
  uri: string;
  title: string;
  excerpt: string | null;
  at: string;
  attributes: AttributeMap;
}[] = [
  {
    collector: 'git',
    kind: 'git.commit',
    uri: 'git://demo/commit/a1',
    title: 'Replace the nightly export with an incremental one',
    excerpt: null,
    at: '2026-03-02T09:14:00.000Z',
    attributes: { files: ['exporter/incremental.ts', 'exporter/index.ts'], verbs: ['commit'] },
  },
  {
    collector: 'git',
    kind: 'git.commit',
    uri: 'git://demo/commit/a2',
    title: 'Add a resume point so a failed export restarts where it stopped',
    excerpt: null,
    at: '2026-03-02T11:40:00.000Z',
    attributes: { files: ['exporter/cursor.ts'], verbs: ['commit'] },
  },
  {
    collector: 'git',
    kind: 'git.commit',
    uri: 'git://demo/commit/a3',
    title: 'Cover the interrupted-export case with a regression test',
    excerpt: null,
    at: '2026-03-02T16:20:00.000Z',
    attributes: { files: ['exporter/cursor.test.ts'], verbs: ['commit'] },
  },
  {
    collector: 'session',
    kind: 'session.fragment',
    uri: 'session://demo/s1',
    title: 'Working out why the nightly export kept timing out',
    excerpt:
      'The export re-reads every record each night. It needs to resume from the last position instead of starting over.',
    at: '2026-03-02T08:50:00.000Z',
    attributes: { promptAuthorship: 'human' },
  },
  {
    collector: 'session',
    kind: 'session.fragment',
    uri: 'session://demo/s2',
    title: 'Deciding where to keep the resume position',
    excerpt:
      'Storing the cursor beside the export means a half-finished run can be told apart from a finished one.',
    at: '2026-03-02T13:20:00.000Z',
    attributes: { promptAuthorship: 'human' },
  },
  {
    collector: 'session',
    kind: 'session.fragment',
    uri: 'session://demo/s3',
    title: 'Reproducing the timeout with a large fixture',
    excerpt: 'Built a fixture big enough to trip the old timeout, which the new path survives.',
    at: '2026-03-02T15:05:00.000Z',
    attributes: { promptAuthorship: 'human' },
  },
];

/**
 * What the model proposes the first time.
 *
 * Four claims: one the evidence carries, and three it does not. Chosen to be
 * exactly what a résumé generator produces when nobody is checking — activity
 * rounded up into leadership, a plausible percentage, an outcome inferred from
 * the change that caused it.
 */
const PROPOSED = (ids: readonly string[]) => ({
  claims: [
    {
      text: 'rebuilt the nightly export to run incrementally',
      claimType: 'action',
      evidence: [ids[0], ids[1], ids[3]],
    },
    {
      text: 'led the redesign of the export pipeline',
      claimType: 'role',
      evidence: [ids[0], ids[4]],
    },
    { text: 'cutting export time by 80%', claimType: 'metric', evidence: [ids[2]] },
    {
      text: 'eliminating the nightly timeout alerts',
      claimType: 'outcome',
      evidence: [ids[1]],
    },
  ],
});

/**
 * What it proposes after the question has been answered.
 *
 * The same four claims. Only the role claim's citation differs: it now points
 * at the person's own answer instead of at a commit, which is the entire
 * difference between a refused claim and a supported one. The metric and the
 * outcome are still proposed and still refused, because one answer does not
 * make everything true.
 */
const PROPOSED_AFTER = (ids: readonly string[], answerId: string) => ({
  claims: [
    {
      text: 'rebuilt the nightly export to run incrementally',
      claimType: 'action',
      evidence: [ids[0], ids[1], ids[3]],
    },
    { text: 'led the redesign of the export pipeline', claimType: 'role', evidence: [answerId] },
    { text: 'cutting export time by 80%', claimType: 'metric', evidence: [ids[2]] },
    { text: 'eliminating the nightly timeout alerts', claimType: 'outcome', evidence: [ids[1]] },
  ],
});

const RULE = '─'.repeat(72);

export interface TourOptions {
  /** Delete the tour store and stop. */
  readonly reset: boolean;
  /** Wait for Enter between steps. Defaults to on when stdin is a terminal. */
  readonly pause: boolean;
}

interface Emit {
  (text: string): void;
}

/** A tour step: something real, then what it means. */
interface Step {
  readonly number: number;
  readonly title: string;
  /** The one idea. Printed after the output, because it explains it. */
  readonly principle: string;
  readonly run: (context: TourContext, say: Emit) => Promise<void> | void;
}

interface TourContext {
  readonly env: NodeJS.ProcessEnv;
  unitId: string;
  assetId: string;
  gapId: string;
  claimId: string;
  /** The evidence the person's own answer became. Empty until step 4. */
  answerId: string;
}

/** Indent a command's own output so it reads as a transcript, not as prose. */
function quote(result: CommandResult): string {
  const body = result.stdout !== '' ? result.stdout : result.stderr;
  return body
    .trimEnd()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

const STEPS: readonly Step[] = [
  {
    number: 1,
    title: 'Collecting evidence',
    principle:
      'CareerForge reads work you have already done. It never asks you to write anything down,\n' +
      'because the record already exists and the writing-down is the part nobody sustains.',
    run: (context, say) => {
      say('Six records have been placed in a sample store: three commits and three coding');
      say('sessions from one working day. On your own machine this is what `careerforge collect`');
      say('reads out of your Git history and your AI coding transcripts.');
      say('');
      say(quote(group(context.env, { dryRun: false })));
      say('');

      const listed = units(context.env, { limit: 5 });
      say(quote(listed));
      say('');
      say('Six artifacts became one unit of work — the size a person actually describes work at.');
      say('Neither a commit nor a whole quarter is a thing you say in an interview.');
    },
  },
  {
    number: 2,
    title: 'Refusing what the evidence cannot carry',
    principle:
      'A model proposed four things. Three of them were removed rather than softened —\n' +
      'there is no code path from a refused claim to weaker wording, which is how\n' +
      '"led the redesign" avoids becoming "helped lead the redesign".',
    run: async (context, say) => {
      say('A model has been asked to write a résumé bullet about that work. It proposed four');
      say('assertions: what was done, that the person led it, a percentage, and an outcome.');
      say('');
      const generated = await generate(context.env, {
        workUnitId: context.unitId,
        providerId: 'ollama',
        dryRun: false,
        force: false,
      });
      say(quote(generated));
    },
  },
  {
    number: 3,
    title: 'Why the surviving claim is believed',
    principle:
      'The proof separates what happened from what a model made of it. An interpretation can\n' +
      'explain how a sentence came to be worded and can never be a reason to believe it.',
    run: (context, say) => {
      say('Every claim that survived carries its own support. This is the one that did:');
      say('');
      say(quote(explain(context.env, context.claimId)));
    },
  },
  {
    number: 4,
    title: 'Answering the question it asked instead',
    principle:
      'CareerForge asks rather than guesses. Your answer becomes evidence you stand behind —\n' +
      'the only kind that can support a claim about leadership, and reusable in everything\n' +
      'written about this work afterwards.',
    run: (context, say) => {
      say('The refused leadership claim did not vanish. It became a question:');
      say('');
      say(quote(interview(context.env, { workUnitId: context.unitId, limit: 3, decline: false })));
      say('');
      say('Answering it:');
      say('');
      say(
        quote(
          interview(context.env, {
            gapId: context.gapId,
            answer: 'I designed the incremental export and decided how the resume point worked.',
            limit: 3,
            decline: false,
          }),
        ),
      );
    },
  },
  {
    number: 5,
    title: 'Regenerating, and what that does not mean',
    principle:
      'Answering made the *evidence* stronger. It did not change the words already written —\n' +
      'those still rest on the records they came from. A statement improves when it is\n' +
      'regenerated, and not a moment before.',
    run: async (context, say) => {
      say('The bullet on record has not changed and must not appear to have. Regenerating is');
      say('what lets it use the answer:');
      say('');
      // The answer joined the work unit, so the payload a provider would see
      // is no longer the one that was recorded — which is the recorded
      // provider refusing to guess, working exactly as designed. The tour has
      // an answer ready for the payload as it now stands.
      recordProviderAnswer(context.env, context.unitId, (ids) =>
        PROPOSED_AFTER(ids, context.answerId),
      );
      const regenerated = await generate(context.env, {
        workUnitId: context.unitId,
        providerId: 'ollama',
        dryRun: false,
        force: true,
      });
      say(quote(regenerated));
    },
  },
  {
    number: 6,
    title: 'Seeing exactly what would leave your machine',
    principle:
      'The preview is mandatory rather than advisory. Pattern redaction cannot catch a client\n' +
      'name in a sentence, so a person reading the actual bytes is the real mitigation —\n' +
      'and it works even when the answer is no, because that is how you decide.',
    run: (context, say) => {
      say('Nothing has left this machine. Before anything could, you can read the exact bytes:');
      say('');
      say(
        quote(
          previewEgress(context.env, {
            workUnitId: context.unitId,
            providerId: 'openai',
            full: false,
          }),
        ),
      );
    },
  },
  {
    number: 7,
    title: 'Consent, per project',
    principle:
      'Consent is granted per project, and there is deliberately no global switch. Client work\n' +
      'stays on your machine while personal work does not, and restricted work never leaves\n' +
      'unless you say so for that project specifically.',
    run: (context, say) => {
      say(
        quote(
          consent(context.env, {
            action: 'grant',
            providerId: 'openai',
            projectKey: 'demo-exporter',
            level: 'confidential',
          }),
        ),
      );
      say('');
      say('And the same preview now says something different:');
      say('');
      const after = previewEgress(context.env, {
        workUnitId: context.unitId,
        providerId: 'openai',
        full: false,
      });
      // Only as far as the refusal: the payload was shown in step 6 and
      // repeating it here would bury the one thing that changed.
      const lines = after.stdout.split('\n');
      const end = lines.findIndex((line) => line.startsWith('Shown anyway'));
      say(
        lines
          .slice(0, end === -1 ? 12 : end)
          .map((line) => `    ${line}`)
          .join('\n')
          .trimEnd(),
      );
    },
  },
  {
    number: 8,
    title: 'Nothing leaves without you reading it',
    principle:
      'The review gate lives in the export path rather than in a screen, so a scripted run and\n' +
      'a future desktop app inherit it too. A draft cannot be exported. Neither can something\n' +
      'you rejected.',
    run: (context, say) => {
      say(quote(review(context.env, { assetId: context.assetId })));
    },
  },
];

/**
 * Run the tour.
 *
 * Sequential and side-effecting by nature: each step depends on the store the
 * previous one left behind, which is also what makes it a demonstration rather
 * than eight disconnected examples.
 */
export async function tour(
  env: NodeJS.ProcessEnv,
  options: TourOptions,
  write: Emit = (text) => process.stdout.write(`${text}\n`),
  waitForEnter?: () => Promise<void>,
): Promise<CommandResult> {
  const home = join(resolvePaths(env).home, 'tour');

  if (options.reset) {
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
    return { stdout: `Removed the tour store at ${home}.\n`, stderr: '', exitCode: 0 };
  }

  // A fresh store every run. A tour that resumed halfway would demonstrate
  // whatever state the last run happened to leave, which is the opposite of a
  // guided anything.
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  const tourEnv: NodeJS.ProcessEnv = { ...env, CAREERFORGE_HOME: home };
  delete tourEnv['OPENAI_API_KEY'];

  write('');
  write(RULE);
  write('  A guided tour of CareerForge');
  write(RULE);
  write('');
  write('  This runs the real commands against a sample store of six fixture records.');
  write(`  It is written to ${home}`);
  write('  and touches nothing else. Your own store, if you have one, is not opened.');
  write('');
  write('  No API key is used and nothing reaches the network.');
  write('');
  write('  The point is not the commands. It is why the answers come out the way they do.');
  write('');

  const context = seed(tourEnv);
  resolveIds(context);

  for (const step of STEPS) {
    write('');
    write(RULE);
    write(`  ${step.number}. ${step.title}`);
    write(RULE);
    write('');
    await step.run(context, write);
    // After every step, not before the ones that need it: a claim id exists
    // only once something has been generated, and a gap id only once
    // something has been refused.
    resolveIds(context);
    write('');
    write('  ── Why ──');
    for (const line of step.principle.split('\n')) write(`  ${line}`);
    write('');

    if (options.pause && waitForEnter !== undefined && step.number < STEPS.length) {
      write('  [Enter] to continue');
      await waitForEnter();
    }
  }

  write('');
  write(RULE);
  write('  That is the whole idea');
  write(RULE);
  write('');
  write('  Every statement CareerForge writes is traceable to evidence you can inspect,');
  write('  every refusal names what would change the answer, and nothing leaves this');
  write('  machine without you having seen the exact bytes and said yes.');
  write('');
  write('  On your own work:');
  write('');
  write('    careerforge init');
  write('    careerforge collect --backfill      # your Git history and coding sessions');
  write('    careerforge group                   # into units of work');
  write('    careerforge ui                      # and read what it believes, and why');
  write('');
  write(`  This tour left a sample store at ${home}`);
  write('  Remove it with: careerforge tour --reset');
  write('');

  return { stdout: '', stderr: '', exitCode: 0 };
}

/**
 * Build the sample store, and record the answer generation will receive.
 *
 * The recorded answer is keyed on the payload the policy engine actually
 * produces, read back through the same function `preview` uses. A hand-written
 * approximation would drift from the real thing and the tour would teach
 * something that does not happen.
 */
function seed(env: NodeJS.ProcessEnv): TourContext {
  init(env);

  const paths = resolvePaths(env);
  const platform = deterministicPlatform();
  const { db } = openDatabase({ path: paths.database });

  let unitId: string;
  let evidenceIds: string[];
  try {
    const evidence = new EvidenceStore(db, platform);
    evidenceIds = FIXTURES.map((fixture) => {
      const draft: EvidenceDraft = {
        collectorId: fixture.collector,
        sourceUri: fixture.uri,
        kind: fixture.kind,
        evidenceClass: 'imported',
        sensitivity: fixture.collector === 'session' ? 'restricted' : 'confidential',
        occurredAt: toInstant(fixture.at),
        occurredEnd: null,
        context: { projectKey: 'demo-exporter', workspace: null, stream: 'main' },
        title: fixture.title,
        summary: null,
        excerpt: fixture.excerpt,
        payloadRef: null,
        attributes: fixture.attributes,
        groupingHint: null,
        collectorVersion: '1.0.0',
        sourceFormatVersion: null,
      };
      return evidence.emit(draft).evidence.id;
    });

    const workUnits = new WorkUnitStore(db, platform);
    workUnits.group();
    // The largest unit, not the first. The fixtures are arranged to group into
    // one, and picking positionally would silently demonstrate a stray
    // fragment if that ever stopped being true.
    unitId = [...workUnits.currentUnits()].sort(
      (a, b) => workUnits.memberIds(b.id).length - workUnits.memberIds(a.id).length,
    )[0]!.id;
  } finally {
    closeDatabase(db);
  }

  env['CAREERFORGE_CASSETTE'] = join(paths.home, 'tour-provider.json');
  env['CAREERFORGE_TOUR_EVIDENCE'] = evidenceIds.join(',');
  recordProviderAnswer(env, unitId, PROPOSED);

  // Consent for the local provider only, so the tour can generate while the
  // egress steps still demonstrate a real refusal for a remote one.
  consent(env, {
    action: 'grant',
    providerId: 'ollama',
    projectKey: 'demo-exporter',
    level: 'restricted',
  });

  return { env, unitId, assetId: '', gapId: '', claimId: '', answerId: '' };
}

/**
 * Record the answer a provider would give, against the payload as it stands.
 *
 * Read back through the same function `preview` uses, so the fixture cannot
 * drift from what generation actually sends. When the payload changes — which
 * it does the moment an interview answer joins the work unit — the recording
 * has to be made again, and the recorded provider refusing in the meantime is
 * that mechanism working rather than failing.
 */
function recordProviderAnswer(
  env: NodeJS.ProcessEnv,
  unitId: string,
  claims: (ids: readonly string[]) => unknown,
): void {
  const payload = payloadForUnit(env, unitId) ?? '';
  const ids = (env['CAREERFORGE_TOUR_EVIDENCE'] ?? '').split(',');
  writeFileSync(
    env['CAREERFORGE_CASSETTE']!,
    JSON.stringify(
      {
        entries: [
          {
            name: 'the tour bullet',
            match: { schemaName: 'resume_bullet', model: 'llama3.1', payload },
            response: {
              value: claims(ids),
              model: 'careerforge-tour-fixture',
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
}

/**
 * Fill in the ids the later steps need, once the earlier steps have made them.
 *
 * Read from the store rather than threaded through return values, because the
 * tour is demonstrating commands whose real output is text — reaching into
 * what they returned would be a shape no real caller has.
 */
export function resolveIds(context: TourContext): void {
  const { db } = openDatabase({ path: resolvePaths(context.env).database });
  try {
    const provenance = new ProvenanceStore(db, deterministicPlatform());
    const gaps = provenance.openGaps(context.unitId);
    const role = gaps.find((gap) => gap.gapType === 'role');
    context.gapId = role?.id ?? gaps[0]?.id ?? '';

    const claim = db.prepare(`SELECT id FROM claims_current ORDER BY id LIMIT 1`).get() as
      { id: string } | undefined;
    context.claimId = claim?.id ?? '';

    const answer = db
      .prepare(
        `SELECT id FROM evidence_current
         WHERE evidence_class = 'user_confirmed' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    context.answerId = answer?.id ?? '';

    // The newest asset, not the one step 2 happened to make. Regenerating
    // writes another, and the last step should show what the tour arrived at
    // rather than where it started.
    const asset = db
      .prepare(
        `SELECT a.id FROM assets a
         WHERE NOT EXISTS (SELECT 1 FROM assets s WHERE s.supersedes = a.id)
         ORDER BY a.id DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (asset !== undefined) context.assetId = asset.id;
  } finally {
    closeDatabase(db);
  }
}
