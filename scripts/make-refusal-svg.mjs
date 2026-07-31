import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Render the refusal — step 2 of `careerforge tour` — as an animated terminal.
 *
 * This is the first thing anybody sees on the README, so it is generated
 * rather than recorded. A recording is a screenshot of a moment; a generator
 * is something a release can re-run, a reviewer can diff, and a contributor
 * can regenerate without installing a screen recorder. The text below is the
 * tour's real output, condensed only where a 66-column frame required it:
 * identifiers shortened, the long "why" sentences wrapped.
 *
 * SVG rather than GIF on purpose. It stays sharp at any size, it is about
 * fifteen kilobytes rather than three megabytes, it animates inside an
 * <img> tag on GitHub, and the diff of a change to it is readable.
 *
 *   node scripts/make-refusal-svg.mjs
 *
 * If the tour's output changes, change it here too. A demo that has drifted
 * from the product is worse than no demo, because it is a promise the
 * software no longer keeps.
 */

const CYCLE = 17; // seconds for one loop
const FONT = 14;
const LINE_H = 20;
const CHAR_W = 8.4;
const PAD_X = 26;
const PAD_Y = 52; // room for the window chrome

// Tokyo-night-ish, matching packages/ui/src/page.ts so the terminal and the
// Evidence Explorer look like the same product.
const C = {
  bg: '#0f1115',
  chrome: '#171a21',
  line: '#2a2f3a',
  text: '#e6e8ec',
  dim: '#9aa3b2',
  accent: '#7aa2f7',
  good: '#7ec699',
  warn: '#e0af68',
  bad: '#f7768e',
};

/**
 * Each line is [appearsAtSeconds, segments], where a segment is [colour, text]
 * and colour is a key of C. `strike` draws the rule through a refused claim a
 * beat after the claim itself lands — the beat is the whole point, because the
 * viewer has to read the claim before watching it be taken away.
 */
const LINES = [
  [
    0.3,
    [
      ['dim', '$ '],
      ['text', 'careerforge generate resume-bullet'],
    ],
  ],
  [0.0, []],
  [1.0, [['dim', 'Work unit: Working out why the nightly export kept timing out']]],
  [1.15, [['dim', 'Reading:   6 record(s)']]],
  [0.0, []],
  [1.7, [['text', 'Rebuilt the nightly export to run incrementally.']]],
  [0.0, []],
  [2.3, [['dim', 'Every part of that, and what stands behind it:']]],
  [0.0, []],
  [
    2.7,
    [
      ['good', '  action   '],
      ['text', 'Rebuilt the nightly export to run incrementally'],
    ],
  ],
  [2.85, [['dim', '           cites 3 records, from git and from a coding session']]],
  [0.0, []],
  [
    3.6,
    [
      ['warn', 'Left out '],
      ['dim', '- the evidence does not carry them:'],
    ],
  ],
  [0.0, []],
  [
    4.2,
    [
      ['bad', '  role     '],
      ['text', '"led the redesign of the export pipeline"'],
    ],
    { strike: 5.0 },
  ],
  [5.5, [['dim', '           Leadership and responsibility cannot be inferred']]],
  [5.62, [['dim', '           from activity.']]],
  [5.9, [['accent', '           -> What was your role? Did you lead it?']]],
  [0.0, []],
  [
    6.6,
    [
      ['bad', '  metric   '],
      ['text', '"cutting export time by 80%"'],
    ],
    { strike: 7.4 },
  ],
  [7.9, [['dim', '           Numbers must be computed from evidence or confirmed']]],
  [8.02, [['dim', '           by you. CareerForge will ask rather than estimate.']]],
  [8.3, [['accent', '           -> Did this work produce a measurable result?']]],
  [0.0, []],
  [
    9.0,
    [
      ['bad', '  outcome  '],
      ['text', '"eliminating the nightly timeout alerts"'],
    ],
    { strike: 9.8 },
  ],
  [10.3, [['dim', '           The evidence records the work, not what came of it.']]],
  [10.42, [['dim', '           An outcome has to be observed, never inferred.']]],
  [10.7, [['accent', '           -> What actually changed as a result of this work?']]],
  [0.0, []],
  [
    11.5,
    [
      ['good', 'Evidence: corroborated '],
      ['dim', '- 3 records from 2 source(s)'],
    ],
  ],
  [11.9, [['warn', '  Left out for want of evidence: metric, outcome, role.']]],
];

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (t) => ((t / CYCLE) * 100).toFixed(2);

const widest = Math.max(
  ...LINES.map(([, segs]) => segs.reduce((n, [, text]) => n + text.length, 0)),
);
const W = Math.ceil(widest * CHAR_W + PAD_X * 2);
const H = LINES.length * LINE_H + PAD_Y + 26;

const css = [];
const body = [];

LINES.forEach(([at, segs, opts], i) => {
  if (segs.length === 0) return;

  const y = PAD_Y + i * LINE_H;
  // Reveal: invisible until `at`, then a short fade that holds to the end of
  // the cycle. Every line uses the same cycle length so the whole frame
  // restarts together.
  css.push(
    `@keyframes r${i}{0%,${pct(at)}%{opacity:0}${pct(at + 0.28)}%,100%{opacity:1}}`,
    `.r${i}{animation:r${i} ${CYCLE}s linear infinite}`,
  );

  let x = PAD_X;
  const tspans = segs
    .map(([colour, text]) => {
      // `textLength` is what makes this file render identically everywhere.
      // The monospace stack resolves to a different font on each platform —
      // Consolas advances 7.69px at this size, Menlo and DejaVu 8.43 — so a
      // layout computed from an assumed cell width is misaligned on two
      // thirds of the machines that will view it. Declaring the width instead
      // of predicting it moves the arithmetic to the renderer, which knows.
      const width = (text.length * CHAR_W).toFixed(1);
      const span =
        `<tspan x="${x.toFixed(1)}" textLength="${width}" lengthAdjust="spacing" ` +
        `fill="${C[colour]}">${esc(text)}</tspan>`;
      x += text.length * CHAR_W;
      return span;
    })
    .join('');

  body.push(`<text class="r${i}" y="${y}" xml:space="preserve">${tspans}</text>`);

  if (opts?.strike !== undefined) {
    const s = opts.strike;
    const from = PAD_X + segs[0][1].length * CHAR_W;
    const width = segs[1][1].length * CHAR_W;
    css.push(
      `@keyframes k${i}{0%,${pct(s)}%{transform:scaleX(0)}${pct(s + 0.45)}%,100%{transform:scaleX(1)}}`,
      `.k${i}{animation:k${i} ${CYCLE}s ease-out infinite;transform-origin:left center;transform-box:fill-box}`,
    );
    body.push(
      `<rect class="k${i}" x="${from.toFixed(1)}" y="${(y - 4).toFixed(1)}" ` +
        `width="${width.toFixed(1)}" height="1.6" fill="${C.bad}"/>`,
    );
  }
});

// The cursor blinks while the command sits there unanswered, then gets out of
// the way once output starts.
css.push(
  `@keyframes cur{0%,1.7%{opacity:0}2%,3%{opacity:1}3.4%,4.4%{opacity:0}4.8%,5.8%{opacity:1}6.2%,100%{opacity:0}}`,
  `.cur{animation:cur ${CYCLE}s steps(1,end) infinite}`,
);
body.push(
  `<rect class="cur" x="${(PAD_X + 36 * CHAR_W).toFixed(1)}" y="${(PAD_Y - 11).toFixed(1)}" width="8" height="15" fill="${C.accent}"/>`,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="careerforge generate resume-bullet: the model proposes four claims and three are refused for want of evidence, each naming the question that would change the answer">
<title>CareerForge refuses three of four proposed claims</title>
<style>
text{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:${FONT}px}
${css.join('\n')}
</style>
<rect width="${W}" height="${H}" rx="10" fill="${C.bg}"/>
<rect width="${W}" height="30" rx="10" fill="${C.chrome}"/>
<rect y="20" width="${W}" height="10" fill="${C.chrome}"/>
<line x1="0" y1="30" x2="${W}" y2="30" stroke="${C.line}"/>
<circle cx="19" cy="15" r="4.5" fill="#f7768e"/><circle cx="35" cy="15" r="4.5" fill="#e0af68"/><circle cx="51" cy="15" r="4.5" fill="#7ec699"/>
<text x="${(W / 2).toFixed(0)}" y="19.5" text-anchor="middle" fill="${C.dim}" font-size="11">careerforge</text>
${body.join('\n')}
</svg>
`;

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), 'docs', 'assets');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'refusal.svg'), svg, 'utf8');
console.log(`docs/assets/refusal.svg  ${W}x${H}  ${(svg.length / 1024).toFixed(1)} kB`);
