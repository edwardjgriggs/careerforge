import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Content-addressed blob storage, outside the database.
 *
 * One measured source produces roughly 4 GB a year (see
 * `docs/PreArchitecture-Findings.md` §1.5), so raw payloads never enter
 * SQLite. Evidence stores a hash, a source reference, and a bounded excerpt;
 * the bytes live here, and can be pruned without losing anything the store
 * depends on.
 *
 * Addressing by content buys deduplication for free — the same file collected
 * from two repositories is stored once — and makes re-enrichment against a
 * newer model verifiable, because the input can be proven unchanged.
 */

const ALGORITHM = 'sha256';
const REF_PREFIX = `blob:${ALGORITHM}-`;

export type BlobRef = string;

export function isBlobRef(value: string): boolean {
  return value.startsWith(REF_PREFIX) && /^[0-9a-f]{64}$/.test(value.slice(REF_PREFIX.length));
}

export function refToHash(ref: BlobRef): string {
  if (!isBlobRef(ref)) throw new Error(`Not a blob reference: ${JSON.stringify(ref)}`);
  return ref.slice(REF_PREFIX.length);
}

export function hashToRef(hash: string): BlobRef {
  return `${REF_PREFIX}${hash}`;
}

export class BlobStore {
  constructor(private readonly root: string) {}

  /**
   * Two levels of two hex characters, then the full hash.
   *
   * A flat directory of hundreds of thousands of files is slow to list on
   * every filesystem and pathological on some. Sharding keeps any single
   * directory small.
   */
  private pathFor(hash: string): string {
    return join(this.root, ALGORITHM, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  /** Store bytes and return their reference. Writing the same bytes twice is a no-op. */
  put(content: Uint8Array | string): BlobRef {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const hash = createHash(ALGORITHM).update(bytes).digest('hex');
    const target = this.pathFor(hash);

    if (!existsSync(target)) {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, bytes);
    }
    return hashToRef(hash);
  }

  get(ref: BlobRef): Buffer | null {
    const target = this.pathFor(refToHash(ref));
    return existsSync(target) ? readFileSync(target) : null;
  }

  has(ref: BlobRef): boolean {
    return existsSync(this.pathFor(refToHash(ref)));
  }

  size(ref: BlobRef): number | null {
    const target = this.pathFor(refToHash(ref));
    return existsSync(target) ? statSync(target).size : null;
  }

  /**
   * Remove a blob.
   *
   * Safe to call even when evidence still references it: the reference stays
   * valid as a statement about what was collected, and `get` returning null
   * means "pruned", not "corrupt". This is what makes blobs genuinely
   * prunable without touching the canonical store.
   */
  prune(ref: BlobRef): boolean {
    const target = this.pathFor(refToHash(ref));
    if (!existsSync(target)) return false;
    rmSync(target);
    return true;
  }
}
