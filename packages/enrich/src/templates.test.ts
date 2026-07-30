import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ENRICHMENT_TYPES } from '@careerforge/domain';

import {
  CURRENT_TEMPLATE,
  ENRICHABLE_TYPES,
  resolveTemplate,
  TEMPLATES,
  templateFor,
  templateHash,
  type PromptTemplate,
} from './templates.js';

/**
 * Prompts are versioned artifacts.
 *
 * The lockfile below is the mechanism. Editing a published template changes
 * its hash, the hash no longer matches the lock, and the build fails — which
 * is the point. A prompt that can be edited in place makes every run record
 * that references it a lie, because the text it names is no longer the text
 * that ran.
 *
 * To change behaviour, add a version. Regenerating the lock is deliberately a
 * separate, explicit act (`npm run lock:prompts`).
 */

const LOCK_PATH = fileURLToPath(new URL('./templates.lock.json', import.meta.url));
const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

const readLock = (): Record<string, string> =>
  JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Record<string, string>;

const all = Object.values(TEMPLATES);

/** The object schema each returned item must satisfy. */
function itemSchema(template: PromptTemplate): { required?: string[] } {
  const properties = template.schema['properties'] as Record<string, { items?: unknown }>;
  const only = Object.values(properties)[0];
  return (only?.items ?? {}) as { required?: string[] };
}

describe('published templates are frozen', () => {
  it('matches the committed lockfile', () => {
    const lock = readLock();
    const actual = Object.fromEntries(all.map((t) => [t.id, templateHash(t, sha256)]));

    if (process.env['UPDATE_PROMPT_LOCK'] === '1') {
      writeFileSync(LOCK_PATH, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }

    // If this fails you have edited a published prompt. That is not a lint
    // failure to silence: every enrichment run in every user's store already
    // names this template id and claims this text produced it. Add a new
    // version instead.
    expect(actual).toEqual(lock);
  });

  it('locks every template, and nothing that no longer exists', () => {
    expect(Object.keys(readLock()).sort()).toEqual(all.map((t) => t.id).sort());
  });

  it('hashes what changes the output, and not the name', () => {
    const base = all[0]!;
    const renamed: PromptTemplate = { ...base, id: 'renamed@9' };
    expect(templateHash(renamed, sha256)).toBe(templateHash(base, sha256));

    const reworded: PromptTemplate = { ...base, instructions: `${base.instructions} Also this.` };
    expect(templateHash(reworded, sha256)).not.toBe(templateHash(base, sha256));

    // Temperature changes what comes back, so it is part of the artifact.
    const hotter: PromptTemplate = { ...base, params: { ...base.params, temperature: 0.9 } };
    expect(templateHash(hotter, sha256)).not.toBe(templateHash(base, sha256));
  });

  it('is stable across key ordering, so a reformat is not a rewrite', () => {
    const base = all[0]!;
    const shuffled = {
      params: base.params,
      schemaName: base.schemaName,
      instructions: base.instructions,
      schema: base.schema,
      enrichmentType: base.enrichmentType,
      id: base.id,
    } as PromptTemplate;
    expect(templateHash(shuffled, sha256)).toBe(templateHash(base, sha256));
  });
});

describe('every template obeys the rules the domain already enforces', () => {
  it.each(all)('$id interpolates nothing', (template) => {
    // A template that interpolates is a template that could carry evidence
    // past the choke point in the instructions channel. The transport guard
    // catches secrets; this catches the design mistake that leads to them.
    expect(template.instructions).not.toMatch(/\$\{|%s|\{\{/);
  });

  it.each(all)('$id tells the model to cite its inputs', (template) => {
    expect(template.instructions).toMatch(/cite/i);
    // Saying it in prose is not enough — the schema must require it, so an
    // item without a citation is a schema violation at the provider rather
    // than a judgement call here.
    expect(itemSchema(template).required).toContain('evidence');
  });

  it.each(all)('$id forbids inventing a number', (template) => {
    // The claim predicate refuses a model-sourced metric anyway. Saying it in
    // the prompt means the model is not asked to produce something that will
    // be thrown away.
    expect(template.instructions).toMatch(/never state a quantity/i);
  });

  it.each(all)('$id refuses to infer leadership', (template) => {
    expect(template.instructions).toMatch(/\b(leadership|seniority|ownership)\b/i);
  });

  it.each(all)('$id permits an empty answer', (template) => {
    // Without this a model invents rather than return nothing, and the most
    // common honest answer for a small work unit is nothing.
    expect(template.instructions).toMatch(/empty list is a valid/i);
  });

  it.each(all)('$id samples deterministically', (template) => {
    expect(template.params.temperature).toBe(0);
  });

  it.each(all)('$id has a version in its identity', (template) => {
    expect(template.id).toMatch(/^[a-z_]+@\d+$/);
  });
});

describe('resolution', () => {
  it('resolves a template by its versioned id, forever', () => {
    // A run recorded years ago names an id. If that stops resolving, the run
    // stops being reconstructible, which is the whole point of the record.
    expect(resolveTemplate('skills@1')?.enrichmentType).toBe('skills');
  });

  it('returns null for an unknown id rather than guessing a nearby version', () => {
    expect(resolveTemplate('skills@99')).toBeNull();
  });

  it('points each enrichable type at a template that exists', () => {
    for (const type of ENRICHABLE_TYPES) {
      expect(templateFor(type), `no template for ${type}`).not.toBeNull();
    }
  });

  it('only claims types the domain knows about', () => {
    for (const type of Object.keys(CURRENT_TEMPLATE)) {
      expect(ENRICHMENT_TYPES).toContain(type);
    }
  });

  it('has no template for the types M9 deliberately left alone', () => {
    // impact, leadership, keywords, and summary are named in the domain but
    // unimplemented. Shipping a weak prompt for `leadership` would be worse
    // than shipping none: it is the claim type most likely to end a career.
    expect(templateFor('leadership')).toBeNull();
  });
});
