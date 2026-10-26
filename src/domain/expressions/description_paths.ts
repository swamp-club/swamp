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

import { keyPath } from "./provenance_map.ts";

/** Description annotations of the input schemas, never their default values. */
export function inputDescriptionPaths(schema: unknown): Set<string> {
  const paths = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.description === "string") {
      paths.add(keyPath(path, "description"));
    }
    const properties = node.properties;
    if (properties && typeof properties === "object") {
      for (const [name, property] of Object.entries(properties)) {
        visit(property, keyPath(keyPath(path, "properties"), name));
      }
    }
    for (const keyword of ["items", "additionalProperties"]) {
      visit(node[keyword], keyPath(path, keyword));
    }
  };
  visit(schema, "inputs");
  // Input validation also accepts a flat map of named property schemas.
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const root = schema as Record<string, unknown>;
    if (root.properties === undefined && root.type !== "object") {
      for (const [name, property] of Object.entries(root)) {
        visit(property, keyPath("inputs", name));
      }
    }
  }
  return paths;
}

/**
 * Whether a path in a definition's data is prose a run never evaluates: the
 * definition's description or a description annotation of its input schema.
 * Text there may document expression syntax. Schema defaults are values the
 * run delivers, so a description key inside one is not prose.
 */
export function definitionDescriptionPaths(
  definition: { inputs?: unknown },
): (path: string) => boolean {
  const inputDescriptions = inputDescriptionPaths(definition.inputs);
  return (path) => path === "description" || inputDescriptions.has(path);
}
