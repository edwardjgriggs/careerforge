import { createHash, randomBytes } from 'node:crypto';

import type { Clock, Digest, EntropySource, Platform } from '@careerforge/domain';

/**
 * The platform primitives the domain declares but must never import.
 *
 * ADR-0012: the domain owns the rules — ULID layout, what constitutes
 * identity, which bytes get hashed — and adapters own the primitives. This is
 * the adapter.
 */

export const systemClock: Clock = () => Date.now();

/** Cryptographically secure. The domain never has an opinion about entropy. */
export const systemEntropy: EntropySource = (byteLength) => randomBytes(byteLength);

export const sha256: Digest = (input) => createHash('sha256').update(input, 'utf8').digest('hex');

export const nodePlatform: Platform = {
  clock: systemClock,
  entropy: systemEntropy,
  digest: sha256,
};

/**
 * A platform with a pinned clock and counter-based entropy.
 *
 * Exported rather than confined to tests: the migration fixture harness and
 * the export round-trip check both need byte-identical output across runs,
 * which is impossible with a real clock.
 *
 * Never suitable for real identifiers — the entropy is a counter.
 */
export function deterministicPlatform(startMillis = 1_785_000_000_000, stepMillis = 1): Platform {
  let now = startMillis - stepMillis;
  let counter = 0;
  return {
    clock: () => (now += stepMillis),
    entropy: (byteLength) => Uint8Array.from({ length: byteLength }, () => counter++ % 256),
    digest: sha256,
  };
}
