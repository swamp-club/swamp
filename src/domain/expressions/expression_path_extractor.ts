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

import type { DependencyType } from "./dependency_extractor.ts";
import { maskLiteralCalls } from "./cel_string_lexer.ts";

export interface ExpressionPathReference {
  modelRef: string;
  type: DependencyType;
  path: string[];
  fullPath: string;
  rawExpression: string;
}

const MODEL_PATH_PATTERN =
  /model\.([a-zA-Z0-9_-]+)\.(input|resource|file|execution|definition)((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g;

const SELF_PATH_PATTERN = /\bself((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g;

const ENV_PATH_PATTERN = /\benv\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

export interface SelfPathReference {
  path: string[];
  fullPath: string;
  rawExpression: string;
}

export interface EnvPathReference {
  variableName: string;
  rawExpression: string;
}

function parsePathSegments(pathStr: string): string[] {
  if (!pathStr) return [];

  const segments: string[] = [];
  const segmentPattern = /\.([a-zA-Z0-9_]+)|\[(\d+)\]/g;
  let match;

  while ((match = segmentPattern.exec(pathStr)) !== null) {
    if (match[1] !== undefined) {
      segments.push(match[1]);
    } else if (match[2] !== undefined) {
      segments.push(match[2]);
    }
  }

  return segments;
}

export function extractPathReferences(
  expression: string,
): ExpressionPathReference[] {
  const references: ExpressionPathReference[] = [];
  const seen = new Set<string>();

  // A literal() argument is text, never a reference.
  const matches = maskLiteralCalls(expression).matchAll(MODEL_PATH_PATTERN);
  for (const match of matches) {
    const modelRef = match[1];
    const type = match[2] as DependencyType;
    const remainingPath = match[3] || "";

    const path = parsePathSegments(remainingPath);
    const fullPath = type + remainingPath;
    const rawExpression = match[0];

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

export function extractSelfReferences(
  expression: string,
): SelfPathReference[] {
  const references: SelfPathReference[] = [];
  const seen = new Set<string>();

  // A literal() argument is text, never a reference.
  const matches = maskLiteralCalls(expression).matchAll(SELF_PATH_PATTERN);
  for (const match of matches) {
    const remainingPath = match[1] || "";
    const path = parsePathSegments(remainingPath);
    const fullPath = remainingPath.startsWith(".")
      ? remainingPath.slice(1)
      : remainingPath;
    const rawExpression = match[0];

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

export function extractEnvReferences(
  expression: string,
): EnvPathReference[] {
  const references: EnvPathReference[] = [];
  const seen = new Set<string>();

  // A literal() argument is text, never a reference.
  const matches = maskLiteralCalls(expression).matchAll(ENV_PATH_PATTERN);
  for (const match of matches) {
    const variableName = match[1];
    const rawExpression = match[0];

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
