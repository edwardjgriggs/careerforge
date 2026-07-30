/**
 * Platform primitives the domain needs but must never import.
 *
 * These are type declarations only. The domain applies the function it is
 * handed; it never reaches for a clock, an entropy source, or a hash itself.
 * That is what keeps invariant I1 free of exceptions. See ADR-0012.
 */

/** Current time in epoch milliseconds. */
export type Clock = () => number;

/** Cryptographically secure random bytes. Supplied by the platform CSPRNG. */
export type EntropySource = (byteLength: number) => Uint8Array;

/** A hash of a string, as lowercase hex. SHA-256 in every current adapter. */
export type Digest = (input: string) => string;

/**
 * The three primitives travelled together often enough to be worth naming.
 * Passed explicitly rather than made ambient, so a test can pin all three.
 */
export interface Platform {
  readonly clock: Clock;
  readonly entropy: EntropySource;
  readonly digest: Digest;
}

/**
 * A nominal type tag.
 *
 * Every identifier in CareerForge is a 26-character ULID string, and the
 * provenance graph passes them constantly between evidence, work units,
 * claims, and assets. Without branding, handing a `WorkUnitId` to something
 * expecting an `EvidenceId` type-checks perfectly and produces a dangling
 * edge that nothing detects until a user asks why a bullet cites nothing.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };
