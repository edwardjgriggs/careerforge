import { toInstant, type EvidenceDraft, type Gap, type Platform } from '@careerforge/domain';

import type { EvidenceStore } from './evidence-store.js';
import type { ProvenanceStore } from './provenance-store.js';
import type { Db } from './migrations/index.js';

/**
 * The interview: turning a question into evidence.
 *
 * This is where the person becomes a source. An answer is `user_confirmed`
 * evidence — the only class carrying a human assertion, and the only thing
 * that can support a `role` claim (ADR-0007).
 *
 * **No model is involved and none can be.** Gaps are raised by rule from a
 * failed support predicate, the questions are composed from templates, and the
 * answer is stored verbatim. That independence is easy to lose later, so it is
 * worth stating plainly: the interview works with no API key, no network, and
 * no provider configured, and any change that makes a question depend on a
 * model has broken the promise that AI is never required (ADR-0005).
 *
 * It is deliberately *not* a `CollectorPort`. See ADR-0021.
 */

export const INTERVIEW_COLLECTOR_ID = 'interview';
export const INTERVIEW_VERSION = '1.0.0';

export interface AnswerResult {
  readonly evidenceId: string;
  readonly gapId: string;
  /** True when this answer corrected an earlier one for the same question. */
  readonly superseded: boolean;
}

export class InterviewEngine {
  constructor(
    private readonly db: Db,
    private readonly evidence: EvidenceStore,
    private readonly provenance: ProvenanceStore,
    private readonly platform: Platform,
  ) {}

  /** Questions worth putting to the user, newest work first. */
  pending(workUnitId?: string): readonly Gap[] {
    return this.provenance.openGaps(workUnitId);
  }

  /**
   * Answer a question.
   *
   * One transaction: the evidence, the gap transition, and the `answers` edge
   * either all exist or none do. A half-answered question would be worse than
   * an unanswered one, because the user would have been asked and the system
   * would ask again.
   */
  answer(gapId: string, answer: string): AnswerResult {
    const text = answer.trim();
    if (text === '') throw new Error('An answer cannot be empty. Decline the question instead.');

    const gap = this.provenance.gapById(gapId);
    if (gap === null) throw new Error(`No open question ${gapId}.`);

    const unit = this.db
      .prepare(`SELECT title, project_key, stream, occurred_at FROM work_units WHERE id = ?`)
      .get(gap.workUnitId) as
      | { title: string; project_key: string | null; stream: string | null; occurred_at: string }
      | undefined;
    if (unit === undefined)
      throw new Error(`Work unit ${gap.workUnitId} is no longer in the store.`);

    const draft: EvidenceDraft = {
      collectorId: INTERVIEW_COLLECTOR_ID,
      // Keyed on the question, not on the answer. Answering the same question
      // twice is a correction of one fact, not a second fact — so it
      // supersedes, exactly as a re-collected artifact does.
      sourceUri: `interview://${gap.workUnitId}/${gap.gapType}`,
      kind: 'interview.answer',
      // The whole point. A person said this, so it can support a role claim
      // and nothing a model produces ever will.
      evidenceClass: 'user_confirmed',
      // The user typed it about their own work; it is as sensitive as the work.
      sensitivity: 'confidential',
      // Placed at the work it describes, not at the moment of typing. A résumé
      // orders by when work happened.
      occurredAt: toInstant(unit.occurred_at),
      occurredEnd: null,
      context: { projectKey: unit.project_key, workspace: null, stream: unit.stream },
      title: gap.question,
      summary: null,
      excerpt: text,
      payloadRef: null,
      attributes: {
        gapType: gap.gapType,
        answeredAt: toInstant(new Date(this.platform.clock()).toISOString()),
        workUnitTitle: unit.title,
      },
      groupingHint: null,
      collectorVersion: INTERVIEW_VERSION,
      sourceFormatVersion: null,
    };

    return this.db.transaction(() => {
      const emitted = this.evidence.emit(draft);
      this.provenance.markAnsweredBy(gapId, emitted.evidence.id);
      return {
        evidenceId: emitted.evidence.id,
        gapId,
        superseded: emitted.superseded !== null,
      };
    })();
  }

  /** The user chose not to answer. The question is never raised again. */
  decline(gapId: string): string {
    return this.provenance.declineGap(gapId);
  }

  /**
   * Answers already on record for a work unit.
   *
   * Reusable across every future asset: an answer given once about leading a
   * project supports every claim about that project forever. This is the
   * mechanism by which the system gets better the more it is used, rather than
   * asking the same things again each time an asset is generated.
   */
  answersFor(workUnitId: string): readonly { gapType: string; answer: string }[] {
    const rows = this.db
      .prepare(
        `SELECT e.source_uri, c.excerpt AS answer
         FROM evidence_current e
         JOIN evidence_content c ON c.evidence_id = e.id
         WHERE e.collector_id = ? AND e.source_uri LIKE ?
         ORDER BY e.id`,
      )
      .all(INTERVIEW_COLLECTOR_ID, `interview://${workUnitId}/%`) as {
      source_uri: string;
      answer: string | null;
    }[];

    return rows
      .filter((row) => row.answer !== null)
      .map((row) => ({
        // The gap type is the last segment of the key the answer was stored
        // under, which is what makes an answer findable by the question it
        // settled rather than only by the row that recorded it.
        gapType: row.source_uri.slice(row.source_uri.lastIndexOf('/') + 1),
        answer: row.answer!,
      }));
  }
}

/**
 * The questions CareerForge asks, by gap type.
 *
 * Templates, not generation. A question composed by a model would make the
 * interview depend on a provider, and the interview is the one path that must
 * work for a user who never enables AI at all.
 */
export const QUESTION_TEMPLATES: Readonly<
  Record<string, (unitTitle: string) => { question: string; rationale: string }>
> = {
  role: (unit) => ({
    question: `What was your role in "${unit}"? Did you lead it, or contribute to it?`,
    rationale:
      'Leadership cannot be inferred from activity, so CareerForge will not claim it unless you say so.',
  }),
  metric: (unit) => ({
    question: `Did "${unit}" produce a measurable result you can quote?`,
    rationale: 'Numbers must come from evidence or from you. CareerForge will not estimate one.',
  }),
  scope: (unit) => ({
    question: `How large was "${unit}" — how many people, systems, or records did it affect?`,
    rationale:
      'Scope claims need a figure you stand behind rather than one inferred from activity.',
  }),
  outcome: (unit) => ({
    question: `What changed as a result of "${unit}"?`,
    rationale: 'The evidence shows the work happening but not what it achieved.',
  }),
  context: (unit) => ({
    question: `What problem was "${unit}" solving, and for whom?`,
    rationale: 'Context is what turns a list of commits into something a reader understands.',
  }),
};
