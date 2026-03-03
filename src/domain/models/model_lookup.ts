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

import type { ModelType } from "./model_type.ts";
import { modelRegistry } from "./model.ts";
import type { Definition, DefinitionId } from "../definitions/definition.ts";
import { createDefinitionId } from "../definitions/definition.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

/**
 * UUID v4 regex pattern for detecting if an argument is a UUID.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Partial ID pattern - at least 3 hex characters (with optional dashes).
 * Used for Docker-style partial ID matching.
 */
const PARTIAL_ID_PATTERN = /^[0-9a-f-]{3,}$/i;

/**
 * Checks if a string looks like a UUID v4.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Checks if a value could be a partial ID (3+ hex chars) or a full UUID.
 * This is used for Docker-style partial ID matching.
 */
export function isPartialId(value: string): boolean {
  return PARTIAL_ID_PATTERN.test(value);
}

/**
 * Result of a partial ID lookup when the match is found.
 */
export interface PartialIdMatch<T> {
  match: T;
  id: string;
}

/**
 * Result type for partial ID matching.
 */
export type PartialIdResult<T> =
  | { status: "found"; match: T }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: PartialIdMatch<T>[] };

/**
 * Matches items by partial ID prefix (Docker-style).
 *
 * Normalizes both the partial ID and item IDs by removing dashes and
 * converting to lowercase before matching.
 *
 * @param items - Array of items with their IDs
 * @param partialId - The partial ID to match against
 * @returns The match result: found, not_found, or ambiguous
 */
export function matchByPartialId<T>(
  items: Array<{ id: string; item: T }>,
  partialId: string,
): PartialIdResult<T> {
  const normalizedPartial = partialId.toLowerCase().replace(/-/g, "");
  const matches = items.filter(({ id }) =>
    id.toLowerCase().replace(/-/g, "").startsWith(normalizedPartial)
  );

  if (matches.length === 0) {
    return { status: "not_found" };
  }
  if (matches.length === 1) {
    return { status: "found", match: matches[0].item };
  }
  return {
    status: "ambiguous",
    matches: matches.map((m) => ({ match: m.item, id: m.id })),
  };
}

/**
 * Result of a global definition lookup.
 */
export interface DefinitionLookupResult {
  definition: Definition;
  type: ModelType;
}

/**
 * Finds a definition by ID, searching across all registered model types.
 */
export async function findDefinitionByIdGlobal(
  definitionRepo: YamlDefinitionRepository,
  id: string,
): Promise<DefinitionLookupResult | null> {
  const definitionId = createDefinitionId(id) as DefinitionId;

  for (const type of modelRegistry.types()) {
    const definition = await definitionRepo.findById(type, definitionId);
    if (definition) {
      return { definition, type };
    }
  }

  return null;
}

/**
 * Finds a definition by ID or name, searching across all registered model types.
 * Tries name lookup first (most common in workflows), then falls back to ID.
 */
export async function findDefinitionByIdOrName(
  definitionRepo: YamlDefinitionRepository,
  idOrName: string,
): Promise<DefinitionLookupResult | null> {
  // Try by name first (most common case in workflows)
  const byName = await definitionRepo.findByNameGlobal(idOrName);
  if (byName) {
    return { definition: byName.definition, type: byName.type };
  }

  // Fall back to ID lookup
  return findDefinitionByIdGlobal(definitionRepo, idOrName);
}
