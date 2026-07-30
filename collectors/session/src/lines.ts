import { createReadStream } from 'node:fs';

/**
 * A bounded-memory reader for newline-delimited JSON.
 *
 * The measured corpus is 351 MB across 1,214 files, and the largest single
 * file is 32 MB. `readFileSync` would work today and fail on a heavy user's
 * machine later, which is the worst possible failure mode: it appears only for
 * the people with the most career history to lose.
 *
 * Bounded means bounded by the longest *line*, not by the file, and even that
 * is capped — a single absurd line is dropped rather than buffered, so no
 * input shape can make this allocate without limit.
 *
 * Splitting on the newline byte is safe for UTF-8: 0x0A cannot occur inside a
 * multi-byte sequence, so a line boundary is never in the middle of a
 * character. Decoding happens per line, after the split.
 */

/** 8 MB. Far above any legitimate record; far below a memory problem. */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export type JsonLine =
  | { readonly ok: true; readonly number: number; readonly value: unknown }
  | { readonly ok: false; readonly number: number; readonly reason: LineFailure };

export type LineFailure = 'invalid json' | 'line too long';

export interface ReadOptions {
  readonly maxLineBytes?: number;
  /**
   * Called with every byte read, in order.
   *
   * Lets a caller hash exactly what was parsed rather than re-reading the file
   * to hash it. Those differ when the file is being appended to while it is
   * read, which for a live session file is the normal case, not an edge one.
   */
  readonly onBytes?: (chunk: Buffer) => void;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function decode(parts: readonly Buffer[], length: number): string {
  const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
  // Trim a trailing CR so CRLF files parse identically to LF files. Windows
  // writes them, and git can introduce them on checkout.
  const end =
    line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN ? line.length - 1 : line.length;
  return line.toString('utf8', 0, end);
}

function parse(text: string, number: number): JsonLine | null {
  if (text.trim() === '') return null;
  try {
    return { ok: true, number, value: JSON.parse(text) };
  } catch {
    // One bad line is a skip, never a failed session (ADR-0010). A truncated
    // final line — the file that was being written when we opened it — lands
    // here, which is exactly right: it is unreadable now and complete later.
    return { ok: false, number, reason: 'invalid json' };
  }
}

export async function* readJsonLines(
  path: string,
  options: ReadOptions = {},
): AsyncIterable<JsonLine> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

  const stream = createReadStream(path);

  let parts: Buffer[] = [];
  let pending = 0;
  let number = 0;
  /** Set once a line exceeds the cap: discard bytes until the next newline. */
  let overlong = false;

  const takeLine = (): JsonLine | null => {
    number++;
    if (overlong) {
      parts = [];
      pending = 0;
      overlong = false;
      return { ok: false, number, reason: 'line too long' };
    }
    const text = decode(parts, pending);
    parts = [];
    pending = 0;
    return parse(text, number);
  };

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    options.onBytes?.(chunk);

    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== NEWLINE) continue;

      if (!overlong) {
        const slice = chunk.subarray(start, i);
        parts.push(slice);
        pending += slice.length;
      }
      start = i + 1;

      const line = takeLine();
      if (line !== null) yield line;
    }

    if (start < chunk.length && !overlong) {
      const rest = chunk.subarray(start);
      parts.push(rest);
      pending += rest.length;
      if (pending > maxLineBytes) {
        // Drop what has accumulated and stop collecting until the line ends.
        // Holding it to report a longer excerpt would be paying the memory
        // cost this cap exists to avoid.
        parts = [];
        pending = 0;
        overlong = true;
      }
    }
  }

  // A final line with no trailing newline. Common: the file is still being
  // written to by a session that has not finished.
  if (parts.length > 0 || overlong) {
    const line = takeLine();
    if (line !== null) yield line;
  }
}
