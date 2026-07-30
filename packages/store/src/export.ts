import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

import type { Db } from './migrations/index.js';
import { LATEST_SCHEMA_VERSION } from './migrations/index.js';

/**
 * The durable, human-readable representation of the store.
 *
 * SQLite is canonical (ADR-0003); this tree is what makes that acceptable
 * (ADR-0004). It is diffable, greppable, syncable, and — through `rebuild` —
 * sufficient to reconstruct the database completely. That guarantee is what
 * turns SQLite from a jail into an index.
 *
 * Two properties are load-bearing and are asserted in CI:
 *
 *   Determinism  the same store always produces byte-identical output
 *   Fidelity     export -> rebuild -> export is byte-identical
 *
 * The export is the *whole append-only log*, not current state. Superseded
 * records and tombstones are all present, because rebuilding current state
 * requires the history that produced it.
 */

/**
 * Versioned separately from the database schema, and deliberately far more
 * stable. The database may be refactored freely; this is a long-term contract
 * with the user.
 */
export const EXPORT_FORMAT_VERSION = 1;

const MANIFEST = 'manifest.json';

/**
 * Serialise with keys sorted at every level.
 *
 * `JSON.stringify` preserves insertion order, which would make the bytes
 * depend on the order a row's columns happened to be read. Sorting makes the
 * output a function of the data alone — the precondition for both properties
 * above, and for a sync target seeing no churn when nothing changed.
 */
export function canonicalJson(value: unknown): string {
  const normalise = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(normalise);
    const source = input as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = normalise(source[key]);
    return sorted;
  };
  return `${JSON.stringify(normalise(value), null, 2)}\n`;
}

export interface ExportReport {
  readonly root: string;
  readonly formatVersion: number;
  readonly counts: Readonly<Record<string, number>>;
  /** Files actually written. Unchanged records are skipped. */
  readonly written: number;
  /** Digest over every exported file. Changes if and only if content changes. */
  readonly digest: string;
}

interface EvidenceExportRow {
  id: string;
  schema_version: number;
  collector_id: string;
  source_uri: string;
  natural_key: string;
  content_hash: string;
  kind: string;
  evidence_class: string;
  sensitivity: string;
  subject_id: string;
  asserted_by: string;
  occurred_at: string;
  occurred_end: string | null;
  recorded_at: string;
  project_key: string | null;
  workspace: string | null;
  stream: string | null;
  grouping_hint: string | null;
  supersedes: string | null;
  collector_version: string;
  source_format_version: string | null;
  title: string | null;
  summary: string | null;
  excerpt: string | null;
  payload_ref: string | null;
  attributes: string | null;
}

/** Year/month partitioning, so a decade is not one unmanageable directory. */
function partitionFor(occurredAt: string): string {
  return join(occurredAt.slice(0, 4), occurredAt.slice(5, 7));
}

function evidenceDocument(row: EvidenceExportRow): unknown {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    collectorId: row.collector_id,
    collectorVersion: row.collector_version,
    sourceUri: row.source_uri,
    sourceFormatVersion: row.source_format_version,
    naturalKey: row.natural_key,
    contentHash: row.content_hash,
    kind: row.kind,
    evidenceClass: row.evidence_class,
    sensitivity: row.sensitivity,
    subjectId: row.subject_id,
    assertedBy: row.asserted_by,
    occurredAt: row.occurred_at,
    occurredEnd: row.occurred_end,
    recordedAt: row.recorded_at,
    context: {
      projectKey: row.project_key,
      workspace: row.workspace,
      stream: row.stream,
    },
    groupingHint: row.grouping_hint,
    supersedes: row.supersedes,
    // Null when redaction or purge destroyed the body (ADR-0015). The spine
    // survives, so the export still records that something was collected.
    content:
      row.title === null
        ? null
        : {
            title: row.title,
            summary: row.summary,
            excerpt: row.excerpt,
            payloadRef: row.payload_ref,
            attributes: JSON.parse(row.attributes ?? '{}') as unknown,
          },
  };
}

/** Write only when content differs, so a sync target sees no churn. */
function writeIfChanged(path: string, contents: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) return false;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return true;
}

function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * A digest over the whole tree.
 *
 * Path separators are normalised to POSIX so the digest is identical on
 * Windows and Linux — otherwise a store synced between two machines would
 * appear to differ when nothing had changed.
 */
export function digestTree(root: string, exclude: readonly string[] = [MANIFEST]): string {
  const excluded = new Set(exclude.map((name) => join(root, name)));
  const lines = listFiles(root)
    .filter((file) => !excluded.has(file))
    .map((file) => {
      const rel = relative(root, file).split(sep).join(posix.sep);
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
      return `${rel}:${hash}`;
    });
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Write the store to a plain-file tree.
 *
 * Deliberately contains no generation timestamp. A timestamp would make two
 * exports of the same data differ, which would defeat both determinism and
 * the round-trip invariant, and would make every sync push a change.
 */
export function exportStore(db: Db, root: string): ExportReport {
  mkdirSync(root, { recursive: true });
  let written = 0;

  const evidenceRows = db
    .prepare(
      `SELECT e.*, c.title, c.summary, c.excerpt, c.payload_ref, c.attributes
       FROM evidence e
       LEFT JOIN evidence_content c ON c.evidence_id = e.id
       ORDER BY e.id ASC`,
    )
    .all() as EvidenceExportRow[];

  for (const row of evidenceRows) {
    const path = join(root, 'evidence', partitionFor(row.occurred_at), `${row.id}.json`);
    if (writeIfChanged(path, canonicalJson(evidenceDocument(row)))) written++;
  }

  const tombstones = db.prepare(`SELECT * FROM tombstones ORDER BY id ASC`).all() as {
    id: string;
    target_kind: string;
    target_id: string;
    reason: string | null;
    scope: string;
    recorded_at: string;
  }[];
  for (const row of tombstones) {
    const document = {
      id: row.id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      reason: row.reason,
      scope: row.scope,
      recordedAt: row.recorded_at,
    };
    if (writeIfChanged(join(root, 'tombstones', `${row.id}.json`), canonicalJson(document)))
      written++;
  }

  const identities = db.prepare(`SELECT * FROM identities ORDER BY id ASC`).all() as {
    id: string;
    display_name: string;
    is_owner: number;
    recorded_at: string;
  }[];
  for (const row of identities) {
    const document = {
      id: row.id,
      displayName: row.display_name,
      isOwner: row.is_owner === 1,
      recordedAt: row.recorded_at,
    };
    if (writeIfChanged(join(root, 'identities', `${row.id}.json`), canonicalJson(document)))
      written++;
  }

  const counts = {
    evidence: evidenceRows.length,
    tombstones: tombstones.length,
    identities: identities.length,
  };

  const digest = digestTree(root);
  const manifest = {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: LATEST_SCHEMA_VERSION,
    counts,
    digest,
  };
  if (writeIfChanged(join(root, MANIFEST), canonicalJson(manifest))) written++;

  return { root, formatVersion: EXPORT_FORMAT_VERSION, counts, written, digest };
}

export class ExportFormatTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `This export was written in format v${found}; this build understands v${supported}. Upgrade CareerForge before rebuilding from it.`,
    );
    this.name = 'ExportFormatTooNewError';
  }
}

export interface RebuildReport {
  readonly counts: Readonly<Record<string, number>>;
  readonly digest: string;
}

interface EvidenceDocument {
  id: string;
  schemaVersion: number;
  collectorId: string;
  collectorVersion: string;
  sourceUri: string;
  sourceFormatVersion: string | null;
  naturalKey: string;
  contentHash: string;
  kind: string;
  evidenceClass: string;
  sensitivity: string;
  subjectId: string;
  assertedBy: string;
  occurredAt: string;
  occurredEnd: string | null;
  recordedAt: string;
  context: { projectKey: string | null; workspace: string | null; stream: string | null };
  groupingHint: string | null;
  supersedes: string | null;
  content: {
    title: string;
    summary: string | null;
    excerpt: string | null;
    payloadRef: string | null;
    attributes: unknown;
  } | null;
}

/**
 * Reconstruct the database from an export tree.
 *
 * The command that makes ADR-0003 safe: if the database is corrupted,
 * superseded, or abandoned, no career history is lost. Everything is inserted
 * with its original identifiers, hashes, and lineage, so the rebuilt store is
 * the same log — not a re-derivation of it.
 *
 * The target database must be empty. Merging two logs is sync, which is a
 * different and much harder problem (ADR-0004), and silently half-merging
 * here would be the worst possible way to discover that.
 */
export function rebuildStore(db: Db, root: string): RebuildReport {
  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`No export manifest at ${manifestPath}. Is this an export directory?`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    exportFormatVersion: number;
    counts: Record<string, number>;
    digest: string;
  };
  if (manifest.exportFormatVersion > EXPORT_FORMAT_VERSION) {
    throw new ExportFormatTooNewError(manifest.exportFormatVersion, EXPORT_FORMAT_VERSION);
  }

  const actualDigest = digestTree(root);
  if (actualDigest !== manifest.digest) {
    throw new Error(
      `Export is inconsistent with its manifest (expected digest ${manifest.digest}, computed ${actualDigest}). ` +
        'Some files were modified or lost. Rebuilding from it could produce a store that does not match what was exported.',
    );
  }

  const existing = (db.prepare(`SELECT COUNT(*) AS n FROM evidence`).get() as { n: number }).n;
  if (existing > 0) {
    throw new Error(
      `Refusing to rebuild into a database that already holds ${existing} evidence records. ` +
        'Rebuild targets an empty store; merging two logs is sync, not rebuild.',
    );
  }

  const read = <T>(dir: string): T[] =>
    listFiles(join(root, dir)).map((file) => JSON.parse(readFileSync(file, 'utf8')) as T);

  const identities = read<{
    id: string;
    displayName: string;
    isOwner: boolean;
    recordedAt: string;
  }>('identities');
  const evidence = read<EvidenceDocument>('evidence');
  const tombstones = read<{
    id: string;
    targetKind: string;
    targetId: string;
    reason: string | null;
    scope: string;
    recordedAt: string;
  }>('tombstones');

  const load = db.transaction(() => {
    const insertIdentity = db.prepare(
      `INSERT OR REPLACE INTO identities (id, display_name, is_owner, recorded_at) VALUES (?,?,?,?)`,
    );
    for (const identity of identities) {
      insertIdentity.run(
        identity.id,
        identity.displayName,
        identity.isOwner ? 1 : 0,
        identity.recordedAt,
      );
    }

    // Ordered by id so a record's predecessor is always present before the
    // record that supersedes it — ULIDs sort by creation, which is exactly
    // the ordering foreign keys need.
    const insertEvidence = db.prepare(
      `INSERT INTO evidence (
         id, schema_version, collector_id, source_uri, natural_key, content_hash,
         kind, evidence_class, sensitivity, subject_id, asserted_by,
         occurred_at, occurred_end, recorded_at,
         project_key, workspace, stream, grouping_hint, supersedes,
         collector_version, source_format_version
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertContent = db.prepare(
      `INSERT INTO evidence_content (evidence_id, title, summary, excerpt, payload_ref, attributes)
       VALUES (?,?,?,?,?,?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO evidence_fts (evidence_id, title, summary, excerpt) VALUES (?,?,?,?)`,
    );

    for (const document of [...evidence].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      insertEvidence.run(
        document.id,
        document.schemaVersion,
        document.collectorId,
        document.sourceUri,
        document.naturalKey,
        document.contentHash,
        document.kind,
        document.evidenceClass,
        document.sensitivity,
        document.subjectId,
        document.assertedBy,
        document.occurredAt,
        document.occurredEnd,
        document.recordedAt,
        document.context.projectKey,
        document.context.workspace,
        document.context.stream,
        document.groupingHint,
        document.supersedes,
        document.collectorVersion,
        document.sourceFormatVersion,
      );
      if (document.content !== null) {
        insertContent.run(
          document.id,
          document.content.title,
          document.content.summary,
          document.content.excerpt,
          document.content.payloadRef,
          JSON.stringify(document.content.attributes),
        );
        insertFts.run(
          document.id,
          document.content.title,
          document.content.summary ?? '',
          document.content.excerpt ?? '',
        );
      }
    }

    const insertTombstone = db.prepare(
      `INSERT INTO tombstones (id, target_kind, target_id, reason, scope, recorded_at)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const tombstone of tombstones) {
      insertTombstone.run(
        tombstone.id,
        tombstone.targetKind,
        tombstone.targetId,
        tombstone.reason,
        tombstone.scope,
        tombstone.recordedAt,
      );
    }
  });

  load();

  return {
    counts: {
      evidence: evidence.length,
      tombstones: tombstones.length,
      identities: identities.length,
    },
    digest: manifest.digest,
  };
}
