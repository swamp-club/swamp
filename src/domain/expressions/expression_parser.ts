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
  // Pattern matches: model.<name-with-hyphens>.(input|resource|data|file|log|execution)
  // The name must contain at least one hyphen to need transformation
  return expression.replace(
    /model\.([a-zA-Z0-9_]+(?:-[a-zA-Z0-9_-]+)+)\.(input|resource|data|file|log|execution)/g,
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
          const stringValue = value === null || value === undefined
            ? ""
            : String(value);
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
