import { escapeHtml, renderAsset, renderEmptyState, renderQuestions } from './render.js';
import type { ExplorerView } from './view-model.js';

/**
 * The page itself: one document, no bundler, no framework.
 *
 * Everything is inlined. Not asceticism — a career store is the most sensitive
 * thing on a person's machine, and a page that fetches a script from a CDN
 * makes a third party a participant in reading it. There is nothing to
 * subresource-integrity if there are no subresources.
 *
 * The layout is two columns and they are the two questions. Left: the
 * statement and its proof. Right: what would make it stronger. A user who
 * reads only the left half has been told why to trust it; a user who reads
 * only the right half has been told what to do next. Neither half is a
 * footnote to the other.
 */

const STYLE = `
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --panel-2: #1d2129;
    --line: #2a2f3a;
    --text: #e6e8ec;
    --dim: #9aa3b2;
    --accent: #7aa2f7;
    --good: #7ec699;
    --warn: #e0af68;
    --bad: #f7768e;
    --stated: #bb9af7;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f8fa; --panel: #ffffff; --panel-2: #f2f4f7; --line: #dde1e7;
      --text: #1a1d23; --dim: #5b6472; --accent: #2f5fd0; --good: #1f7a4d;
      --warn: #9a6b00; --bad: #b3243c; --stated: #6b3fbf;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  code, .statement { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  header.top {
    padding: 18px 28px; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
  }
  header.top h1 { font-size: 16px; margin: 0; letter-spacing: .02em; }
  header.top .totals { color: var(--dim); font-size: 13px; }
  header.top .local { margin-left: auto; color: var(--dim); font-size: 12px; }
  main { padding: 24px 28px 64px; max-width: 1400px; margin: 0 auto; }

  .asset {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; margin-bottom: 28px; overflow: hidden;
  }
  .asset > header { padding: 20px 22px 16px; border-bottom: 1px solid var(--line); }
  .unit { margin: 0 0 10px; color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  .statement { margin: 0 0 12px; font-size: 19px; line-height: 1.6; }
  .review { margin: 0; font-size: 13px; color: var(--dim); }
  .review-reviewed { color: var(--good); }
  .review-rejected { color: var(--bad); }

  .claim {
    border-bottom: 2px solid var(--accent); cursor: pointer;
    padding-bottom: 1px; transition: background .12s;
  }
  .claim:hover, .claim:focus, .claim.active { background: color-mix(in srgb, var(--accent) 22%, transparent); outline: none; }
  .claim-type {
    font-size: 9px; color: var(--dim); margin-left: 2px;
    text-transform: uppercase; letter-spacing: .04em; font-family: ui-sans-serif, sans-serif;
  }

  .assessment { padding: 16px 22px; background: var(--panel-2); border-bottom: 1px solid var(--line); }
  .grade { display: flex; align-items: baseline; gap: 12px; }
  .grade-name { font-size: 15px; font-weight: 650; }
  .grade-corroborated .grade-name { color: var(--good); }
  .grade-confirmed .grade-name { color: var(--accent); }
  .grade-observed .grade-name { color: var(--warn); }
  .grade-asserted .grade-name { color: var(--bad); }
  .grade-scale { color: var(--dim); font-size: 13px; }
  .grade-meaning { margin: 6px 0 10px; color: var(--dim); font-size: 13px; }
  .signals { margin: 0 0 6px; padding-left: 20px; font-size: 13px; }
  .signals.strength li { color: var(--good); }
  .signals.limit li { color: var(--warn); }
  .drift { color: var(--bad); font-size: 13px; margin: 8px 0; }

  .two-questions { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  @media (max-width: 980px) { .two-questions { grid-template-columns: 1fr; } }
  .why { padding: 4px 22px 20px; border-right: 1px solid var(--line); }
  .stronger { padding: 4px 22px 20px; }
  h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--dim); margin: 20px 0 10px; }
  h4 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 16px 0 6px; }

  /* Every claim's proof is visible at once: hiding all but one left most of
     the answer to "why do you believe this" off screen, and a person reading
     their own résumé wants the whole warrant, not a slideshow of it.
     Selecting a claim brings its proof forward rather than revealing it. */
  .proof {
    border: 1px solid transparent; border-radius: 8px;
    padding: 2px 10px 2px; margin-left: -10px; transition: background .12s, border-color .12s;
  }
  .proof.active { border-color: var(--line); background: var(--panel-2); }
  .proof + .proof { margin-top: 6px; }
  .proof h3 { margin-top: 12px; }
  .proof:not(:first-child) h3 { display: none; }
  .proof-claim { margin: 0 0 12px; font-size: 14px; }
  .pill {
    font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
    border: 1px solid var(--line); border-radius: 10px; padding: 1px 7px; color: var(--dim);
  }
  .grounds { list-style: none; margin: 0; padding: 0; }
  .ground { border-left: 3px solid var(--line); padding: 8px 0 8px 12px; margin-bottom: 10px; }
  .ground-observed { border-left-color: var(--accent); }
  .ground-derived { border-left-color: var(--good); }
  .ground-stated { border-left-color: var(--stated); }
  .ground-grouped { border-left-color: var(--dim); }
  .ground-interpreted { border-left-color: var(--warn); border-left-style: dashed; }
  .ground-class { font-size: 11px; color: var(--dim); margin-bottom: 3px; }
  .ground-label { font-size: 14px; }
  .ground-detail { font-size: 12px; color: var(--dim); margin-top: 2px; }
  .interpretation { opacity: .85; }
  .caveat, .withheld { font-size: 12px; color: var(--dim); font-style: italic; margin: 4px 0 8px; }

  .sens {
    font-size: 10px; margin-left: 8px; padding: 1px 6px; border-radius: 9px;
    text-transform: uppercase; letter-spacing: .04em; vertical-align: middle;
  }
  .sens-public { background: color-mix(in srgb, var(--good) 22%, transparent); color: var(--good); }
  .sens-internal { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--accent); }
  .sens-confidential { background: color-mix(in srgb, var(--warn) 22%, transparent); color: var(--warn); }
  .sens-restricted { background: color-mix(in srgb, var(--bad) 22%, transparent); color: var(--bad); }

  .improvements { list-style: none; margin: 0; padding: 0; counter-reset: imp; }
  .improvement {
    border: 1px solid var(--line); border-radius: 8px;
    padding: 12px 14px; margin-bottom: 12px; background: var(--panel-2);
  }
  .improvement.not_available { opacity: .72; }
  .improvement-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .improvement-summary { font-weight: 600; font-size: 14px; }
  .effect { font-size: 11px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
  .effect.raises { background: color-mix(in srgb, var(--good) 24%, transparent); color: var(--good); }
  .effect.unlocks { background: color-mix(in srgb, var(--accent) 24%, transparent); color: var(--accent); }
  .effect.neutral { color: var(--dim); border: 1px solid var(--line); }
  .improvement-why { font-size: 13px; color: var(--dim); margin: 8px 0; }
  .hint { font-size: 13px; color: var(--dim); margin: 6px 0; }
  .hint.unavailable { color: var(--warn); }
  code {
    display: inline-block; background: var(--bg); border: 1px solid var(--line);
    border-radius: 5px; padding: 3px 8px; font-size: 12px; margin-top: 4px;
  }

  form.answer { margin-top: 10px; }
  form.answer label { display: block; font-size: 13px; margin-bottom: 6px; }
  form.answer .why { font-size: 12px; color: var(--dim); margin: 0 0 6px; padding: 0; border: 0; }
  textarea {
    width: 100%; background: var(--bg); color: var(--text);
    border: 1px solid var(--line); border-radius: 6px; padding: 8px; font: inherit; font-size: 13px;
    resize: vertical;
  }
  button {
    margin-top: 8px; background: var(--accent); color: #0b0d11; border: 0;
    border-radius: 6px; padding: 7px 14px; font: inherit; font-size: 13px;
    font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  .recorded { color: var(--good); font-size: 13px; margin-top: 8px; }

  .empty-state { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 28px; }
  .empty-state h2 { margin: 0 0 8px; font-size: 20px; }
  .steps { list-style: none; padding: 0; margin: 18px 0 0; }
  .steps li { margin-bottom: 14px; }
  .steps span { display: block; color: var(--dim); font-size: 13px; margin-top: 4px; }
  .note { color: var(--dim); font-size: 13px; margin-top: 18px; }
  .empty { color: var(--dim); font-size: 13px; }

  .units { list-style: none; padding: 0; }
  .units li {
    border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px;
    margin-bottom: 10px; background: var(--panel); display: flex; gap: 14px; align-items: baseline;
  }
  .units .meta { color: var(--dim); font-size: 12px; margin-left: auto; white-space: nowrap; }
  .questions { list-style: none; padding: 0; }
  .question { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; background: var(--panel); }
  .question-unit { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); margin-bottom: 6px; }
`;

/**
 * The only script on the page.
 *
 * Two behaviours and nothing else: selecting a claim reveals its proof, and
 * submitting an answer posts it and re-renders. Deliberately small — a page
 * about whether you can trust what you are reading should not itself be
 * something you have to trust.
 */
const SCRIPT = `
  function selectClaim(assetEl, claimId) {
    assetEl.querySelectorAll('.claim').forEach(function (el) {
      el.classList.toggle('active', el.dataset.claim === claimId);
    });
    assetEl.querySelectorAll('.proof').forEach(function (el) {
      var match = el.dataset.proof === claimId;
      el.classList.toggle('active', match);
      if (match) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  document.addEventListener('click', function (event) {
    var claim = event.target.closest('.claim');
    if (claim) selectClaim(claim.closest('.asset'), claim.dataset.claim);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var claim = event.target.closest('.claim');
    if (claim) { event.preventDefault(); selectClaim(claim.closest('.asset'), claim.dataset.claim); }
  });

  document.addEventListener('submit', async function (event) {
    var form = event.target.closest('form.answer');
    if (!form) return;
    event.preventDefault();

    var button = form.querySelector('button');
    var text = form.querySelector('textarea').value.trim();
    if (text === '') return;

    button.disabled = true;
    button.textContent = 'Recording…';

    var response = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gapId: form.dataset.gap, answer: text }),
    });

    if (!response.ok) {
      button.disabled = false;
      button.textContent = 'Record this as evidence';
      form.insertAdjacentHTML('beforeend', '<p class="recorded" style="color:var(--bad)">Could not record that.</p>');
      return;
    }

    // Re-read the whole page rather than patching it. The answer changes the
    // grade, the signals, and the ranking of every remaining improvement —
    // patching one panel would leave the rest of the screen quietly stale,
    // which on this screen means quietly wrong.
    window.location.reload();
  });

  // Open the first claim of each asset, so the proof panel is never blank.
  document.querySelectorAll('.asset').forEach(function (asset) {
    var first = asset.querySelector('.claim');
    if (first) selectClaim(asset, first.dataset.claim);
  });
`;

export function renderPage(view: ExplorerView): string {
  const empty = renderEmptyState(view);

  const body =
    empty !== ''
      ? empty +
        (view.units.length === 0
          ? ''
          : `<h3>Your work</h3><ul class="units">${view.units
              .map(
                (unit) => `<li>
                  <span>${escapeHtml(unit.title)}</span>
                  <span class="meta">${unit.recordCount} record(s) · ${unit.openQuestionCount} question(s) · <code>${escapeHtml(unit.id)}</code></span>
                </li>`,
              )
              .join('')}</ul>`)
      : view.assets.map(renderAsset).join('');

  const questions =
    empty === '' && view.questions.length > 0
      ? `<h3>Every open question</h3>
         <p class="empty">Answering any of these makes something you have already written stronger.</p>
         ${renderQuestions(view.questions)}`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence Explorer · CareerForge</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <h1>Evidence Explorer</h1>
  <span class="totals">${view.totals.evidence} record(s) · ${view.totals.units} unit(s) · ${view.totals.assets} statement(s) · ${view.totals.questions} question(s)</span>
  <span class="local">Served from your machine. Nothing on this page has left it.</span>
</header>
<main>
${body}
${questions}
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
