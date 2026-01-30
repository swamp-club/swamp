import type { DependencyType } from "./dependency_extractor.ts";

/**
 * Represents a full path reference extracted from an expression.
 */
export interface ExpressionPathReference {
  /** The model reference (name or UUID) */
  modelRef: string;
  /** The artifact type (input, resource, data, file, log, execution) */
  type: DependencyType;
  /** The path segments after the artifact type (e.g., ["attributes", "VpcId"]) */
  path: string[];
  /** The full path string (e.g., "resource.attributes.VpcId") */
  fullPath: string;
  /** The raw expression that was matched (e.g., "model.my-vpc.resource.attributes.VpcId") */
  rawExpression: string;
}

/**
 * Pattern to match model references with full paths in CEL expressions.
 * Matches: model.<name-or-uuid>.(input|resource|data|file|log|execution)(.<property>|[<index>])*
 *
 * Group 1: model name or UUID
 * Group 2: artifact type
 * Group 3: remaining path (property accesses and array indices)
 */
const MODEL_PATH_PATTERN =
  /model\.([a-zA-Z0-9_-]+)\.(input|resource|data|file|log|execution)((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g;

/**
 * Pattern to match self references with full paths.
 * Matches: self(.<property>|[<index>])*
 *
 * Group 1: remaining path (property accesses and array indices)
 */
const SELF_PATH_PATTERN = /\bself((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g;

/**
 * Represents a self-reference path extracted from an expression.
 */
export interface SelfPathReference {
  /** The path segments after self (e.g., ["attributes", "VpcId"]) */
  path: string[];
  /** The full path string (e.g., "attributes.VpcId") */
  fullPath: string;
  /** The raw expression that was matched (e.g., "self.attributes.VpcId") */
  rawExpression: string;
}

/**
 * Parses a path string into segments, handling both dot notation and array indices.
 *
 * @param pathStr - The path string to parse (e.g., ".attributes.Tags[0].Key")
 * @returns Array of path segments
 */
function parsePathSegments(pathStr: string): string[] {
  if (!pathStr) return [];

  const segments: string[] = [];
  // Match either .propertyName or [index]
  const segmentPattern = /\.([a-zA-Z0-9_]+)|\[(\d+)\]/g;
  let match;

  while ((match = segmentPattern.exec(pathStr)) !== null) {
    if (match[1] !== undefined) {
      // Property access (e.g., .attributes)
      segments.push(match[1]);
    } else if (match[2] !== undefined) {
      // Array index (e.g., [0])
      segments.push(match[2]);
    }
  }

  return segments;
}

/**
 * Extracts full path references from a CEL expression.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of path references found in the expression
 */
export function extractPathReferences(
  expression: string,
): ExpressionPathReference[] {
  const references: ExpressionPathReference[] = [];
  const seen = new Set<string>();

  const matches = expression.matchAll(MODEL_PATH_PATTERN);
  for (const match of matches) {
    const modelRef = match[1];
    const type = match[2] as DependencyType;
    const remainingPath = match[3] || "";

    const path = parsePathSegments(remainingPath);
    const fullPath = type + remainingPath;
    const rawExpression = match[0];

    // Deduplicate based on raw expression
    if (!seen.has(rawExpression)) {
      seen.add(rawExpression);
      references.push({
        modelRef,
        type,
        path,
        fullPath,
        rawExpression,
      });
    }
  }

  return references;
}

/**
 * Extracts self-reference paths from a CEL expression.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of self-references found in the expression
 */
export function extractSelfReferences(
  expression: string,
): SelfPathReference[] {
  const references: SelfPathReference[] = [];
  const seen = new Set<string>();

  const matches = expression.matchAll(SELF_PATH_PATTERN);
  for (const match of matches) {
    const remainingPath = match[1] || "";
    const path = parsePathSegments(remainingPath);
    const fullPath = remainingPath.startsWith(".")
      ? remainingPath.slice(1)
      : remainingPath;
    const rawExpression = match[0];

    // Deduplicate based on raw expression
    if (!seen.has(rawExpression)) {
      seen.add(rawExpression);
      references.push({
        path,
        fullPath,
        rawExpression,
      });
    }
  }

  return references;
}
