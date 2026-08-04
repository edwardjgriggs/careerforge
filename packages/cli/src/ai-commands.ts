import { existsSync, readFileSync } from 'node:fs';

import {
  explainRefusal,
  isSensitivity,
  toInstant,
  SENSITIVITY_LEVELS,
  type EnrichmentType,
  type EvidenceClass,
  type Refusal,
  type Sensitivity,
} from '@careerforge/domain';
import {
  createOpenAIProvider,
  evaluate,
  preview,
  ProviderRefusedError,
  type PayloadItem,
  type Provider,
  type ProviderPort,
} from '@careerforge/policy';
import {
  canonicalise,
  createRecordedProvider,
  executeRun,
  explainDifference,
  parseCassette,
  ENRICHABLE_TYPES,
  type EnrichmentInput,
} from '@careerforge/enrich';
import {
  closeDatabase,
  ConsentStore,
  EnrichmentStore,
  WorkUnitStore,
  nodePlatform,
  openDatabase,
  sha256,
  type Db,
} from '@careerforge/store';

import { failure, ok, withStore, type CommandResult } from './command-runtime.js';
import { resolvePaths } from './paths.js';

const PROVIDERS: Readonly<Record<string, Provider>> = {
  openai: { id: 'openai', locality: 'remote' },
  anthropic: { id: 'anthropic', locality: 'remote' },
  ollama: { id: 'ollama', locality: 'local' },
};

export function resolveProvider(id: string): Provider {
  // An unknown provider is treated as remote. Guessing "local" for something
  // we cannot identify would fail open, and this is the one place in the
  // codebase where failing open is unacceptable.
  return PROVIDERS[id] ?? { id, locality: 'remote' };
}

export function renderRefusals(refusals: readonly Refusal[]): string[] {
  const lines: string[] = [];
  for (const refusal of refusals) {
    const { why, next } = explainRefusal(refusal);
    lines.push(`  BLOCKED by ${refusal.rule}`, `    ${why}`, `    -> ${next}`, '');
  }
  return lines;
}

export interface ConsentOptions {
  readonly action: 'list' | 'grant' | 'revoke';
  readonly providerId?: string;
  readonly projectKey?: string;
  readonly level?: string;
  readonly reason?: string;
}

export function consent(env: NodeJS.ProcessEnv, options: ConsentOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const store = new ConsentStore(db, nodePlatform);

    if (options.action === 'list') {
      const grants = store.list();
      if (grants.length === 0) {
        return ok(
          [
            'No provider may receive anything.',
            '',
            'That is the default, and nothing changes it globally — consent is granted per',
            'project so client work can stay on this machine while personal work does not.',
            '',
            '  careerforge consent grant --provider openai --project my-repo --level confidential',
            '',
          ].join('\n'),
        );
      }

      const lines = ['What each provider may receive:', ''];
      for (const grant of grants) {
        lines.push(
          `  ${grant.revoked ? 'REVOKED' : 'allowed'}  ${grant.providerId.padEnd(12)} ` +
            `${(grant.projectKey ?? '(every project)').padEnd(24)} up to ${grant.maxSensitivity}`,
        );
      }
      lines.push('', 'Restricted work never leaves unless a grant says so for that project.', '');
      return ok(lines.join('\n'));
    }

    if (options.providerId === undefined) {
      return failure('Which provider?', 'Pass --provider <id>.');
    }
    const projectKey = options.projectKey ?? null;

    if (options.action === 'revoke') {
      store.revoke(projectKey, options.providerId, options.reason);
      return ok(
        [
          `${options.providerId} may no longer receive ${projectKey ?? 'anything'}.`,
          '',
          'The grant is not deleted — it is superseded, so what you allowed and when',
          'stays answerable.',
          '',
        ].join('\n'),
      );
    }

    const level = options.level ?? 'confidential';
    if (!isSensitivity(level)) {
      return failure(`Unknown level: ${level}.`, `Use one of ${SENSITIVITY_LEVELS.join(', ')}.`);
    }

    store.grant({
      projectKey,
      providerId: options.providerId,
      maxSensitivity: level,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });

    return ok(
      [
        `${options.providerId} may now receive ${projectKey ?? 'work from any project'} up to ${level}.`,
        '',
        level === 'restricted'
          ? 'That includes session transcripts, which routinely contain pasted credentials\nand files never committed. Use `careerforge preview` before enrichment lands.'
          : 'Anything more sensitive than that is still refused.',
        '',
      ].join('\n'),
    );
  });
}

/**
 * The evidence behind a work unit, in the shape both egress and enrichment
 * need.
 *
 * One reader for both so that what `preview` shows and what `enrich` sends
 * cannot drift. A preview that showed something other than what was sent would
 * be worse than no preview at all.
 *
 * `contentHash` travels with each record because it is what makes an
 * enrichment stale later: the ids can be unchanged while the facts beneath
 * them have been corrected.
 */
/**
 * One record, carrying what both egress and generation need.
 *
 * Structurally an `EnrichmentInput`, plus the fields a claim check needs and a
 * payload does not: which collector produced it, what kind it is, and the
 * attributes a scope figure might be corroborated against. Kept in one type so
 * the records the model reads and the records its claims are checked against
 * are provably the same records.
 */
export interface UnitRecord extends EnrichmentInput {
  readonly collectorId: string;
  readonly kind: string;
  readonly evidenceClass: EvidenceClass;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export function unitInputs(db: Db, units: WorkUnitStore, unitId: string): UnitRecord[] {
  const inputs: UnitRecord[] = [];
  for (const evidenceId of units.memberIds(unitId)) {
    const row = db
      .prepare(
        `SELECT e.sensitivity, e.project_key, e.content_hash, e.collector_id, e.kind,
                e.evidence_class,
                COALESCE(c.title,'') AS title, COALESCE(c.excerpt,'') AS excerpt,
                COALESCE(c.attributes,'{}') AS attributes
         FROM evidence_current e LEFT JOIN evidence_content c ON c.evidence_id = e.id
         WHERE e.id = ?`,
      )
      .get(evidenceId) as
      | {
          sensitivity: string;
          project_key: string | null;
          content_hash: string;
          collector_id: string;
          kind: string;
          evidence_class: string;
          title: string;
          excerpt: string;
          attributes: string;
        }
      | undefined;
    if (row === undefined) continue;
    inputs.push({
      id: evidenceId,
      contentHash: row.content_hash,
      sensitivity: row.sensitivity as Sensitivity,
      projectKey: row.project_key,
      text: recordText(row.title, row.excerpt),
      collectorId: row.collector_id,
      kind: row.kind,
      evidenceClass: row.evidence_class as EvidenceClass,
      attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    });
  }
  return inputs;
}

/**
 * One record, as text, without saying the same thing twice.
 *
 * A session collector derives its title *from* the first prompt, so the naive
 * `title + excerpt` sends the same sentence twice. Caught on the first run
 * against a real store. It costs tokens on every call, and worse, repetition
 * reads as emphasis to a model — the duplicated sentence would be weighted
 * more heavily than the work it describes.
 */
function recordText(title: string, excerpt: string): string {
  if (excerpt === '') return title;
  if (title === '' || excerpt.startsWith(title)) return excerpt;
  return `${title}\n${excerpt}`;
}

/**
 * Exactly what a provider would be shown for this work unit.
 *
 * Exported so the guided tour can record an answer against the real payload
 * rather than a hand-written approximation of it. A tour whose fixture drifted
 * from what generation actually sends would teach the wrong thing and pass its
 * own tests while doing it.
 */
export function payloadForUnit(env: NodeJS.ProcessEnv, workUnitId: string): string | null {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) return null;

  return withStore(paths, ({ db }) => {
    const units = new WorkUnitStore(db, nodePlatform);
    if (units.byId(workUnitId) === null) return null;
    const items = unitInputs(db, units, workUnitId).map(toPayloadItem);
    return preview({ provider: resolveProvider('ollama'), purpose: 'preview', items }).payload;
  });
}

const toPayloadItem = (input: EnrichmentInput): PayloadItem => ({
  kind: 'evidence',
  id: input.id,
  sensitivity: input.sensitivity,
  projectKey: input.projectKey,
  text: input.text,
});

export interface PreviewOptions {
  readonly workUnitId: string;
  readonly providerId: string;
  readonly full: boolean;
}

/**
 * Show exactly what would be transmitted.
 *
 * Mandatory rather than advisory (ADR-0009). Pattern redaction cannot catch a
 * client's name in a sentence or a frank opinion about a colleague; a person
 * reading the actual bytes is the only real mitigation for that class. So this
 * works even when the request would be refused — seeing what *would* leave is
 * how somebody decides whether to allow it.
 */
export function previewEgress(env: NodeJS.ProcessEnv, options: PreviewOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const units = new WorkUnitStore(db, nodePlatform);
    const consentStore = new ConsentStore(db, nodePlatform);

    const unit = units.currentUnits().find((candidate) => candidate.id === options.workUnitId);
    if (unit === undefined) {
      return failure(
        `No work unit ${options.workUnitId}.`,
        'Run `careerforge units` to list them.',
      );
    }

    const inputs = unitInputs(db, units, unit.id);
    const items: PayloadItem[] = inputs.map(toPayloadItem);

    const provider = resolveProvider(options.providerId);
    const request = { provider, purpose: 'preview', items };
    const shown = preview(request);
    const decision = evaluate(request, {
      consent: (projectKey, providerId) => consentStore.lookup(projectKey, providerId),
      digest: sha256,
    });
    consentStore.recordDecision(decision);

    const lines = [
      `Work unit: ${unit.title}`,
      `Provider:  ${provider.id} (${provider.locality})`,
      `Contains:  ${items.length} record(s), most sensitive is ${decision.maxSensitivity}`,
      '',
    ];

    if (decision.allowed) {
      lines.push('ALLOWED — this is exactly what would be transmitted:', '');
    } else {
      lines.push(
        'REFUSED — nothing would be transmitted.',
        '',
        ...renderRefusals(decision.refusals),
        'Shown anyway, because seeing what would leave is how you decide whether to allow it:',
        '',
      );
    }

    const body = options.full ? shown.payload : shown.payload.slice(0, 2_000);
    lines.push(
      body === '' ? '  (nothing to send)' : body,
      body.length < shown.payload.length
        ? `\n  ... ${shown.payload.length - body.length} more characters (--full to see all)`
        : '',
      '',
      shown.redaction.totalRedactions === 0
        ? 'Redaction removed nothing. That is not a promise there is nothing sensitive here —'
        : `Redaction removed ${shown.redaction.totalRedactions} item(s) using ${shown.redaction.profile}:`,
    );

    for (const finding of shown.redaction.findings) {
      lines.push(`  ${finding.count} x ${finding.ruleId}`);
    }

    lines.push(
      '',
      'Patterns catch keys, tokens, and connection strings. They do not catch a client',
      'name in a sentence or an opinion about a colleague. Read the text above before',
      'you allow anything — that is what this command is for.',
      '',
    );

    return ok(lines.join('\n'));
  });
}

// ── Enrichment ────────────────────────────────────────────────────────────

/**
 * Which model each provider is asked for by default.
 *
 * The requested name, which is not necessarily what answers. The run record
 * keeps both, because an alias quietly advancing to a newer snapshot is the
 * most common real reason last year's interpretation reads differently from
 * this year's.
 */
export const DEFAULT_MODELS: Readonly<Record<string, string>> = {
  openai: 'gpt-5',
  anthropic: 'claude-sonnet-5',
  ollama: 'llama3.1',
};

/**
 * Which provider actually answers.
 *
 * `CAREERFORGE_CASSETTE` points at a recorded conversation and swaps in the
 * recorded provider. That exists so somebody improving a prompt does not need
 * to fund an OpenAI account to see whether their change works — requiring a
 * credential to develop enrichment does not merely inconvenience contributors,
 * it selects which contributors exist.
 *
 * A recorded run is labelled everywhere it appears. Recorded output that looked
 * like a live answer would be a lie in the audit trail.
 */
export function resolveProviderPort(
  env: NodeJS.ProcessEnv,
  providerId: string,
): {
  port: ProviderPort;
  recorded: boolean;
} {
  const cassettePath = env['CAREERFORGE_CASSETTE'];
  if (cassettePath !== undefined && cassettePath !== '') {
    const cassette = parseCassette(JSON.parse(readFileSync(cassettePath, 'utf8')));
    return { port: createRecordedProvider(cassette, { digest: sha256 }), recorded: true };
  }
  if (providerId === 'openai') {
    // Constructed here rather than at module load, so a missing key is a refusal
    // at the moment of use — with a remedy — and never something that stops the
    // rest of the CLI from working.
    return { port: createOpenAIProvider({ apiKey: env['OPENAI_API_KEY'] }), recorded: false };
  }

  return {
    port: async () => {
      throw new ProviderRefusedError([
        {
          code: 'provider_not_implemented',
          rule: 'provider-not-implemented@1',
          reason: `CareerForge does not have a live ${providerId} adapter.`,
          remedy: {
            kind: 'not_possible',
            detail: 'Use --provider openai or configure CAREERFORGE_CASSETTE for a recorded run.',
          },
        },
      ]);
    },
    recorded: false,
  };
}

export interface EnrichOptions {
  readonly workUnitId: string;
  readonly enrichmentType?: string;
  readonly providerId: string;
  readonly model?: string;
  readonly dryRun: boolean;
  readonly force: boolean;
}

function renderRun(
  label: string,
  fingerprint: { templateId: string; promptHash: string; inputHash: string },
  extra: readonly string[] = [],
): string[] {
  return [
    label,
    `    prompt   ${fingerprint.templateId} (${fingerprint.promptHash.slice(0, 12)})`,
    `    evidence ${fingerprint.inputHash.slice(0, 12)}`,
    ...extra,
  ];
}

/**
 * Interpret a work unit, through the gate and into a reviewable record.
 *
 * The command is deliberately unexciting about its own output. It prints what
 * the model said, and beside it the four things that decide whether to believe
 * any of it: which prompt version ran, which model actually answered, which
 * records each statement cites, and what was thrown away for citing something
 * that was never sent.
 *
 * That framing is the product. A tool that prints resume bullets is
 * commonplace; one where every generated sentence remains attributable,
 * inspectable, and challengeable is not.
 */
export async function enrich(
  env: NodeJS.ProcessEnv,
  options: EnrichOptions,
): Promise<CommandResult> {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  const requested = options.enrichmentType ?? 'skills';
  if (!ENRICHABLE_TYPES.includes(requested as EnrichmentType)) {
    return failure(
      `CareerForge has no published prompt for "${requested}".`,
      `Available: ${ENRICHABLE_TYPES.join(', ')}.`,
    );
  }
  const enrichmentType = requested as EnrichmentType;

  const { db } = openDatabase({ path: paths.database });
  try {
    const units = new WorkUnitStore(db, nodePlatform);
    const consentStore = new ConsentStore(db, nodePlatform);
    const enrichmentStore = new EnrichmentStore(db, nodePlatform);

    const unit = units.byId(options.workUnitId);
    if (unit === null) {
      return failure(
        `No work unit ${options.workUnitId}.`,
        'Run `careerforge units` to list them.',
      );
    }

    const inputs = unitInputs(db, units, unit.id);
    if (inputs.length === 0) {
      return failure(
        'That work unit has no evidence to interpret.',
        'Run `careerforge collect` and `careerforge group` first.',
      );
    }

    const provider = resolveProvider(options.providerId);
    const model = options.model ?? DEFAULT_MODELS[provider.id] ?? 'gpt-5';
    const startedAt = toInstant(new Date().toISOString());
    const { port, recorded } = resolveProviderPort(env, provider.id);

    const outcome = await executeRun(
      { target: { kind: 'work_unit', id: unit.id }, enrichmentType, provider, model, inputs },
      {
        consent: (projectKey, providerId) => consentStore.lookup(projectKey, providerId),
        digest: sha256,
        provider: port,
        lookupCached: (fingerprint) => enrichmentStore.findCached(fingerprint),
        dryRun: options.dryRun,
        force: options.force,
      },
    );

    const header = [
      `Work unit: ${unit.title}`,
      `Reading:   ${inputs.length} record(s)`,
      `Asking:    ${provider.id} (${provider.locality}) for ${enrichmentType}`,
      ...(recorded ? ['', 'RECORDED — answering from a cassette, not from a live provider.'] : []),
      '',
    ];

    switch (outcome.kind) {
      case 'unsupported':
        return failure(outcome.refusal.reason, explainRefusal(outcome.refusal).next);

      case 'refused': {
        // Recorded even though nothing was sent. A trail containing only the
        // permitted calls answers "what left?" and not "what was attempted?",
        // and the second is the question asked after a scare.
        consentStore.recordDecision(outcome.decision);
        return {
          stdout: [
            ...header,
            'REFUSED — nothing was sent and nothing was recorded.',
            '',
            ...renderRefusals(outcome.refusals),
          ].join('\n'),
          stderr: '',
          exitCode: 1,
        };
      }

      case 'cached': {
        const run = enrichmentStore.runById(outcome.cached.runId);
        return ok(
          [
            ...header,
            'Already interpreted. No call was made and nothing was spent.',
            '',
            ...renderRun('  This answer came from an earlier run:', outcome.fingerprint, [
              `    model    ${run?.resolvedModel ?? outcome.fingerprint.model}`,
              `    run      ${outcome.cached.runId}`,
            ]),
            '',
            'The evidence, prompt, model, and parameters are all unchanged, so the answer',
            'would be the same answer. Use --force to ask anyway.',
            '',
          ].join('\n'),
        );
      }

      case 'dry_run':
        return ok(
          [
            ...header,
            'DRY RUN — nothing was sent.',
            '',
            ...renderRun('  This is what would run:', outcome.fingerprint),
            '',
            '  ── Instructions (static, versioned, evidence-free) ──',
            outcome.instructions.replace(/^/gm, '  '),
            '',
            '  ── Payload (your evidence, redacted) ──',
            outcome.payload.replace(/^/gm, '  '),
            '',
          ].join('\n'),
        );

      case 'completed': {
        const decisionId =
          provider.locality === 'remote' ? consentStore.recordDecision(outcome.decision) : null;

        const usable = outcome.validated.items.length > 0;
        const previousRuns = enrichmentStore.runsFor(unit.id, enrichmentType);

        const runId = enrichmentStore.recordRun({
          fingerprint: outcome.fingerprint,
          target: { kind: 'work_unit', id: unit.id },
          enrichmentType,
          resolvedModel: outcome.response.model,
          policyDecisionId: decisionId,
          redactionProfile: outcome.decision.redaction.profile,
          // An unusable run is recorded and never cached, so a bad answer does
          // not become permanent while the fact that it happened still does.
          status: usable ? 'completed' : 'unusable',
          usage: outcome.usage,
          validated: outcome.validated,
          startedAt,
        });

        const lines = [
          ...header,
          usable
            ? `${outcome.validated.items.length} interpretation(s), each citing what it read:`
            : 'Nothing usable came back.',
          '',
        ];

        for (const item of outcome.validated.items) {
          const value = item.value as Record<string, unknown>;
          const label = String(value['name'] ?? value['situation'] ?? '(unnamed)');
          lines.push(`  ${label}`);
          for (const [key, member] of Object.entries(value)) {
            if (key === 'name' || key === 'situation') continue;
            lines.push(`    ${key.padEnd(12)} ${String(member)}`);
          }
          lines.push(`    ${'cites'.padEnd(12)} ${item.evidence.join(', ')}`, '');
        }

        if (outcome.validated.rejections.length > 0) {
          lines.push(
            `Discarded ${outcome.validated.rejections.length} item(s):`,
            ...outcome.validated.rejections.map((r) => `  ${r.reason.padEnd(20)} ${r.summary}`),
            '',
          );
        }

        if (outcome.validated.unknownCitations.length > 0) {
          lines.push(
            'The model cited records that were never sent to it:',
            ...outcome.validated.unknownCitations.map((id) => `  ${id}`),
            '',
            'Statements resting only on those were discarded. Nothing in your store',
            'stands behind them.',
            '',
          );
        }

        const previous = previousRuns[0];
        if (previous !== undefined) {
          const current = enrichmentStore.runById(runId)!;
          lines.push(
            'Different from the last run because:',
            ...explainDifference(previous, current, true).map(
              (difference) => `  ${difference.dimension.padEnd(22)} ${difference.explanation}`,
            ),
            '',
          );
        }

        lines.push(
          `Recorded as run ${runId}.`,
          `  prompt   ${outcome.fingerprint.templateId}`,
          `  asked    ${model}`,
          `  answered ${outcome.response.model}`,
          `  cost     ${outcome.usage.inputTokens} in, ${outcome.usage.outputTokens} out`,
          '',
          'None of this supports anything yet. An interpretation explains a record; it',
          'never stands behind a claim, and `careerforge explain` shows it on the',
          'interpretation side of the line rather than among the grounds.',
          '',
        );

        return ok(lines.join('\n'));
      }
    }
  } finally {
    closeDatabase(db);
  }
}

export interface EnrichmentsOptions {
  readonly workUnitId: string;
  readonly showRuns: boolean;
}

/**
 * What a model has said about a work unit, and whether to believe it.
 *
 * The review surface. Every interpretation is shown with the run that produced
 * it, the records it cites, whether the evidence beneath it has moved, and
 * whether a person has passed judgement on it yet. Unreviewed is the default
 * and stays visible: an AI output that quietly becomes authoritative by never
 * being questioned is the failure this whole design is arranged against.
 */
export function enrichments(env: NodeJS.ProcessEnv, options: EnrichmentsOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const units = new WorkUnitStore(db, nodePlatform);
    const store = new EnrichmentStore(db, nodePlatform);

    const unit = units.byId(options.workUnitId);
    if (unit === null) {
      return failure(
        `No work unit ${options.workUnitId}.`,
        'Run `careerforge units` to list them.',
      );
    }

    const byId = new Map(
      unitInputs(db, units, unit.id).map((input) => [input.id, input.contentHash]),
    );
    // The same hashing the run used, so staleness compares like with like. A
    // record that has left the unit hashes as absent, which is a change.
    const currentHash = (ids: readonly string[]): string =>
      sha256(canonicalise([...ids].sort().map((id) => [id, byId.get(id) ?? null])));

    const current = store.currentFor(unit.id, currentHash);
    if (current.length === 0) {
      return ok(
        [
          `Work unit: ${unit.title}`,
          '',
          'Nothing has been interpreted yet.',
          '',
          `  careerforge enrich --unit ${unit.id} --type skills`,
          '',
        ].join('\n'),
      );
    }

    const lines = [`Work unit: ${unit.title}`, ''];
    for (const item of current) {
      const value = item.value as Record<string, unknown>;
      const label = String(value['name'] ?? value['situation'] ?? '(unnamed)');
      lines.push(
        `  ${item.stale ? 'STALE   ' : '        '}${item.reviewState.padEnd(11)} ${label}`,
        `            cites  ${item.basis.join(', ')}`,
        `            run    ${item.runId}`,
        '',
      );
    }

    if (current.some((item) => item.stale)) {
      lines.push(
        'STALE means the evidence beneath the interpretation has been corrected or',
        'superseded since it was made. Re-run to interpret what is true now.',
        '',
      );
    }

    if (options.showRuns) {
      lines.push('Runs, newest first:', '');
      const runs = store.runsFor(unit.id);
      for (const [index, run] of runs.entries()) {
        lines.push(
          `  ${run.id}  ${run.enrichmentType}  ${run.status}`,
          `    prompt   ${run.templateId} (${run.promptHash.slice(0, 12)})`,
          `    asked    ${run.model}`,
          `    answered ${run.resolvedModel ?? '(not recorded)'}`,
          `    evidence ${run.inputHash.slice(0, 12)} over ${run.inputIds.length} record(s)`,
          `    cost     ${run.inputTokens} in, ${run.outputTokens} out`,
        );
        const older = runs[index + 1];
        if (older !== undefined && older.enrichmentType === run.enrichmentType) {
          for (const difference of explainDifference(older, run, true)) {
            lines.push(`    changed  ${difference.explanation}`);
          }
        }
        lines.push('');
      }
    }

    lines.push(
      'Every statement above is an interpretation, not a fact. None of them supports a',
      'claim, and none will unless you confirm it. Accepting or rejecting one writes a',
      'new record rather than editing this one, so what the model first said stays',
      'answerable.',
      '',
    );

    return ok(lines.join('\n'));
  });
}

// ── Generation and review ─────────────────────────────────────────────────

/**
 * Render an evidence assessment the way every surface should render it.
 *
 * The grade is one word and a bullet resting on one commit deserves more than
 * one word, so the signals carry the nuance. Strengths and limits are shown
 * together and in that order: a reader who sees only strengths has been sold
 * something.
 */
