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

import { parseNamespacedModelName } from "../data/namespace.ts";
import {
  dataAccessorAlternation,
  extractExpressions,
} from "./expression_parser.ts";

/**
 * Type of model reference in an expression.
 */
export type DependencyType =
  | "input"
  | "resource"
  | "data"
  | "file"
  | "execution"
  | "definition";

/**
 * Artifact types that create implicit workflow dependencies.
 */
export const ArtifactDependencyTypes: readonly DependencyType[] = [
  "resource",
  "data",
  "file",
] as const;

/**
 * Represents a dependency extracted from an expression.
 */
export interface ExpressionDependency {
  /** The model reference (name or UUID) */
  modelRef: string;
  /** Whether the dependency is on input or resource data */
  type: DependencyType;
}

/**
 * Pattern to match model references in CEL expressions.
 * Matches: model.<name-or-uuid>.(input|resource|file|execution|definition)
 */
const MODEL_REF_PATTERN =
  /model\.([a-zA-Z0-9_-]+)\.(input|resource|file|execution|definition)/g;

/**
 * Pattern to match data function calls whose first argument names a model.
 * Matches: data.version('model', 'data', N), data.latest('model', 'data'), data.listVersions('model', 'data')
 *
 * This list is deliberately NARROWER than DATA_NAMESPACE_ACCESSORS and
 * must not be "fixed" to match it. The capture group takes the first quoted
 * argument as a model name, which is what mints a dependency edge. That is
 * true of version, latest, listVersions and findBySpec; it is false of query,
 * whose first argument is a predicate, and of findByTag, whose first argument
 * is a tag key. Adding either would extract a predicate string as if it were a
 * model name.
 *
 * The consequence is real and is documented for users in the workflow
 * data-chaining reference: a step reading data with `query` gets no implicit
 * ordering, so it needs an explicit `dependsOn` where a `latest` call would
 * not have.
 */
const DATA_FUNCTION_PATTERN =
  /data\.(version|latest|listVersions|findBySpec)\s*\(\s*['"]([^'"]+)['"]/g;

/**
 * Pattern to match file.contents() calls in CEL expressions.
 * Matches: file.contents('model', 'spec')
 */
const FILE_CONTENTS_PATTERN = /file\.contents\s*\(\s*['"]([^'"]+)['"]/g;

/**
 * Pattern to match model.method() calls in CEL expressions.
 * Matches: model.method('modelName', 'methodName') or model.method("modelName", "methodName", inputs)
 */
const MODEL_METHOD_PATTERN = /model\.method\s*\(\s*['"]([^'"]+)['"]/g;

/**
 * Extracts model dependencies from a CEL expression.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of dependencies found in the expression
 */
export function extractDependencies(
  expression: string,
): ExpressionDependency[] {
  const dependencies: ExpressionDependency[] = [];
  const seen = new Set<string>();

  const matches = expression.matchAll(MODEL_REF_PATTERN);
  for (const match of matches) {
    const modelRef = match[1];
    const type = match[2] as DependencyType;
    const key = `${modelRef}:${type}`;

    // Deduplicate
    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type });
    }
  }

  return dependencies;
}

/**
 * Extracts all model references from a CEL expression (both input and resource).
 * Also extracts model references from data function calls.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of unique model references
 */
export function extractModelRefs(expression: string): string[] {
  const refs = new Set<string>();

  // Extract from model.X.property patterns
  const modelMatches = expression.matchAll(MODEL_REF_PATTERN);
  for (const match of modelMatches) {
    refs.add(match[1]);
  }

  // Extract from data.version('model', ...), data.latest('model', ...), etc.
  // Strip namespace prefix ("ns:model" → "model", "*:model" → "model")
  const dataMatches = expression.matchAll(DATA_FUNCTION_PATTERN);
  for (const match of dataMatches) {
    const parsed = parseNamespacedModelName(match[2]);
    refs.add(parsed.modelName);
  }

  // Extract from file.contents('model', ...)
  const fileContentsMatches = expression.matchAll(FILE_CONTENTS_PATTERN);
  for (const match of fileContentsMatches) {
    refs.add(match[1]);
  }

  // Extract from model.method('model', ...)
  const methodMatches = expression.matchAll(MODEL_METHOD_PATTERN);
  for (const match of methodMatches) {
    refs.add(match[1]);
  }

  return [...refs];
}

/**
 * Checks if an expression has any artifact dependencies (resource, file).
 * Artifact dependencies create implicit workflow step dependencies.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression references any model artifacts
 */
export function hasArtifactDependency(expression: string): boolean {
  return /model\.[a-zA-Z0-9_-]+\.(resource|file)/.test(expression);
}

/**
 * Checks if an expression has any resource dependencies.
 * Resource dependencies create implicit workflow step dependencies.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression references any model resources
 */
export function hasResourceDependency(expression: string): boolean {
  return /model\.[a-zA-Z0-9_-]+\.resource/.test(expression);
}

/**
 * Extracts all artifact dependencies from a CEL expression.
 * These create implicit workflow step dependencies.
 * Includes both model.X.resource/file patterns and data.version/latest/listVersions function calls.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of dependencies with artifact types (resource, data, file)
 */
export function extractArtifactDependencies(
  expression: string,
): ExpressionDependency[] {
  const dependencies: ExpressionDependency[] = [];
  const seen = new Set<string>();

  // Extract from model.X.property patterns
  const pattern = /model\.([a-zA-Z0-9_-]+)\.(resource|file)/g;
  const matches = expression.matchAll(pattern);
  for (const match of matches) {
    const modelRef = match[1];
    const type = match[2] as DependencyType;
    const key = `${modelRef}:${type}`;

    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type });
    }
  }

  // Extract from data function calls (all data functions create data dependencies)
  // Strip namespace prefix ("ns:model" → "model")
  const dataMatches = expression.matchAll(DATA_FUNCTION_PATTERN);
  for (const match of dataMatches) {
    const parsed = parseNamespacedModelName(match[2]);
    const modelRef = parsed.modelName;
    const key = `${modelRef}:data`;

    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type: "data" });
    }
  }

  // Extract from file.contents() calls (create file dependencies)
  const fileContentsMatches = expression.matchAll(FILE_CONTENTS_PATTERN);
  for (const match of fileContentsMatches) {
    const modelRef = match[1];
    const key = `${modelRef}:file`;

    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type: "file" });
    }
  }

  return dependencies;
}

/**
 * Extracts only resource dependencies from a CEL expression.
 * These create implicit workflow step dependencies.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of model references that have resource dependencies
 */
export function extractResourceDependencies(expression: string): string[] {
  const refs = new Set<string>();

  const matches = expression.matchAll(/model\.([a-zA-Z0-9_-]+)\.resource/g);
  for (const match of matches) {
    refs.add(match[1]);
  }

  return [...refs];
}

/**
 * Checks if an expression contains a self-reference.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression references 'self'
 */
export function hasSelfReference(expression: string): boolean {
  return /\bself\b/.test(expression);
}

/**
 * Extracts model references from data function calls.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of model references from data.version/latest/listVersions calls
 */
export function extractDataFunctionDependencies(expression: string): string[] {
  const refs = new Set<string>();

  const dataMatches = expression.matchAll(DATA_FUNCTION_PATTERN);
  for (const match of dataMatches) {
    const parsed = parseNamespacedModelName(match[2]);
    refs.add(parsed.modelName);
  }

  return [...refs];
}

/**
 * Checks if an expression has any data function calls.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression contains any data.* function call
 */
export function hasDataFunctionDependency(expression: string): boolean {
  // Derived from DATA_NAMESPACE_ACCESSORS rather than restated, so this cannot
  // drift the way the validator's copy did.
  //
  // Note for anyone reading this as the live detection path: it is not one.
  // This function has no caller outside its own tests, and neither does
  // extractDataFunctionDependencies below. Dependency edges are minted by
  // extractDependencies, which uses the narrower DATA_FUNCTION_PATTERN. The
  // rebuild here is hygiene — a stale copy left behind is how the next drift
  // starts — not a behaviour fix.
  return new RegExp(`data\\.(${dataAccessorAlternation()})\\s*\\(`)
    .test(expression);
}

/**
 * Extracts model references from file.contents() calls.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of model references from file.contents() calls
 */
export function extractFileContentsDependencies(
  expression: string,
): string[] {
  const refs = new Set<string>();

  const matches = expression.matchAll(FILE_CONTENTS_PATTERN);
  for (const match of matches) {
    refs.add(match[1]);
  }

  return [...refs];
}

/**
 * Checks if an expression has any file.contents() calls.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression contains file.contents()
 */
export function hasFileContentsDependency(expression: string): boolean {
  return /file\.contents\s*\(/.test(expression);
}

/**
 * Checks if an expression has any execution dependencies.
 * Execution dependencies reference model.*.execution.* patterns.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression references any model execution data
 */
export function hasExecutionDependency(expression: string): boolean {
  return /model\.[a-zA-Z0-9_-]+\.execution/.test(expression);
}

/**
 * Checks if an expression depends on step outputs (artifacts, execution, data functions, or file contents).
 * These dependencies cannot be resolved before the producing step runs.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression depends on any step output
 */
export function hasStepOutputDependency(expression: string): boolean {
  return hasArtifactDependency(expression) ||
    hasExecutionDependency(expression) ||
    hasDataFunctionDependency(expression) ||
    hasFileContentsDependency(expression);
}

/**
 * Pattern to match any read of the model or file namespace, covering dotted
 * access (`model.name.resource`), bracket access (`model["name"].file`),
 * the namespace functions (`file.contents(...)`, `model.method(...)`), and
 * the namespace used as a bare value (`has(model)`, `size(file)`).
 *
 * The leading lookbehind rejects a property that merely shares the name —
 * `inputs.model` and `data.model.x` read something else entirely — while the
 * trailing word boundary rejects longer identifiers like `model_name`.
 */
const MODEL_NAMESPACE_PATTERN = /(?<![.\w])(?:model|file)\b/;

/**
 * Checks whether any expression in the given data reads the model or file
 * namespace, and therefore needs a full expression context built from every
 * model definition. Expressions that only touch inputs, env, self, steps or
 * data can be evaluated against a lightweight context instead.
 *
 * Deliberately broad: a false positive only costs the definition scan that
 * would have happened anyway, while a false negative would evaluate a model
 * reference against an empty namespace.
 *
 * @param data - Arbitrary data (a definition or workflow) to inspect
 * @returns True if a full model context is required
 */
export function requiresModelNamespace(data: unknown): boolean {
  return extractExpressions(data).some((expression) =>
    MODEL_NAMESPACE_PATTERN.test(expression.celExpression)
  );
}
