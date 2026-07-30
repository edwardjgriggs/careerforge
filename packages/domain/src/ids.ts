import type { Brand, Clock, EntropySource } from './primitives.js';

/**
 * ULIDs: 48 bits of timestamp followed by 80 bits of randomness, Crockford
 * base32, 26 characters.
 *
 * Chosen over UUIDv4 because sorting matters. Sync merges two append-only
 * logs from machines that never coordinated (ADR-0004), and lexicographic
 * ordering that matches creation order is what lets that merge converge
 * without a central authority. It also makes `ORDER BY id` meaningful, which
 * a random UUID cannot offer.
 */

/** Crockford base32: no I, L, O, or U — the characters humans misread. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LENGTH = ALPHABET.length; // 32

const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
export const ULID_LENGTH = TIME_LENGTH + RANDOM_LENGTH; // 26

/** Largest timestamp a 10-character base32 field can hold (2^48 - 1). */
export const MAX_ULID_TIME = 281_474_976_710_655;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type Ulid = Brand<string, 'Ulid'>;

export type EvidenceId = Brand<string, 'EvidenceId'>;
export type WorkUnitId = Brand<string, 'WorkUnitId'>;
export type EnrichmentId = Brand<string, 'EnrichmentId'>;
export type EnrichmentRunId = Brand<string, 'EnrichmentRunId'>;
export type ClaimId = Brand<string, 'ClaimId'>;
export type GapId = Brand<string, 'GapId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type ProvenanceEdgeId = Brand<string, 'ProvenanceEdgeId'>;
export type TombstoneId = Brand<string, 'TombstoneId'>;
export type PolicyDecisionId = Brand<string, 'PolicyDecisionId'>;

export function isUlid(value: string): value is Ulid {
  return ULID_PATTERN.test(value);
}

/**
 * Assert a string is a well-formed ULID and brand it.
 *
 * The single doorway through which an untrusted string becomes an identifier.
 * Everything downstream can then rely on the shape without re-checking.
 */
export function toUlid(value: string): Ulid {
  if (!isUlid(value)) {
    throw new Error(
      `Not a ULID: ${JSON.stringify(value)} (expected ${ULID_LENGTH} Crockford base32 characters)`,
    );
  }
  return value;
}

function encodeTime(timestamp: number): string {
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    throw new Error(`ULID timestamp must be a non-negative integer, received ${timestamp}`);
  }
  if (timestamp > MAX_ULID_TIME) {
    throw new Error(`ULID timestamp ${timestamp} exceeds the maximum ${MAX_ULID_TIME}`);
  }
  let remaining = timestamp;
  let out = '';
  for (let i = 0; i < TIME_LENGTH; i++) {
    const mod = remaining % ENCODING_LENGTH;
    out = ALPHABET[mod]! + out;
    remaining = (remaining - mod) / ENCODING_LENGTH;
  }
  return out;
}

function encodeRandom(entropy: EntropySource): string {
  const bytes = entropy(RANDOM_LENGTH);
  if (bytes.length < RANDOM_LENGTH) {
    throw new Error(`Entropy source returned ${bytes.length} bytes, expected ${RANDOM_LENGTH}`);
  }
  let out = '';
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ENCODING_LENGTH]!;
  }
  return out;
}

/**
 * Increment a base32 string, carrying leftwards.
 *
 * Used only for monotonicity within a single millisecond. Returns null when
 * the field is saturated (all 'Z'), which the caller treats as a hard error
 * rather than silently wrapping — a wrapped counter would produce a ULID that
 * sorts *before* its predecessor, quietly breaking the ordering guarantee
 * everything else depends on.
 */
function incrementBase32(value: string): string | null {
  const chars = value.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = ALPHABET.indexOf(chars[i]!);
    if (index === -1) throw new Error(`Invalid base32 character: ${chars[i]!}`);
    if (index < ENCODING_LENGTH - 1) {
      chars[i] = ALPHABET[index + 1]!;
      return chars.join('');
    }
    chars[i] = ALPHABET[0]!;
  }
  return null;
}

/** Extract the creation time encoded in a ULID. Pure, and exact. */
export function ulidTime(id: Ulid): number {
  let time = 0;
  for (let i = 0; i < TIME_LENGTH; i++) {
    const index = ALPHABET.indexOf(id[i]!);
    if (index === -1) throw new Error(`Invalid ULID character at position ${i}: ${id[i]!}`);
    time = time * ENCODING_LENGTH + index;
  }
  return time;
}

export type UlidFactory = () => Ulid;

/**
 * A monotonic ULID factory.
 *
 * Two IDs generated in the same millisecond still sort in creation order: the
 * random field is incremented rather than redrawn. Without this, a fast
 * collector emitting a hundred records per millisecond produces IDs whose
 * order is arbitrary, and "append-only log ordering" stops meaning anything.
 *
 * Not thread-shared and not reentrant, which is fine: it is created per
 * process by the composition root.
 */
export function createUlidFactory(clock: Clock, entropy: EntropySource): UlidFactory {
  let lastTime = -1;
  let lastRandom = '';

  return function nextUlid(): Ulid {
    const now = clock();
    if (!Number.isFinite(now)) {
      throw new Error(`Clock returned a non-finite value: ${now}`);
    }
    const timestamp = Math.floor(now);

    if (timestamp === lastTime) {
      const incremented = incrementBase32(lastRandom);
      if (incremented === null) {
        throw new Error(
          'ULID randomness exhausted within a single millisecond. ' +
            'This should be unreachable; it would mean 2^80 identifiers in one millisecond.',
        );
      }
      lastRandom = incremented;
    } else {
      // A clock that moves backwards (NTP correction, VM resume) must not
      // produce IDs that sort before existing ones. Hold the previous
      // timestamp and keep incrementing instead.
      if (timestamp < lastTime) {
        const incremented = incrementBase32(lastRandom);
        if (incremented === null) {
          throw new Error('ULID randomness exhausted while the clock was running backwards.');
        }
        lastRandom = incremented;
        return (encodeTime(lastTime) + lastRandom) as Ulid;
      }
      lastTime = timestamp;
      lastRandom = encodeRandom(entropy);
    }

    return (encodeTime(lastTime) + lastRandom) as Ulid;
  };
}
