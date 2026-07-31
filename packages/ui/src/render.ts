import {
  describeSignal,
  signalPolarity,
  summariseAssessment,
  type EvidenceAssessment,
  type Improvement,
} from '@careerforge/domain';

import {
  compareGrounds,
  CLASS_LABELS,
  GRADE_COPY,
  type AssetView,
  type ClaimView,
  type ExplorerView,
  type GroundView,
  type QuestionView,
} from './view-model.js';

/**
 * The Explorer, as HTML.
 *
 * Pure functions from a view model to a string. No framework, no bundler, no
 * DOM — which means every one of these is unit-testable with an equality
 * assertion, and "does a claim render as unsupported when it is unsupported?"
 * is a normal test rather than a browser harness.
 *
 * ── What this screen is for ──────────────────────────────────────────────
 *
 * Two questions, and everything on the page serves one of them:
 *
 *   Why does CareerForge believe this?
 *   What evidence would make it stronger?
 *
 * The second is the one that makes this more than a viewer. A screen that
 * shows only the current state tells a person their bullet is weak and leaves
 * them there; this one tells them which single thing to do about it and what
 * it would be worth.
 */

/** Everything interpolated goes through here. The store holds arbitrary text. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const attr = (value: string): string => escapeHtml(value);

/**
 * The statement, with each claim marked.
 *
 * Rebuilt from spans rather than by search-and-replace, because spans are
 * exact by construction (ADR-0025) and matching text would find the wrong
 * occurrence of a repeated phrase. Any characters between claims — the commas
 * and the "and" the composer inserted — are rendered as plain text, which is
 * what they are: joining, not assertion.
 */
export function renderStatement(asset: AssetView): string {
  const ordered = [...asset.claims].sort((a, b) => a.span[0] - b.span[0]);
  let cursor = 0;
  let html = '';

  for (const claim of ordered) {
    const [start, end] = claim.span;
    if (start > cursor) html += escapeHtml(asset.text.slice(cursor, start));
    html +=
      `<span class="claim" data-claim="${attr(claim.id)}" role="button" tabindex="0" ` +
      `aria-label="${attr(`${claim.claimType} claim: ${claim.text}`)}">` +
      `${escapeHtml(asset.text.slice(start, end))}` +
      `<sup class="claim-type">${escapeHtml(claim.claimType)}</sup></span>`;
    cursor = end;
  }

  if (cursor < asset.text.length) html += escapeHtml(asset.text.slice(cursor));
  return html;
}

function renderGround(ground: GroundView): string {
  const sensitivity =
    ground.sensitivity === null
      ? ''
      : `<span class="sens sens-${attr(ground.sensitivity)}">${escapeHtml(ground.sensitivity)}</span>`;
  return `
    <li class="ground ground-${attr(ground.provenanceClass)}">
      <div class="ground-class">${escapeHtml(CLASS_LABELS[ground.provenanceClass])}</div>
      <div class="ground-label">${escapeHtml(ground.label)}${sensitivity}</div>
      ${ground.detail === null ? '' : `<div class="ground-detail">${escapeHtml(ground.detail)}</div>`}
    </li>`;
}

/**
 * Why CareerForge believes one claim.
 *
 * Grounds and interpretation are separate sections with separate headings and
 * they never merge (ADR-0020). Presenting a model's reading in the same list
 * as a commit is how every AI résumé tool on the market launders a guess into
 * a citation, and the visual separation is the part a user actually perceives.
 */
export function renderClaimProof(claim: ClaimView): string {
  const grounds = [...claim.grounds].sort(compareGrounds);
  const interpretation = [...claim.interpretation].sort(compareGrounds);

  const withheld =
    claim.withheld === 0
      ? ''
      : `<p class="withheld">${claim.withheld} record(s) behind this have been hidden or withdrawn. They are counted, not shown.</p>`;

  return `
    <section class="proof" data-proof="${attr(claim.id)}">
      <h3>Why CareerForge believes this</h3>
      <!-- Every claim's proof renders; selecting one brings it forward rather
           than revealing it, so the whole warrant is readable at a glance. -->
      <p class="proof-claim"><em>${escapeHtml(claim.text)}</em> <span class="pill">${escapeHtml(claim.claimType)}</span></p>
      ${
        grounds.length === 0
          ? '<p class="empty">Nothing in your store stands behind this claim.</p>'
          : `<ul class="grounds">${grounds.map(renderGround).join('')}</ul>`
      }
      ${withheld}
      ${
        interpretation.length === 0
          ? ''
          : `<h4>What shaped the wording</h4>
             <p class="caveat">An interpretation explains how this came to be phrased. It is never a reason to believe it.</p>
             <ul class="grounds interpretation">${interpretation.map(renderGround).join('')}</ul>`
      }
    </section>`;
}

/** The grade and its signals, strengths before limits. */
export function renderAssessment(
  assessment: EvidenceAssessment,
  driftedFrom: EvidenceAssessment | null,
): string {
  const copy = GRADE_COPY[assessment.grade];
  const strengths = assessment.signals.filter((s) => signalPolarity(s) === 'strength');
  const limits = assessment.signals.filter((s) => signalPolarity(s) === 'limit');

  const drift =
    driftedFrom === null
      ? ''
      : `<p class="drift">The evidence has moved since this was written — it was
          <strong>${escapeHtml(summariseAssessment(driftedFrom))}</strong> then and is
          <strong>${escapeHtml(summariseAssessment(assessment))}</strong> now. Regenerate before relying on it.</p>`;

  const list = (signals: readonly string[], kind: string) =>
    signals.length === 0
      ? ''
      : `<ul class="signals ${kind}">${signals
          .map((s) => `<li>${escapeHtml(describeSignal(s as never))}</li>`)
          .join('')}</ul>`;

  return `
    <section class="assessment grade-${attr(assessment.grade)}">
      <div class="grade">
        <span class="grade-name">${escapeHtml(copy.title)}</span>
        <span class="grade-scale">${escapeHtml(summariseAssessment(assessment))}</span>
      </div>
      <p class="grade-meaning">${escapeHtml(copy.meaning)}</p>
      ${drift}
      ${list(strengths, 'strength')}
      ${list(limits, 'limit')}
    </section>`;
}

/**
 * What would make this stronger.
 *
 * The half of the screen that makes the Explorer more than a viewer. Each item
 * leads with what it would be worth — `Observed → Corroborated`, or the claim
 * types it would unlock — because a list of things that are missing, with no
 * indication of what any of them is worth, is a to-do list rather than an
 * explanation.
 */
export function renderImprovements(improvements: readonly Improvement[]): string {
  if (improvements.length === 0) {
    return `
      <section class="improve">
        <h3>What would make this stronger</h3>
        <p class="empty">Nothing obvious. This statement is as well evidenced as your store can currently make it.</p>
      </section>`;
  }

  const items = improvements
    .map((improvement) => {
      const effect = improvement.effect;
      const badge = effect.raisesGrade
        ? `<span class="effect raises">${escapeHtml(GRADE_COPY[effect.gradeNow].title)} → ${escapeHtml(GRADE_COPY[effect.gradeAfter].title)}</span>`
        : effect.unlocks.length > 0
          ? `<span class="effect unlocks">would let this claim ${escapeHtml(effect.unlocks.join(' and '))}</span>`
          : `<span class="effect neutral">no change to the grade</span>`;

      const action = improvement.action;
      const control =
        action.kind === 'answer'
          ? `<form class="answer" data-gap="${attr(action.gapId)}">
               <label>${escapeHtml(action.question)}</label>
               <textarea name="answer" rows="2" placeholder="In your own words…"></textarea>
               <button type="submit">Record this as evidence</button>
             </form>`
          : action.kind === 'ask'
            ? `<p class="hint">${escapeHtml(action.question)}</p>
               <code>${escapeHtml(action.command)}</code>`
            : action.kind === 'collect'
              ? `<p class="hint">${escapeHtml(action.detail)}</p>
                 <code>${escapeHtml(action.command)}</code>`
              : `<p class="hint unavailable">${escapeHtml(action.detail)}</p>`;

      return `
        <li class="improvement ${attr(action.kind)}">
          <div class="improvement-head">
            <span class="improvement-summary">${escapeHtml(improvement.summary)}</span>
            ${badge}
          </div>
          <p class="improvement-why">${escapeHtml(improvement.why)}</p>
          ${control}
        </li>`;
    })
    .join('');

  return `
    <section class="improve">
      <h3>What would make this stronger</h3>
      <ol class="improvements">${items}</ol>
    </section>`;
}

/** One asset: the statement, its grade, its proof, and its path forward. */
export function renderAsset(asset: AssetView): string {
  return `
    <article class="asset" data-asset="${attr(asset.id)}">
      <header>
        <p class="unit">${escapeHtml(asset.workUnitTitle)}</p>
        <p class="statement">${renderStatement(asset)}</p>
        <p class="review review-${attr(asset.reviewState)}">${escapeHtml(reviewCopy(asset.reviewState))}</p>
      </header>
      ${renderAssessment(asset.assessment, asset.driftedFrom)}
      <div class="two-questions">
        <div class="why">${asset.claims.map(renderClaimProof).join('')}</div>
        <div class="stronger">${renderImprovements(asset.improvements)}</div>
      </div>
    </article>`;
}

function reviewCopy(reviewState: string): string {
  switch (reviewState) {
    case 'draft':
      return 'Draft — nobody has read this yet, and it cannot be exported.';
    case 'reviewed':
      return 'You approved this. It may be exported.';
    case 'rejected':
      return 'You rejected this. It will not be exported.';
    default:
      return reviewState;
  }
}

/**
 * The screen a brand new store shows.
 *
 * Not cosmetic. `Vision.md` §4 makes backfill the acquisition model, so the
 * first thing a new user sees is a nearly empty database — and the difference
 * between *visibly empty* and *visibly full of answerable questions* is where
 * cold start is won or lost. An empty state that says "no data" has already
 * lost; this one says what to run and what will happen.
 */
export function renderEmptyState(view: ExplorerView): string {
  if (view.totals.evidence === 0) {
    return `
      <section class="empty-state">
        <h2>Nothing collected yet</h2>
        <p>CareerForge reads work you have already done. It does not ask you to write anything down.</p>
        <ol class="steps">
          <li><code>careerforge collect --backfill</code><span>Read your Git history and your AI coding sessions.</span></li>
          <li><code>careerforge group</code><span>Turn that into units of work you would recognise as accomplishments.</span></li>
          <li><code>careerforge generate resume-bullet --unit &lt;id&gt;</code><span>Write something, and check every claim in it.</span></li>
        </ol>
        <p class="note">Collection, grouping, search, and the interview all work with no API key and no network.</p>
      </section>`;
  }

  if (view.totals.assets === 0) {
    return `
      <section class="empty-state">
        <h2>${view.totals.units} unit(s) of work, nothing written yet</h2>
        <p>Your evidence is collected and grouped. Nothing has been turned into a statement, so there is nothing to check.</p>
        <ol class="steps">
          <li><code>careerforge generate resume-bullet --unit &lt;id&gt;</code><span>Pick a unit below and write about it.</span></li>
        </ol>
        ${
          view.totals.questions === 0
            ? ''
            : `<p class="note">${view.totals.questions} question(s) are already waiting — answering one before you generate produces a stronger statement.</p>`
        }
      </section>`;
  }

  return '';
}

/** Open questions across the whole store, for the case where nothing is selected. */
export function renderQuestions(questions: readonly QuestionView[]): string {
  if (questions.length === 0) {
    return `<p class="empty">No open questions. Everything CareerForge wanted to ask, you have answered.</p>`;
  }
  return `<ul class="questions">${questions
    .map(
      (question) => `
        <li class="question">
          <div class="question-unit">${escapeHtml(question.workUnitTitle)}</div>
          <form class="answer" data-gap="${attr(question.id)}">
            <label>${escapeHtml(question.question)}</label>
            <p class="why">${escapeHtml(question.rationale)}</p>
            <textarea name="answer" rows="2" placeholder="In your own words…"></textarea>
            <button type="submit">Record this as evidence</button>
          </form>
        </li>`,
    )
    .join('')}</ul>`;
}
