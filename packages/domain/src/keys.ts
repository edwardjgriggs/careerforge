import type { AttributeMap, AttributeValue } from './attributes.js';
import type { Digest } from './primitives.js';

/**
 * Identity and change detection for collected artifacts.
 *
 * Two domain rules live here, and only the rules — the hash itself is
 * supplied by the platform (ADR-0012):
 *
 *   natural_key   what makes two collected artifacts *the same artifact*
 *   content_hash  what makes the same artifact *different from before*
 *
 * Together they give idempotent collection. Re-collecting an unchanged
 * artifact is a no-op; re-collecting a changed one emits a new record that
 * supersedes the old. Without a natural key, a backfill overlapping an
 * incremental run duplicates the user's entire history.
 *
 * This is identity derivation, not serialization. It answers a question about
 * evidence, not a question about storage.
 */

/**
 * Field separator, per `Architecture.md` §2.2.
 *
 * NUL because it cannot occur in a collector id or a source URI, so no two
 * distinct inputs can canonicalise to the same string. A printable separator
 * would let ("git", "a:b") collide with ("git:a", "b").
 *
 * Written as an escape rather than a literal NUL byte: an invisible control
 * character in source is unreviewable in a diff.
 */
const FIELD_SEPARATOR = '\u0000';

/**
 * The exact string hashed to produce a natural key.
 *
 * Exposed because it is far more testable than the digest of it: a
 * determinism test can assert this directly without needing SHA-256, and a
 * failure names the offending input instead of two unequal hex strings.
 */
export function canonicalNaturalKeyInput(collectorId: string, sourceUri: string): string {
  if (collectorId === '') throw new Error('collectorId must not be empty');
  if (sourceUri === '') throw new Error('sourceUri must not be empty');
  if (collectorId.includes(FIELD_SEPARATOR) || sourceUri.includes(FIELD_SEPARATOR)) {
    throw new Error('collectorId and sourceUri must not contain a NUL character');
  }
  return `${collectorId}${FIELD_SEPARATOR}${sourceUri}`;
}

export function deriveNaturalKey(digest: Digest, collectorId: string, sourceUri: string): string {
  return digest(canonicalNaturalKeyInput(collectorId, sourceUri));
}

/**
 * A collected artifact reduced to the fields that define its content.
 *
 * Deliberately excludes anything CareerForge assigns — id, timestamps,
 * collector version — so that re-collecting the same artifact with a newer
 * collector does not read as a change.
 */
export interface ContentFingerprint {
  readonly title: string;
  readonly summary: string | null;
  readonly excerpt: string | null;
  readonly attributes: AttributeMap;
}

function canonicalValue(value: AttributeValue): string {
  if (Array.isArray(value)) {
    // Sorted: a collector listing coauthors in a different order next run has
    // not changed the artifact, and treating that as a change would supersede
    // records forever in a loop.
    return `[${[...value]
      .sort()
      .map((member) => JSON.stringify(member))
      .join(',')}]`;
  }
  return JSON.stringify(value);
}

/**
 * The exact string hashed to produce a content hash.
 *
 * Key order is normalised so that two objects with identical contents in
 * different insertion orders canonicalise identically. `JSON.stringify` alone
 * preserves insertion order and would make the hash depend on how a collector
 * happened to build its object — a difference with no meaning that would
 * nonetheless supersede a record on every run.
 */
export function canonicalContentInput(fingerprint: ContentFingerprint): string {
  const parts: string[] = [
    `title=${JSON.stringify(fingerprint.title)}`,
    `summary=${JSON.stringify(fingerprint.summary)}`,
    `excerpt=${JSON.stringify(fingerprint.excerpt)}`,
  ];
  const keys = Object.keys(fingerprint.attributes).sort();
  for (const key of keys) {
    parts.push(`attr.${key}=${canonicalValue(fingerprint.attributes[key]!)}`);
  }
  return parts.join(FIELD_SEPARATOR);
}

export function deriveContentHash(digest: Digest, fingerprint: ContentFingerprint): string {
  return digest(canonicalContentInput(fingerprint));
}

/**
 * Attributes in canonical form: keys sorted, array members sorted.
 *
 * Hashing already treats key order and array order as meaningless, so storage
 * must too. Without this, two collectors that build the same object
 * differently produce one content hash and two different stored
 * representations, and *which one you get depends on which arrived first*.
 *
 * That is not a cosmetic difference. It makes the stored state a function of
 * ingestion order, which breaks convergence, and it would make the JSON
 * export byte-different across machines for identical facts — the exact
 * property invariant I5 depends on.
 *
 * The corollary is deliberate: declaring an attribute a `string[]` declares it
 * a *set*. If order carries meaning, it is not an array attribute.
 */
export function canonicalAttributes(attributes: AttributeMap): AttributeMap {
  const canonical: Record<string, AttributeValue> = {};
  for (const key of Object.keys(attributes).sort()) {
    const value = attributes[key]!;
    canonical[key] = Array.isArray(value) ? [...value].sort() : value;
  }
  return canonical;
}

/**
 * Whether a freshly collected artifact differs from what is already stored.
 *
 * The whole of change detection: same natural key, different content hash
 * means supersede. Nothing is ever mutated in place (ADR-0001).
 */
export function hasContentChanged(storedContentHash: string, incomingContentHash: string): boolean {
  return storedContentHash !== incomingContentHash;
}
