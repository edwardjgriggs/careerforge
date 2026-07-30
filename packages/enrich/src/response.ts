import type { PromptTemplate } from './templates.js';

/**
 * What came back, checked before anybody believes it.
 *
 * A provider that supports JSON Schema will usually return the right shape.
 * "Usually" is not a basis for writing something into a store that a person
 * will later put on a résumé, and schema conformance was never the interesting
 * question anyway. The interesting question is whether the model is talking
 * about the records it was actually shown.
 *
 * ── Cite or be discarded ─────────────────────────────────────────────────
 *
 * Every item names the input ids it came from. Those ids are checked against
 * the set that was actually sent, and an item citing anything else is dropped
 * (ADR-0024). It is a cheap, mechanical check on the one failure mode that
 * matters here: a model producing a confident sentence about work that is not
 * in front of it.
 *
 * Dropped items are counted and reported, never silently discarded. A run that
 * quietly threw away half its output while reporting success would be worse
 * than one that failed.
 */

export interface ValidatedItem {
  /** The item as returned, minus its citation list. */
  readonly value: Readonly<Record<string, unknown>>;
  /** Input ids, filtered to those actually sent. Never empty. */
  readonly evidence: readonly string[];
}

export const REJECTION_REASONS = [
  /** Not an object, or missing a required field. */
  'malformed',
  /** No `evidence` array at all. */
  'uncited',
  /** Every id it cited was one we never sent. */
  'fabricated_citation',
  /** Two items said the same thing about the same inputs. */
  'duplicate',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface Rejection {
  readonly reason: RejectionReason;
  /** Enough of the item to recognise it, never the whole thing. */
  readonly summary: string;
}

export interface ValidatedResponse {
  readonly items: readonly ValidatedItem[];
  readonly rejections: readonly Rejection[];
  /**
   * Citations that named a record we never sent, deduplicated.
   *
   * Surfaced separately from the rejection count because a run with many of
   * these is a signal about the prompt, not about the work unit.
   */
  readonly unknownCitations: readonly string[];
}

/** The single array property every template's schema returns. */
function collectionKey(template: PromptTemplate): string {
  const properties = template.schema['properties'] as Record<string, unknown> | undefined;
  return Object.keys(properties ?? {})[0] ?? 'items';
}

function requiredFields(template: PromptTemplate): readonly string[] {
  const properties = template.schema['properties'] as
    Record<string, { items?: { required?: string[] } }> | undefined;
  const only = Object.values(properties ?? {})[0];
  return (only?.items?.required ?? []).filter((field) => field !== 'evidence');
}

/** A short, safe label for a rejected item. Never the item's full text. */
function summarise(item: unknown): string {
  if (typeof item !== 'object' || item === null) return String(item).slice(0, 60);
  const record = item as Record<string, unknown>;
  const label = record['name'] ?? record['situation'] ?? Object.values(record)[0];
  return String(label ?? '(empty)').slice(0, 60);
}

/**
 * Check a provider response against the template that asked for it.
 *
 * `sentIds` is the authority on what the model saw. It comes from the payload
 * the policy engine assembled, not from the caller's intent, so an id the
 * engine dropped for any reason is correctly treated as never shown.
 */
export function validateResponse(
  raw: unknown,
  template: PromptTemplate,
  sentIds: readonly string[],
): ValidatedResponse {
  const permitted = new Set(sentIds);
  const items: ValidatedItem[] = [];
  const rejections: Rejection[] = [];
  const unknown = new Set<string>();
  const seen = new Set<string>();

  const key = collectionKey(template);
  const required = requiredFields(template);

  const collection =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;

  if (!Array.isArray(collection)) {
    // Not a partial failure. The provider returned something that is not the
    // requested shape at all, and pretending otherwise would silently record
    // an empty enrichment as a successful one.
    return {
      items: [],
      rejections: [{ reason: 'malformed', summary: `expected an array at "${key}"` }],
      unknownCitations: [],
    };
  }

  for (const candidate of collection as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      rejections.push({ reason: 'malformed', summary: summarise(candidate) });
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const missing = required.filter(
      (field) => record[field] === undefined || record[field] === null || record[field] === '',
    );
    if (missing.length > 0) {
      rejections.push({
        reason: 'malformed',
        summary: `${summarise(record)} (missing ${missing.join(', ')})`,
      });
      continue;
    }

    const cited = record['evidence'];
    if (!Array.isArray(cited) || cited.length === 0) {
      rejections.push({ reason: 'uncited', summary: summarise(record) });
      continue;
    }

    const kept: string[] = [];
    for (const id of cited as unknown[]) {
      if (typeof id !== 'string') continue;
      if (permitted.has(id)) kept.push(id);
      else unknown.add(id);
    }

    if (kept.length === 0) {
      // Every id it named was one we never sent. The item may even be true,
      // and it is still unusable: nothing in the store stands behind it.
      rejections.push({ reason: 'fabricated_citation', summary: summarise(record) });
      continue;
    }

    const { evidence: _cited, ...value } = record;
    // Same statement, same inputs. A duplicate is not evidence of two things.
    const fingerprint = `${JSON.stringify(value)}::${[...kept].sort().join(',')}`;
    if (seen.has(fingerprint)) {
      rejections.push({ reason: 'duplicate', summary: summarise(record) });
      continue;
    }
    seen.add(fingerprint);

    items.push({ value, evidence: [...new Set(kept)].sort() });
  }

  return { items, rejections, unknownCitations: [...unknown].sort() };
}

/**
 * Whether a response is too damaged to record.
 *
 * A run that returned nothing usable should not leave an empty enrichment
 * behind claiming success — the next run would treat it as a cache hit and the
 * failure would become permanent.
 */
export function isUnusable(response: ValidatedResponse): boolean {
  return response.items.length === 0 && response.rejections.length > 0;
}
