// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { DependencyType } from "./dependency_extractor.ts";

/**
 * Represents a full path reference extracted from an expression.
 */
export interface ExpressionPathReference {
  /** The model reference (name or UUID) */
  modelRef: string;
  /** The artifact type (input, resource, file, execution, definition) */
  type: DependencyType;
  /** The path segments after the artifact type (e.g., ["vpc", "attributes", "VpcId"]) */
  path: string[];
  /** The full path string (e.g., "resource.attributes.VpcId") */
  fullPath: string;
  /** The raw expression that was matched (e.g., "model.my-vpc.resource.attributes.VpcId") */
  rawExpression: string;
}

/**
 * Pattern to match model references with full paths in CEL expressions.
 * Matches: model.<name-or-uuid>.(input|resource|file|execution|definition)(.<property>|[<index>])*
 *
 * Group 1: model name or UUID
 * Group 2: artifact type
 * Group 3: remaining path (property accesses and array indices)
 */
const MODEL_PATH_PATTERN =
  /model\.([a-zA-Z0-9_-]+)\.(input|resource|file|execution|definition)((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g;

/**
 * Pattern to match self references with full paths.
 * Matches: self(.<property>|[<index>])*
 *
 * Group 1: remaining path (property accesses and array indices)
 */
const SELF_PATH_PATTERN = /\bself((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g;

/**
 * Pattern to match env references with full paths.
 * Matches: env.<variable_name>
 *
 * Group 1: variable name (allows underscores, letters, digits)
 */
const ENV_PATH_PATTERN = /\benv\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

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
 * Represents an environment variable reference extracted from an expression.
 */
export interface EnvPathReference {
  /** The environment variable name */
  variableName: string;
  /** The raw expression that was matched (e.g., "env.HOME") */
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

/**
 * Extracts environment variable references from a CEL expression.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of env references found in the expression
 */
export function extractEnvReferences(
  expression: string,
): EnvPathReference[] {
  const references: EnvPathReference[] = [];
  const seen = new Set<string>();

  const matches = expression.matchAll(ENV_PATH_PATTERN);
  for (const match of matches) {
    const variableName = match[1];
    const rawExpression = match[0];

    // Deduplicate based on raw expression
    if (!seen.has(rawExpression)) {
      seen.add(rawExpression);
      references.push({
        variableName,
        rawExpression,
      });
    }
  }

  return references;
}
