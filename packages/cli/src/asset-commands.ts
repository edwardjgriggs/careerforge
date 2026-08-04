import { existsSync } from 'node:fs';

import {
  explainRefusal,
  toInstant,
  describeSignal,
  signalPolarity,
  summariseAssessment,
  type ClaimType,
  type EvidenceAssessment,
} from '@careerforge/domain';
import { executeRun } from '@careerforge/enrich';
import {
  generateBullet,
  isPublishable,
  type CandidateRecord,
  type DroppedClaim,
  type ProposedClaim,
} from '@careerforge/generate';
import {
  AssetStore,
  closeDatabase,
  ConsentStore,
  EnrichmentStore,
  ProvenanceStore,
  WorkUnitStore,
  nodePlatform,
  openDatabase,
  sha256,
} from '@careerforge/store';

import {
  DEFAULT_MODELS,
  renderRefusals,
  resolveProvider,
  resolveProviderPort,
  unitInputs,
  type UnitRecord,
} from './ai-commands.js';
import { failure, ok, withStore, type CommandResult } from './command-runtime.js';
import { resolvePaths } from './paths.js';

function renderAssessment(assessment: EvidenceAssessment, indent = ''): string[] {
  const strengths = assessment.signals.filter((s) => signalPolarity(s) === 'strength');
  const limits = assessment.signals.filter((s) => signalPolarity(s) === 'limit');

  const lines = [`${indent}Evidence: ${summariseAssessment(assessment)}`, ''];
  for (const signal of strengths) lines.push(`${indent}  + ${describeSignal(signal)}`);
  for (const signal of limits) lines.push(`${indent}  - ${describeSignal(signal)}`);

  if (assessment.droppedClaimTypes.length > 0) {
    lines.push(
      '',
      `${indent}  Left out for want of evidence: ${assessment.droppedClaimTypes.join(', ')}.`,
    );
  }
  return lines;
}

export interface GenerateOptions {
  readonly workUnitId: string;
  readonly providerId: string;
  readonly model?: string;
  readonly dryRun: boolean;
  readonly force: boolean;
}

/**
 * Turn a work unit into a résumé bullet, with the check in the middle.
 *
 * The model returns typed, cited assertions — never prose. Each one faces the
 * support predicate; whatever fails becomes a question rather than a softer
 * sentence; and the bullet is composed afterwards from what survived, so a
 * failed claim's words are never placed at all.
 *
 * The output leads with the sentence and then says what stands behind it,
 * because the second part is the reason to trust the first.
 */
export async function generate(
  env: NodeJS.ProcessEnv,
  options: GenerateOptions,
): Promise<CommandResult> {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  const { db } = openDatabase({ path: paths.database });
  try {
    const units = new WorkUnitStore(db, nodePlatform);
    const consentStore = new ConsentStore(db, nodePlatform);
    const enrichmentStore = new EnrichmentStore(db, nodePlatform);
    const provenance = new ProvenanceStore(db, nodePlatform);
    const assetStore = new AssetStore(db, nodePlatform);

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
        'That work unit has no evidence to write about.',
        'Run `careerforge collect` and `careerforge group` first.',
      );
    }

    const provider = resolveProvider(options.providerId);
    const model = options.model ?? DEFAULT_MODELS[provider.id] ?? 'gpt-5';
    const startedAt = toInstant(new Date().toISOString());
    const { port, recorded } = resolveProviderPort(env, provider.id);

    const outcome = await executeRun(
      {
        target: { kind: 'work_unit', id: unit.id },
        enrichmentType: 'resume_bullet',
        provider,
        model,
        inputs,
      },
      {
        consent: (projectKey, providerId) => consentStore.lookup(projectKey, providerId),
        digest: sha256,
        provider: port,
        // Deliberately no cache lookup. A bullet's worth depends on evidence
        // that has moved, questions that have been answered, and records that
        // have been withdrawn — none of which change the run fingerprint. A
        // cached proposal would be re-checked against today's evidence, which
        // sounds fine until the proposal itself is a year out of date.
        dryRun: options.dryRun,
        force: options.force,
      },
    );

    const header = [
      `Work unit: ${unit.title}`,
      `Reading:   ${inputs.length} record(s)`,
      ...(recorded ? ['', 'RECORDED — answering from a cassette, not from a live provider.'] : []),
      '',
    ];

    if (outcome.kind === 'unsupported') {
      return failure(outcome.refusal.reason, explainRefusal(outcome.refusal).next);
    }

    if (outcome.kind === 'refused') {
      consentStore.recordDecision(outcome.decision);
      return {
        stdout: [
          ...header,
          'REFUSED — nothing was sent and nothing was written.',
          '',
          ...renderRefusals(outcome.refusals),
        ].join('\n'),
        stderr: '',
        exitCode: 1,
      };
    }

    if (outcome.kind === 'dry_run') {
      return ok(
        [
          ...header,
          'DRY RUN — nothing was sent.',
          '',
          `  prompt   ${outcome.fingerprint.templateId}`,
          '',
          '  ── Instructions ──',
          outcome.instructions.replace(/^/gm, '  '),
          '',
          '  ── Payload ──',
          outcome.payload.replace(/^/gm, '  '),
          '',
        ].join('\n'),
      );
    }

    if (outcome.kind === 'cached') {
      return failure('Unexpected cache hit.', 'Generation does not cache. This is a bug.');
    }

    const decisionId =
      provider.locality === 'remote' ? consentStore.recordDecision(outcome.decision) : null;

    const proposals: ProposedClaim[] = outcome.validated.items.map((item) => ({
      text: String((item.value as Record<string, unknown>)['text'] ?? ''),
      claimType: (item.value as Record<string, unknown>)['claimType'] as ClaimType,
      evidence: item.evidence,
    }));

    const runId = enrichmentStore.recordRun({
      fingerprint: outcome.fingerprint,
      target: { kind: 'work_unit', id: unit.id },
      enrichmentType: 'resume_bullet',
      resolvedModel: outcome.response.model,
      policyDecisionId: decisionId,
      redactionProfile: outcome.decision.redaction.profile,
      status: proposals.length > 0 ? 'completed' : 'unusable',
      usage: outcome.usage,
      // The run records that a proposal was made and what it cost. The
      // proposals themselves become claims or questions; storing them as
      // enrichments too would put an unchecked assertion in the store
      // alongside the checked ones.
      validated: {
        items: [],
        rejections: outcome.validated.rejections,
        unknownCitations: outcome.validated.unknownCitations,
      },
      startedAt,
    });

    const bullet = generateBullet(proposals, {
      workUnitId: unit.id,
      available: inputs.map(toCandidateRecord),
      openQuestionCount: provenance.openGaps(unit.id).length,
    });

    const lines = [...header];

    if (!isPublishable(bullet)) {
      const gapIds = assetStore.raiseQuestionsOnly(unit.id, bullet);
      return {
        stdout: [
          ...lines,
          'Nothing in the evidence supported any part of this. No bullet was written.',
          '',
          ...renderDropped(bullet.dropped),
          gapIds.length === 0
            ? 'Those questions were already open.'
            : `${gapIds.length} question(s) recorded. Answer them with \`careerforge interview --unit ${unit.id}\`.`,
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }

    const recordedAsset = assetStore.record({
      assetType: 'resume_bullet',
      workUnitId: unit.id,
      runId,
      bullet,
    });

    lines.push(bullet.text, '');

    lines.push('Every part of that, and what stands behind it:', '');
    for (const [index, claim] of bullet.claims.entries()) {
      lines.push(
        `  ${claim.claimType.padEnd(8)} ${claim.text}`,
        `           cites ${claim.evidence.join(', ')}`,
        `           claim ${recordedAsset.claimIds[index] ?? '(unrecorded)'}`,
        '',
      );
    }

    if (bullet.dropped.length > 0) {
      lines.push(...renderDropped(bullet.dropped));
    }

    lines.push(...renderAssessment(bullet.assessment), '');

    lines.push(
      `Recorded as ${recordedAsset.id}, in draft.`,
      '',
      'Nothing leaves CareerForge until you have read it:',
      `  careerforge review ${recordedAsset.id} --accept`,
      '',
    );

    return ok(lines.join('\n'));
  } finally {
    closeDatabase(db);
  }
}

/**
 * What was left out, and the question it raises.
 *
 * Shown every time, prominently. A generator that quietly drops what it cannot
 * support looks identical to one that had nothing to drop, and the difference
 * is the whole product.
 */
function renderDropped(dropped: readonly DroppedClaim[]): string[] {
  const lines = [
    `Left out — the evidence does not carry ${dropped.length === 1 ? 'it' : 'them'}:`,
    '',
  ];
  for (const claim of dropped) {
    lines.push(
      `  ${claim.claimType.padEnd(8)} "${claim.text}"`,
      `           ${claim.reason}`,
      `           -> ${claim.question}`,
      '',
    );
  }
  return lines;
}

const toCandidateRecord = (input: UnitRecord): CandidateRecord => ({
  id: input.id,
  collectorId: input.collectorId,
  kind: input.kind,
  evidenceClass: input.evidenceClass,
  attributes: input.attributes,
  text: input.text,
  suppressed: false,
});

export interface ReviewOptions {
  readonly assetId: string;
  readonly decision?: 'accept' | 'reject';
  readonly edit?: string;
}

/**
 * Read an asset and decide about it.
 *
 * With no decision this is a reading surface: the words, every claim and what
 * cites it, what was left out, and how strong the evidence is *now* rather
 * than when it was written. A person cannot approve what they have not been
 * shown, and the gate is worth nothing if approving is easier than reading.
 */
export function review(env: NodeJS.ProcessEnv, options: ReviewOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const assetStore = new AssetStore(db, nodePlatform);
    const provenance = new ProvenanceStore(db, nodePlatform);

    const assessed = assetStore.assess(options.assetId);
    if (assessed === null) {
      return failure(`No asset ${options.assetId}.`, 'Run `careerforge units` to find one.');
    }

    if (options.edit !== undefined) {
      const result = assetStore.applyEdit(assessed.id, options.edit);
      if (result.kind === 'factual') {
        return failure(
          'That edit changes what is being asserted, not how it is worded.',
          'CareerForge records wording changes as style examples. A change to the claims has to be evidenced — answer the relevant question with `careerforge interview` and regenerate.',
        );
      }
      return ok(
        [
          'Recorded your wording, and kept it as an example for future drafts.',
          '',
          `  ${options.edit}`,
          '',
          'The claims are unchanged, so the evidence behind them still holds.',
          '',
        ].join('\n'),
      );
    }

    if (options.decision !== undefined) {
      const newId = assetStore.review(
        assessed.id,
        options.decision === 'accept' ? 'reviewed' : 'rejected',
      );
      return ok(
        options.decision === 'accept'
          ? [
              'Accepted. This may now be exported.',
              '',
              `  ${assessed.text}`,
              '',
              `Recorded as ${newId}. The draft you read stays in the store beside it.`,
              '',
            ].join('\n')
          : [
              'Rejected. It will not be exported.',
              '',
              `Recorded as ${newId}. Nothing was deleted — what was generated stays queryable`,
              'beside your decision about it.',
              '',
            ].join('\n'),
      );
    }

    // Through the revision chain: a reviewed asset's claims live on the row
    // they were first recorded against.
    const claims = assetStore.claimsFor(assessed.id);
    const lines = [
      `Asset ${assessed.id} · ${assessed.assetType} · ${assessed.reviewState}`,
      '',
      assessed.text,
      '',
      'Every part of that, and what stands behind it:',
      '',
    ];

    for (const claim of claims) {
      const explanation = provenance.explain(claim.id);
      lines.push(
        `  ${claim.claimType.padEnd(8)} ${claim.text}`,
        `           ${explanation?.grounds.length ?? 0} grounding record(s), ${explanation?.interpretation.length ?? 0} interpretation(s)`,
        `           careerforge explain ${claim.id}`,
        '',
      );
    }

    lines.push(...renderAssessment(assessed.assessmentNow), '');

    if (assessed.assessmentDrifted) {
      // The reason the assessment is recomputed rather than only stored. A
      // judgement that cannot disagree with reality is not a judgement.
      lines.push(
        'The evidence has moved since this was written.',
        `  when written: ${summariseAssessment(assessed.assessmentAtGeneration)}`,
        `  now:          ${summariseAssessment(assessed.assessmentNow)}`,
        '',
        'Regenerate before relying on it.',
        '',
      );
    }

    if (assessed.reviewState === 'draft') {
      lines.push(
        'Nothing leaves CareerForge until you decide:',
        `  careerforge review ${assessed.id} --accept`,
        `  careerforge review ${assessed.id} --reject`,
        `  careerforge review ${assessed.id} --edit "your wording"`,
        '',
      );
    }

    return ok(lines.join('\n'));
  });
}

export interface AssetsOptions {
  readonly workUnitId?: string;
  readonly markdown: boolean;
  /** Emit one JSON object per line on stdout, for scripts. */
  readonly json: boolean;
}

/**
 * List assets, or export the reviewed ones as Markdown.
 *
 * The export gate lives in the store's `exportable()`, not here. A command
 * that filtered by review state itself would be a gate one caller wide, and
 * the next caller would forget.
 */
export function assets(env: NodeJS.ProcessEnv, options: AssetsOptions): CommandResult {
  const paths = resolvePaths(env);
  if (!existsSync(paths.database)) {
    return failure('No store yet.', 'Run `careerforge init` first.');
  }

  return withStore(paths, ({ db }) => {
    const assetStore = new AssetStore(db, nodePlatform);
    const units = new WorkUnitStore(db, nodePlatform);

    if (options.json) {
      // --json and --markdown are different output contracts (machine vs
      // human export); the CLI layer refuses both at once.
      const all =
        options.workUnitId === undefined
          ? units.currentUnits().flatMap((unit) => assetStore.forWorkUnit(unit.id))
          : assetStore.forWorkUnit(options.workUnitId);
      const lines = all.map((asset) =>
        JSON.stringify({
          id: asset.id,
          assetType: asset.assetType,
          workUnitId: asset.workUnitId,
          text: asset.text,
          reviewState: asset.reviewState,
          grade: asset.grade,
          recordedAt: asset.recordedAt,
          editedBy: asset.editedBy,
          supersedes: asset.supersedes,
        }),
      );
      return ok(lines.length === 0 ? '' : `${lines.join('\n')}\n`);
    }

    if (options.markdown) {
      const exportable = assetStore.exportable(options.workUnitId);
      if (exportable.length === 0) {
        return failure(
          'Nothing has been reviewed yet, so there is nothing to export.',
          'Read a draft with `careerforge review <asset-id>` and accept it.',
        );
      }
      const lines = ['# Experience', ''];
      for (const asset of exportable) {
        const assessed = assetStore.assess(asset.id)!;
        lines.push(
          `- ${asset.text}`,
          `  <!-- evidence: ${summariseAssessment(assessed.assessmentNow)} -->`,
        );
      }
      lines.push('');
      return ok(lines.join('\n'));
    }

    const all =
      options.workUnitId === undefined
        ? units.currentUnits().flatMap((unit) => assetStore.forWorkUnit(unit.id))
        : assetStore.forWorkUnit(options.workUnitId);

    if (all.length === 0) {
      return ok(
        [
          'Nothing has been generated yet.',
          '',
          '  careerforge generate resume-bullet --unit <id>',
          '',
        ].join('\n'),
      );
    }

    const lines = ['Generated assets:', ''];
    for (const asset of all) {
      lines.push(
        `  ${asset.reviewState.padEnd(9)} ${asset.grade.padEnd(13)} ${asset.id}`,
        `            ${asset.text}`,
        '',
      );
    }
    lines.push(
      'A draft has not been read by anybody and cannot be exported.',
      'Read one with `careerforge review <asset-id>`.',
      '',
    );
    return ok(lines.join('\n'));
  });
}

// ── Evidence Explorer ─────────────────────────────────────────────────────
