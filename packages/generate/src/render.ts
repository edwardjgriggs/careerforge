import type { ClaimType } from '@careerforge/domain';

/**
 * Composing the sentence, so that no dropped claim can leave a trace in it.
 *
 * The model returns assertions, not prose. The bullet is built here from the
 * assertions that survived support, which is what makes the fabrication
 * guarantee mechanical rather than diligent: if a claim fails, its words are
 * never placed, so there is nothing to notice and remove afterwards.
 *
 * Rendering after the check also makes spans exact by construction. A
 * generator that writes a sentence and then locates its claims inside it is
 * doing fuzzy matching on its own output, and every span it gets slightly
 * wrong is an explanation pointing at the wrong words.
 */

export interface PlacedClaim {
  /** The clause exactly as it appears in the rendered text. */
  readonly text: string;
  readonly claimType: ClaimType;
  readonly span: readonly [number, number];
  readonly evidence: readonly string[];
  readonly corroborating: boolean;
}

export interface RenderedBullet {
  readonly text: string;
  readonly claims: readonly PlacedClaim[];
}

export interface RenderableClaim {
  readonly text: string;
  readonly claimType: ClaimType;
  readonly evidence: readonly string[];
  readonly corroborating: boolean;
}

const capitalise = (clause: string): string =>
  clause.length === 0 ? clause : clause[0]!.toUpperCase() + clause.slice(1);

/** Trim the punctuation the model was asked not to add, in case it did. */
const clean = (clause: string): string => clause.trim().replace(/[.,;]+$/, '');

/**
 * Join surviving claims into one sentence, recording where each one landed.
 *
 * Deliberately plain. The joining is `a, b, and c` — no transitions, no
 * subordination, no attempt at rhythm. Prose that reads well is prose somebody
 * has shaped, and a shaping step between the claim check and the output is
 * another place for an unsupported assertion to appear. A slightly stiff
 * sentence that is demonstrably true beats a graceful one that is not.
 */
export function renderBullet(claims: readonly RenderableClaim[]): RenderedBullet {
  const clauses = claims
    .map((claim) => ({ ...claim, text: clean(claim.text) }))
    .filter((claim) => claim.text !== '');

  if (clauses.length === 0) return { text: '', claims: [] };

  const placed: PlacedClaim[] = [];
  let text = '';

  for (const [index, clause] of clauses.entries()) {
    if (index > 0) text += clauses.length > 2 ? ', ' : ' ';
    if (index > 0 && index === clauses.length - 1) text += 'and ';

    // Capitalise before placing, never after, so the stored claim text is
    // byte-identical to the substring at its span.
    const body = index === 0 ? capitalise(clause.text) : clause.text;
    const start = text.length;
    text += body;

    placed.push({
      text: body,
      claimType: clause.claimType,
      span: [start, text.length],
      evidence: clause.evidence,
      corroborating: clause.corroborating,
    });
  }

  return { text: `${text}.`, claims: placed };
}

/**
 * Whether every claim's text is exactly the substring at its span.
 *
 * Exported because it is worth asserting from outside as well as inside. An
 * explanation that highlights the wrong words is worse than one that
 * highlights none: it tells the user something confident and false about which
 * part of their bullet the evidence covers.
 */
export function spansAreExact(rendered: RenderedBullet): boolean {
  return rendered.claims.every(
    (claim) => rendered.text.slice(claim.span[0], claim.span[1]) === claim.text,
  );
}
