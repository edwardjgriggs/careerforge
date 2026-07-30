import type { RunFingerprint } from './run.js';

/**
 * Why is this year's answer different from last year's?
 *
 * The question a person actually asks when an enrichment changes, and the one
 * a single opaque "run hash" cannot answer. Five things independently decide
 * an output, so five things are recorded independently and compared
 * independently. What comes back is not "these runs differ" but *which
 * dimension moved* — which is the difference between a diagnosis and a shrug.
 *
 * ── The sixth answer, and the uncomfortable one ──────────────────────────
 *
 * If every dimension is identical and the outputs still differ, the cause is
 * the model itself. Saying so is the honest answer and the reason this
 * function reports `model_nondeterminism` rather than quietly returning an
 * empty list. A user comparing two runs and being told "nothing changed" while
 * looking at two different answers would rightly stop trusting the record.
 *
 * ── The provider moving underneath you ───────────────────────────────────
 *
 * `model` is what was asked for; `resolvedModel` is what the provider says
 * actually answered. An alias like `gpt-5` silently becoming a newer snapshot
 * is invisible in the first and obvious in the second, and it is one of the
 * most common real causes of a changed result. It gets its own dimension.
 */

export const DIFFERENCE_DIMENSIONS = [
  /** The evidence changed — corrected, superseded, added, or removed. */
  'evidence',
  /** A different prompt template version ran. */
  'prompt',
  /** A different provider answered. */
  'provider',
  /** A different model was asked for. */
  'model',
  /** The same model name resolved to a different build. */
  'model_build',
  /** Temperature, token ceiling, or seed changed. */
  'parameters',
  /** Everything matched and the answer still differs. */
  'model_nondeterminism',
] as const;

export type DifferenceDimension = (typeof DIFFERENCE_DIMENSIONS)[number];

export interface RunDifference {
  readonly dimension: DifferenceDimension;
  readonly from: string;
  readonly to: string;
  /** One sentence a person can read without knowing what a hash is. */
  readonly explanation: string;
}

/** What a run recorded, as far as attribution is concerned. */
export interface ComparableRun extends RunFingerprint {
  /** What the provider said actually answered. Null for runs before M9. */
  readonly resolvedModel: string | null;
}

const short = (hash: string): string => hash.slice(0, 12);

/**
 * Attribute the difference between two runs.
 *
 * `outputsDiffer` is supplied by the caller rather than computed here: the
 * comparison belongs to whoever holds the enrichment values, and passing it in
 * keeps this function pure and total. When it is false the dimensions are
 * still reported — knowing that the prompt changed and the answer did not is
 * a useful thing to learn about a prompt.
 */
export function explainDifference(
  previous: ComparableRun,
  current: ComparableRun,
  outputsDiffer: boolean,
): readonly RunDifference[] {
  const differences: RunDifference[] = [];

  if (previous.inputHash !== current.inputHash) {
    const added = current.inputIds.filter((id) => !previous.inputIds.includes(id)).length;
    const removed = previous.inputIds.filter((id) => !current.inputIds.includes(id)).length;
    // Same ids, different hash, means the content beneath them moved — a
    // correction or a supersede. Worth distinguishing: "you corrected
    // something" and "you collected more" are different explanations.
    const detail =
      added === 0 && removed === 0
        ? 'the same records, with corrected or superseded content'
        : `${added} record(s) added, ${removed} removed`;
    differences.push({
      dimension: 'evidence',
      from: short(previous.inputHash),
      to: short(current.inputHash),
      explanation: `The evidence changed: ${detail}.`,
    });
  }

  if (previous.templateId !== current.templateId || previous.promptHash !== current.promptHash) {
    differences.push({
      dimension: 'prompt',
      from: previous.templateId,
      to: current.templateId,
      explanation:
        previous.templateId === current.templateId
          ? // Should be impossible: templates are frozen by lockfile. If it
            // happens, the lock was bypassed and the record is the only place
            // that would show it.
            `The prompt text changed without the version changing (${short(previous.promptHash)} to ${short(current.promptHash)}). A published template was edited in place.`
          : `A different prompt version ran: ${previous.templateId} then ${current.templateId}.`,
    });
  }

  if (previous.providerId !== current.providerId) {
    differences.push({
      dimension: 'provider',
      from: previous.providerId,
      to: current.providerId,
      explanation: `A different provider answered: ${previous.providerId} then ${current.providerId}.`,
    });
  }

  if (previous.model !== current.model) {
    differences.push({
      dimension: 'model',
      from: previous.model,
      to: current.model,
      explanation: `A different model was asked for: ${previous.model} then ${current.model}.`,
    });
  } else if (
    previous.resolvedModel !== null &&
    current.resolvedModel !== null &&
    previous.resolvedModel !== current.resolvedModel
  ) {
    differences.push({
      dimension: 'model_build',
      from: previous.resolvedModel,
      to: current.resolvedModel,
      explanation: `You asked for ${current.model} both times, and the provider answered with ${previous.resolvedModel} then ${current.resolvedModel}. The model was upgraded underneath you.`,
    });
  }

  if (previous.paramsHash !== current.paramsHash) {
    differences.push({
      dimension: 'parameters',
      from: short(previous.paramsHash),
      to: short(current.paramsHash),
      explanation: 'The sampling parameters changed — temperature, token ceiling, or seed.',
    });
  }

  if (differences.length === 0 && outputsDiffer) {
    differences.push({
      dimension: 'model_nondeterminism',
      from: previous.model,
      to: current.model,
      explanation:
        'Nothing recorded changed, and the answer did too. The difference came from the model itself, which is not reproducible even at temperature zero.',
    });
  }

  return differences;
}

/** Whether two runs would produce the same answer, ignoring the model's whims. */
export function isReproducible(previous: ComparableRun, current: ComparableRun): boolean {
  return explainDifference(previous, current, false).length === 0;
}
