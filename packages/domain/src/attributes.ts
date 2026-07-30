import { isInstant, type Instant } from './time.js';

/**
 * Collector-defined evidence attributes.
 *
 * Deliberately a narrow value space: scalars, instants, and string arrays.
 * Nested objects are rejected outright — they cannot be indexed, cannot be
 * aggregated for analytics, and become a private format nobody else can
 * consume. An attribute bag that accepts anything is a dumping ground, and
 * a dumping ground is where a schema goes to stop being a schema.
 */

export const ATTRIBUTE_TYPES = ['string', 'number', 'boolean', 'instant', 'string[]'] as const;

export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export type AttributeValue = string | number | boolean | Instant | readonly string[];

export type AttributeMap = Readonly<Record<string, AttributeValue>>;

export interface AttributeSpec {
  readonly type: AttributeType;
  /** Human-readable purpose. Surfaced to plugin authors and in the UI. */
  readonly description: string;
  readonly required?: boolean;
}

export type AttributeSchema = Readonly<Record<string, AttributeSpec>>;

export type AttributeIssueCode =
  | 'missing_required'
  | 'undeclared_attribute'
  | 'wrong_type'
  | 'nested_object'
  | 'non_finite_number'
  | 'invalid_instant'
  | 'non_string_array_member';

export interface AttributeIssue {
  readonly key: string;
  readonly code: AttributeIssueCode;
  readonly message: string;
}

export type AttributeValidation =
  { readonly valid: true } | { readonly valid: false; readonly issues: readonly AttributeIssue[] };

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkValue(key: string, spec: AttributeSpec, value: unknown): AttributeIssue | null {
  // Checked before the type switch: a nested object is the specific mistake
  // worth naming, and reporting it as a generic type error would send an
  // author looking in the wrong place.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return {
      key,
      code: 'nested_object',
      message: `Attribute "${key}" is an object. Attributes must be scalars, instants, or string arrays — flatten it or move the detail into the excerpt.`,
    };
  }

  switch (spec.type) {
    case 'string':
      return typeof value === 'string'
        ? null
        : {
            key,
            code: 'wrong_type',
            message: `Attribute "${key}" must be a string, got ${describe(value)}.`,
          };

    case 'number':
      if (typeof value !== 'number') {
        return {
          key,
          code: 'wrong_type',
          message: `Attribute "${key}" must be a number, got ${describe(value)}.`,
        };
      }
      return Number.isFinite(value)
        ? null
        : {
            key,
            code: 'non_finite_number',
            message: `Attribute "${key}" must be finite; NaN and Infinity cannot be stored or compared.`,
          };

    case 'boolean':
      return typeof value === 'boolean'
        ? null
        : {
            key,
            code: 'wrong_type',
            message: `Attribute "${key}" must be a boolean, got ${describe(value)}.`,
          };

    case 'instant':
      if (typeof value !== 'string') {
        return {
          key,
          code: 'wrong_type',
          message: `Attribute "${key}" must be an instant string, got ${describe(value)}.`,
        };
      }
      return isInstant(value)
        ? null
        : {
            key,
            code: 'invalid_instant',
            message: `Attribute "${key}" must be ISO-8601 UTC with millisecond precision, got ${JSON.stringify(value)}.`,
          };

    case 'string[]':
      if (!Array.isArray(value)) {
        return {
          key,
          code: 'wrong_type',
          message: `Attribute "${key}" must be an array of strings, got ${describe(value)}.`,
        };
      }
      return value.every((member) => typeof member === 'string')
        ? null
        : {
            key,
            code: 'non_string_array_member',
            message: `Attribute "${key}" must contain only strings.`,
          };
  }
}

/**
 * Validate an attribute bag against a collector's declared schema.
 *
 * Undeclared attributes are an error rather than a warning. A collector's
 * manifest is a promise about what it emits; silently accepting extras means
 * the manifest stops describing reality, and manifest honesty is one of the
 * things every collector is conformance-tested on.
 */
export function validateAttributes(
  schema: AttributeSchema,
  values: AttributeMap,
): AttributeValidation {
  const issues: AttributeIssue[] = [];

  for (const [key, spec] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(values, key);
    if (!present) {
      if (spec.required === true) {
        issues.push({
          key,
          code: 'missing_required',
          message: `Attribute "${key}" is required by the collector's declared schema.`,
        });
      }
      continue;
    }
    const issue = checkValue(key, spec, values[key]);
    if (issue !== null) issues.push(issue);
  }

  for (const key of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      issues.push({
        key,
        code: 'undeclared_attribute',
        message: `Attribute "${key}" is not declared in the collector's schema. Declare it or drop it.`,
      });
    }
  }

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}
