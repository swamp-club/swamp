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
import { maskLiteralCalls } from "./cel_string_lexer.ts";

// Every extractor below reads CEL through maskLiteralCalls first: the text a
// literal('...') call passes through is not a reference, so
// literal('{{model.a.resource.b}}') mints no dependency.

export type DependencyType =
  | "input"
  | "resource"
  | "data"
  | "file"
  | "execution"
  | "definition";

export const ArtifactDependencyTypes: readonly DependencyType[] = [
  "resource",
  "data",
  "file",
] as const;

export interface ExpressionDependency {
  modelRef: string;
  type: DependencyType;
}

const MODEL_REF_PATTERN =
  /model\.([a-zA-Z0-9_-]+)\.(input|resource|file|execution|definition)/g;

/**
 * deliberately narrower than DATA_NAMESPACE_ACCESSORS: query's first argument
 * is a predicate and findByTag's a tag key, not a model name, so a query step
 * needs an explicit dependsOn
 */
const DATA_FUNCTION_PATTERN =
  /data\.(version|latest|listVersions|findBySpec)\s*\(\s*['"]([^'"]+)['"]/g;

const FILE_CONTENTS_PATTERN = /file\.contents\s*\(\s*['"]([^'"]+)['"]/g;

const MODEL_METHOD_PATTERN = /model\.method\s*\(\s*['"]([^'"]+)['"]/g;

export function extractDependencies(
  expression: string,
): ExpressionDependency[] {
  const cel = maskLiteralCalls(expression);
  const dependencies: ExpressionDependency[] = [];
  const seen = new Set<string>();

  const matches = cel.matchAll(MODEL_REF_PATTERN);
  for (const match of matches) {
    const modelRef = match[1];
    const type = match[2] as DependencyType;
    const key = `${modelRef}:${type}`;

    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type });
    }
  }

  return dependencies;
}

export function extractModelRefs(expression: string): string[] {
  const cel = maskLiteralCalls(expression);
  const refs = new Set<string>();

  const modelMatches = cel.matchAll(MODEL_REF_PATTERN);
  for (const match of modelMatches) {
    refs.add(match[1]);
  }

  // Extract from data.version('model', ...), data.latest('model', ...), etc.
  // Strip namespace prefix ("ns:model" → "model", "*:model" → "model")
  const dataMatches = cel.matchAll(DATA_FUNCTION_PATTERN);
  for (const match of dataMatches) {
    const parsed = parseNamespacedModelName(match[2]);
    refs.add(parsed.modelName);
  }

  const fileContentsMatches = cel.matchAll(FILE_CONTENTS_PATTERN);
  for (const match of fileContentsMatches) {
    refs.add(match[1]);
  }

  const methodMatches = cel.matchAll(MODEL_METHOD_PATTERN);
  for (const match of methodMatches) {
    refs.add(match[1]);
  }

  return [...refs];
}

export function hasArtifactDependency(expression: string): boolean {
  const cel = maskLiteralCalls(expression);
  return /model\.[a-zA-Z0-9_-]+\.(resource|file)/.test(cel);
}

export function hasResourceDependency(expression: string): boolean {
  const cel = maskLiteralCalls(expression);
  return /model\.[a-zA-Z0-9_-]+\.resource/.test(cel);
}

export function extractArtifactDependencies(
  expression: string,
): ExpressionDependency[] {
  const cel = maskLiteralCalls(expression);
  const dependencies: ExpressionDependency[] = [];
  const seen = new Set<string>();

  const pattern = /model\.([a-zA-Z0-9_-]+)\.(resource|file)/g;
  const matches = cel.matchAll(pattern);
  for (const match of matches) {
    const modelRef = match[1];
    const type = match[2] as DependencyType;
    const key = `${modelRef}:${type}`;

    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type });
    }
  }

  const dataMatches = cel.matchAll(DATA_FUNCTION_PATTERN);
  for (const match of dataMatches) {
    const parsed = parseNamespacedModelName(match[2]);
    const modelRef = parsed.modelName;
    const key = `${modelRef}:data`;

    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type: "data" });
    }
  }

  const fileContentsMatches = cel.matchAll(FILE_CONTENTS_PATTERN);
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

export function extractResourceDependencies(expression: string): string[] {
  const cel = maskLiteralCalls(expression);
  const refs = new Set<string>();

  const matches = cel.matchAll(/model\.([a-zA-Z0-9_-]+)\.resource/g);
  for (const match of matches) {
    refs.add(match[1]);
  }

  return [...refs];
}

export function hasSelfReference(expression: string): boolean {
  const cel = maskLiteralCalls(expression);
  return /\bself\b/.test(cel);
}

export function extractDataFunctionDependencies(expression: string): string[] {
  const cel = maskLiteralCalls(expression);
  const refs = new Set<string>();

  const dataMatches = cel.matchAll(DATA_FUNCTION_PATTERN);
  for (const match of dataMatches) {
    const parsed = parseNamespacedModelName(match[2]);
    refs.add(parsed.modelName);
  }

  return [...refs];
}

export function extractOwnNamespaceDataModelNames(
  expression: string,
): string[] {
  const cel = maskLiteralCalls(expression);
  const names = new Set<string>();
  for (const match of cel.matchAll(DATA_FUNCTION_PATTERN)) {
    const parsed = parseNamespacedModelName(match[2]);
    if (parsed.namespace === undefined) names.add(parsed.modelName);
  }
  return [...names];
}

export function hasDataFunctionDependency(expression: string): boolean {
  const cel = maskLiteralCalls(expression);
  // derived from DATA_NAMESPACE_ACCESSORS so it cannot drift; not the live
  // detection path: edges are minted by extractDependencies with the narrower
  // DATA_FUNCTION_PATTERN
  return new RegExp(`data\\.(${dataAccessorAlternation()})\\s*\\(`)
    .test(cel);
}

export function extractFileContentsDependencies(
  expression: string,
): string[] {
  const cel = maskLiteralCalls(expression);
  const refs = new Set<string>();

  const matches = cel.matchAll(FILE_CONTENTS_PATTERN);
  for (const match of matches) {
    refs.add(match[1]);
  }

  return [...refs];
}

export function hasFileContentsDependency(expression: string): boolean {
  const cel = maskLiteralCalls(expression);
  return /file\.contents\s*\(/.test(cel);
}

export function hasExecutionDependency(expression: string): boolean {
  const cel = maskLiteralCalls(expression);
  return /model\.[a-zA-Z0-9_-]+\.execution/.test(cel);
}

export function hasStepOutputDependency(expression: string): boolean {
  return hasArtifactDependency(expression) ||
    hasExecutionDependency(expression) ||
    hasDataFunctionDependency(expression) ||
    hasFileContentsDependency(expression);
}

/**
 * the lookbehind rejects a property that merely shares the name (inputs.model,
 * data.model.x); the trailing word boundary rejects longer identifiers like
 * model_name
 */
const MODEL_NAMESPACE_PATTERN = /(?<![.\w])(?:model|file)\b/;

/**
 * deliberately broad: a false positive only costs a definition scan that would
 * have happened anyway, while a false negative would evaluate a model reference
 * against an empty namespace
 */
export function requiresModelNamespace(data: unknown): boolean {
  return extractExpressions(data).some((expression) =>
    MODEL_NAMESPACE_PATTERN.test(maskLiteralCalls(expression.celExpression))
  );
}

/** anchored so inputs.steps and longer identifiers like steps_total do not match */
const STEPS_NAMESPACE_PATTERN = /(?<![.\w])steps\b/;

/**
 * the namespace exists only once the run does, so it resolves at step execution
 * time; it is not a step-output dependency, as the step-time passes resolve it
 * synchronously from the context
 */
export function hasStepsNamespaceReference(expression: string): boolean {
  const cel = maskLiteralCalls(expression);
  return STEPS_NAMESPACE_PATTERN.test(cel);
}
