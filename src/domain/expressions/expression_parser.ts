// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import type { ExpressionLocation } from "./expression.ts";

/**
 * Pattern to match ${{ ... }} expressions.
 * Captures the inner CEL expression.
 */
const EXPRESSION_PATTERN = /\$\{\{\s*(.+?)\s*\}\}/g;

/**
 * Transforms model references with hyphenated names to bracket notation.
 *
 * CEL interprets hyphens as subtraction operators, so `model.deploy-vpc.resource`
 * would be parsed as `(model.deploy) - (vpc.resource)`. This function transforms
 * hyphenated model names to bracket notation:
 *   model.deploy-vpc.resource → model["deploy-vpc"].resource
 *
 * @param expression - The CEL expression to transform
 * @returns The expression with hyphenated model names using bracket notation
 */
export function transformHyphenatedModelRefs(expression: string): string {
  // Pattern matches: model.<name-with-hyphens>.(input|resource|file|execution|definition)
  // The name must contain at least one hyphen to need transformation
  return expression.replace(
    /model\.([a-zA-Z0-9_]+(?:-[a-zA-Z0-9_-]+)+)\.(input|resource|file|execution|definition)/g,
    'model["$1"].$2',
  );
}

/**
 * Checks if a string contains any expressions.
 */
export function containsExpression(value: string): boolean {
  return /\$\{\{.+?\}\}/.test(value);
}

/**
 * Checks if a value is or contains an expression.
 * Works recursively for arrays and objects.
 */
export function valueContainsExpression(value: unknown): boolean {
  if (typeof value === "string") {
    return containsExpression(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsExpression(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((v) => valueContainsExpression(v));
  }
  return false;
}

/**
 * Strips fields that contain expressions from an object.
 * Used for schema validation where we want to validate static values
 * but skip expression-containing fields (which will be validated after evaluation).
 *
 * @param data - The data structure to process
 * @returns A new object with expression-containing fields removed
 */
export function stripExpressionFields<T extends Record<string, unknown>>(
  data: T,
): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!valueContainsExpression(value)) {
      result[key as keyof T] = value as T[keyof T];
    }
  }
  return result;
}

/**
 * Extracts all expression locations from a nested data structure.
 *
 * @param data - The data structure to search (object, array, or primitive)
 * @param basePath - The base path for nested locations (default: "")
 * @returns Array of expression locations found in the data
 */
export function extractExpressions(
  data: unknown,
  basePath = "",
): ExpressionLocation[] {
  const locations: ExpressionLocation[] = [];
  extractExpressionsRecursive(data, basePath, locations);
  return locations;
}

function extractExpressionsRecursive(
  data: unknown,
  path: string,
  locations: ExpressionLocation[],
): void {
  if (typeof data === "string") {
    // Check for expressions in string values
    const matches = data.matchAll(EXPRESSION_PATTERN);
    for (const match of matches) {
      locations.push({
        path,
        raw: match[0],
        celExpression: match[1].trim(),
      });
    }
  } else if (Array.isArray(data)) {
    // Recursively process array elements
    for (let i = 0; i < data.length; i++) {
      const itemPath = path ? `${path}[${i}]` : `[${i}]`;
      extractExpressionsRecursive(data[i], itemPath, locations);
    }
  } else if (data !== null && typeof data === "object") {
    // Recursively process object properties
    for (const [key, value] of Object.entries(data)) {
      const propPath = path ? `${path}.${key}` : key;
      extractExpressionsRecursive(value, propPath, locations);
    }
  }
  // Primitives other than strings are ignored
}

/**
 * Replaces expressions in a data structure with evaluated values.
 *
 * @param data - The data structure to process
 * @param values - Map of expression raw strings to their evaluated values
 * @returns A new data structure with expressions replaced
 */
export function replaceExpressions(
  data: unknown,
  values: Map<string, unknown>,
): unknown {
  return replaceExpressionsRecursive(data, values);
}

function replaceExpressionsRecursive(
  data: unknown,
  values: Map<string, unknown>,
): unknown {
  if (typeof data === "string") {
    // Check if the entire string is a single expression
    const singleMatch = data.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
    if (singleMatch) {
      // Return the evaluated value directly (preserves type)
      const evaluated = values.get(data);
      return evaluated !== undefined ? evaluated : data;
    }

    // Replace inline expressions within a larger string
    if (containsExpression(data)) {
      let result = data;
      for (const [rawExpr, value] of values) {
        if (result.includes(rawExpr)) {
          // Convert value to string for inline replacement
          // JSON stringify arrays/objects to preserve structure
          let stringValue: string;
          if (value === null || value === undefined) {
            stringValue = "";
          } else if (typeof value === "object") {
            stringValue = JSON.stringify(value, null, 2);
          } else {
            stringValue = String(value);
          }
          result = result.split(rawExpr).join(stringValue);
        }
      }
      return result;
    }

    return data;
  } else if (Array.isArray(data)) {
    return data.map((item) => replaceExpressionsRecursive(item, values));
  } else if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = replaceExpressionsRecursive(value, values);
    }
    return result;
  }

  return data;
}

/**
 * Extracts the CEL expression from a raw expression string.
 *
 * @param raw - The raw expression string (e.g., "${{ model.foo.input }}")
 * @returns The CEL expression (e.g., "model.foo.input") or null if not valid
 */
export function extractCelExpression(raw: string): string | null {
  const match = raw.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  return match ? match[1].trim() : null;
}

/**
 * Checks if an expression path is within a step's task.inputs.
 * These paths contain `.task.inputs.` or `.task.inputs[`.
 *
 * @param path - The expression path (e.g., "jobs[0].steps[1].task.inputs.vpc_id")
 * @returns True if the path is within a step's task.inputs
 */
export function isTaskInputsPath(path: string): boolean {
  return path.includes(".task.inputs.") || path.includes(".task.inputs[");
}

/**
 * Pattern to match `inputs.fieldName` (dot notation) in CEL expressions.
 * Uses negative lookbehind to exclude cross-model references like `model.foo.input.bar`.
 */
const INPUTS_DOT_PATTERN = /(?<!\.)inputs\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Pattern to match `inputs["field-name"]` (bracket notation) in CEL expressions.
 * Uses negative lookbehind to exclude cross-model references.
 */
const INPUTS_BRACKET_PATTERN = /(?<!\.)inputs\["([^"]+)"\]/g;

/**
 * Extracts input field names referenced in a single CEL expression string.
 * Handles both dot notation (`inputs.fieldName`) and bracket notation
 * (`inputs["field-name"]`). Excludes cross-model references.
 *
 * @param celExpression - The raw CEL expression (without `${{ }}` wrapper)
 * @returns Set of unique input field names referenced
 */
export function extractInputReferencesFromCel(
  celExpression: string,
): Set<string> {
  const inputNames = new Set<string>();
  for (const match of celExpression.matchAll(INPUTS_DOT_PATTERN)) {
    inputNames.add(match[1]);
  }
  for (const match of celExpression.matchAll(INPUTS_BRACKET_PATTERN)) {
    inputNames.add(match[1]);
  }
  return inputNames;
}

/**
 * Scans a data structure for `${{ ... }}` expressions and returns the unique
 * set of `inputs.*` field names referenced. Handles both CEL syntaxes:
 * - Dot notation: `inputs.fieldName`
 * - Bracket notation: `inputs["field-name"]` (for hyphenated names)
 *
 * Excludes cross-model references like `model.foo.input.bar`.
 *
 * @param data - The data structure to scan (object, array, or primitive)
 * @returns Set of unique input field names referenced
 */
export function extractInputReferences(data: unknown): Set<string> {
  const expressions = extractExpressions(data);
  const inputNames = new Set<string>();

  for (const expr of expressions) {
    const refs = extractInputReferencesFromCel(expr.celExpression);
    for (const name of refs) {
      inputNames.add(name);
    }
  }

  return inputNames;
}
