import type { Digest, EnrichmentType } from '@careerforge/domain';
import type { ProviderParams } from '@careerforge/policy';

import { canonicalise } from './canonical.js';

/**
 * Prompts as versioned artifacts.
 *
 * A prompt is not configuration and it is not a string literal near the code
 * that sends it. It is the instrument that produced an interpretation, and an
 * interpretation is only reviewable if the instrument is still recoverable.
 *
 * So every template is immutable once published, identified by a version, and
 * frozen by a committed lockfile of content hashes. Editing `skills@1` fails
 * the build. Changing behaviour means adding `skills@2`, which means every run
 * record already in the store keeps pointing at the exact text that produced
 * it (ADR-0023).
 *
 * ── Two rules the instructions all obey ──────────────────────────────────
 *
 * 1. **Cite or be discarded.** Every item must name the input records it came
 *    from. An item citing something that was never sent is dropped at
 *    validation (ADR-0024). This is the cheapest available check on invention
 *    and it costs the model almost nothing.
 *
 * 2. **Never assert a number.** Metrics come from computation or from the
 *    user, never from a model — a rule the claim predicate has enforced since
 *    M1. The templates state it too, so the model is not being asked to
 *    produce something that will be thrown away.
 */

export interface PromptTemplate {
  /** `skills@1`. The version is part of the identity, not metadata about it. */
  readonly id: string;
  readonly enrichmentType: EnrichmentType;
  /** Static text. Interpolates nothing — a test asserts it. */
  readonly instructions: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly schemaName: string;
  readonly params: ProviderParams;
}

/** The shape every template's output shares: a list of cited items. */
const citedArray = (
  itemName: string,
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  type: 'object',
  additionalProperties: false,
  required: [itemName],
  properties: {
    [itemName]: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...Object.keys(properties), 'evidence'],
        properties: {
          ...properties,
          evidence: {
            type: 'array',
            description: 'Ids of the input records this came from, copied exactly.',
            items: { type: 'string' },
          },
        },
      },
    },
  },
});

const CITATION_RULE = `Every item you return must list the ids of the input records it came from, copied
exactly as they appear in the [evidence <id>] markers. An item that cites a
record you were not shown will be discarded, so cite only what you read.`;

const NO_NUMBERS_RULE = `Never state a quantity, percentage, duration, or count that is not written in
the input. Do not estimate one. Numbers in this system come from computation
or from the person, never from a model, and an invented number is the single
worst thing this software could produce.`;

const NO_SENIORITY_RULE = `Never infer leadership, seniority, ownership, or scope. Whether this person
led the work, owned the system, or decided the approach is not visible in the
artifacts and is not yours to decide. The system refuses claims built on it.`;

const skills: PromptTemplate = {
  id: 'skills@1',
  enrichmentType: 'skills',
  schemaName: 'skills',
  params: { temperature: 0, maxOutputTokens: 1500 },
  schema: citedArray('skills', {
    name: {
      type: 'string',
      description: 'The capability, named the way a practitioner would name it.',
    },
    category: {
      type: 'string',
      enum: ['engineering', 'operations', 'security', 'data', 'design', 'communication', 'other'],
    },
    rationale: {
      type: 'string',
      description: 'One sentence saying what in the input demonstrates this.',
    },
  }),
  instructions: `You are reading a record of work somebody actually did — commits, coding
sessions, and notes — and identifying the capabilities it demonstrates.

Name capabilities, not job titles and not tools. "Incremental parsing of an
append-only log" is a capability. "Senior Engineer" is a title. "TypeScript" is
a tool, and a different task collects those.

Only name a capability the work demonstrates. Reading a file about caching does
not demonstrate caching; changing a cache does. If the input shows somebody
struggling with something and not resolving it, that is not a demonstrated
capability, and leaving it out is the correct answer.

${CITATION_RULE}

${NO_NUMBERS_RULE}

${NO_SENIORITY_RULE}

Returning an empty list is a valid and often correct answer.`,
};

const technologies: PromptTemplate = {
  id: 'technologies@1',
  enrichmentType: 'technologies',
  schemaName: 'technologies',
  params: { temperature: 0, maxOutputTokens: 1000 },
  schema: citedArray('technologies', {
    name: { type: 'string', description: 'The tool, language, service, or framework.' },
    engagement: {
      type: 'string',
      enum: ['built_with', 'configured', 'debugged', 'mentioned'],
      description: 'How the input shows it being used. "mentioned" is the weakest.',
    },
  }),
  instructions: `You are extracting the named technologies present in a record of work.

This is extraction, not interpretation. Name only technologies the input
actually names or unambiguously shows — a file called "docker-compose.yml"
shows Docker; a discussion of containers in general does not.

Distinguish how each one appears. Something the person built with is not the
same as something they mentioned in passing, and collapsing the two produces a
résumé that lists every word anybody said.

${CITATION_RULE}

${NO_NUMBERS_RULE}

${NO_SENIORITY_RULE}

Do not infer a technology from another one. A React project does not
automatically demonstrate Webpack.

Returning an empty list is a valid and often correct answer.`,
};

const starCandidate: PromptTemplate = {
  id: 'star_candidate@1',
  enrichmentType: 'star_candidate',
  schemaName: 'star_candidate',
  params: { temperature: 0, maxOutputTokens: 2000 },
  schema: citedArray('candidates', {
    situation: { type: 'string', description: 'What was wrong or needed, from the input.' },
    task: { type: 'string', description: 'What had to be done.' },
    action: { type: 'string', description: 'What was actually done, from the artifacts.' },
    result: { type: 'string', description: 'What changed. Only what the input says changed.' },
    resultBasis: {
      type: 'string',
      enum: ['stated_in_evidence', 'not_evidenced'],
      description:
        'Whether the result is written in the input or is your inference. Be honest; "not_evidenced" is expected and is not a failure.',
    },
  }),
  instructions: `You are drafting interview-answer candidates in situation / task / action /
result form, from a record of work somebody actually did.

These are candidates for a person to review, not statements of fact. They will
be shown alongside the evidence they came from and the person will correct
them. Draft accordingly: it is far better to under-claim and be corrected
upward than to write something flattering that the person then has to defend in
an interview.

The result is the dangerous field. Most work in a coding record has no visible
outcome — the commit landed and the effect is unrecorded. When that is the
case, say so with "not_evidenced" and describe only what the change was
intended to do. Marking a result "not_evidenced" is the expected answer, not a
failure, and the system uses that flag to decide what may appear in a résumé.

${CITATION_RULE}

${NO_NUMBERS_RULE}

${NO_SENIORITY_RULE}

Returning an empty list is a valid and often correct answer.`,
};

/**
 * Every published template.
 *
 * Keyed by versioned id. Adding a version never removes the one before it: a
 * run recorded two years ago must still resolve the exact text it used.
 */
export const TEMPLATES: Readonly<Record<string, PromptTemplate>> = Object.freeze({
  [skills.id]: skills,
  [technologies.id]: technologies,
  [starCandidate.id]: starCandidate,
});

/** The version each enrichment type uses for a new run today. */
export const CURRENT_TEMPLATE: Readonly<Partial<Record<EnrichmentType, string>>> = Object.freeze({
  skills: skills.id,
  technologies: technologies.id,
  star_candidate: starCandidate.id,
});

export const ENRICHABLE_TYPES: readonly EnrichmentType[] = Object.freeze(
  Object.keys(CURRENT_TEMPLATE) as EnrichmentType[],
);

/**
 * The content hash of a template, over everything that shapes its output.
 *
 * Instructions, schema, and sampling parameters all change what comes back, so
 * all three are in the hash. The id is not: a template's identity is what it
 * says, and hashing the name too would let a rename look like a rewrite.
 */
export function templateHash(template: PromptTemplate, digest: Digest): string {
  return digest(
    canonicalise({
      instructions: template.instructions,
      schema: template.schema,
      schemaName: template.schemaName,
      params: template.params,
    }),
  );
}

export function resolveTemplate(id: string): PromptTemplate | null {
  return TEMPLATES[id] ?? null;
}

/** The template a new run of this type should use, or null if none exists. */
export function templateFor(enrichmentType: EnrichmentType): PromptTemplate | null {
  const id = CURRENT_TEMPLATE[enrichmentType];
  return id === undefined ? null : (TEMPLATES[id] ?? null);
}
