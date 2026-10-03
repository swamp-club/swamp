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

import { ModelType } from "./model_type.ts";
import { modelRegistry } from "./model.ts";
import type { Definition, DefinitionId } from "../definitions/definition.ts";
import { createDefinitionId } from "../definitions/definition.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { UserError } from "../errors.ts";

/**
 * UUID regex pattern for detecting if an argument is a UUID (versions 1-8).
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Partial ID pattern - at least 3 hex characters (with optional dashes).
 * Used for Docker-style partial ID matching.
 */
const PARTIAL_ID_PATTERN = /^[0-9a-f-]{3,}$/i;

/**
 * Checks if a string looks like a UUID.
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
 *
 * Definition ids are UUIDs, so a non-UUID string returns null at once rather
 * than scanning every definition of every registered type to prove it.
 */
export async function findDefinitionByIdGlobal(
  definitionRepo: DefinitionRepository,
  id: string,
  expectedName?: string,
): Promise<DefinitionLookupResult | null> {
  if (!isUuid(id)) return null;
  const definitionId = createDefinitionId(id) as DefinitionId;

  // A caller acting on a definition it authorized passes the name it
  // authorized. Ids are not guaranteed unique — a copied file keeps its id —
  // so find it the way authorization did, by that name, and accept it only
  // if it still has this id. Otherwise the authorized definition is gone.
  if (expectedName !== undefined) {
    const byName = await definitionRepo.findByNameGlobal(expectedName);
    return byName?.definition.id === definitionId
      ? { definition: byName.definition, type: byName.type }
      : null;
  }

  // A definition just found by name is usually cached: one read, no scan of
  // the type directories that come before it in registry order.
  const cached = await definitionRepo.findByIdCached?.(definitionId);
  if (cached) return cached;

  for (const type of modelRegistry.types()) {
    const definition = await definitionRepo.findById(type, definitionId);
    if (definition) {
      // Report the type the file declares, as a lookup by name does, so a
      // caller that authorizes by name and acts by id sees one type even if
      // the file sits in another type's directory.
      return {
        definition,
        type: definition.type ? ModelType.create(definition.type) : type,
      };
    }
  }

  // A definition whose type is not registered — an uninstalled extension's,
  // say — is still found by name through a walk of the definitions on disk.
  // Walk them for the id too, auto-definitions included, so a lookup by id
  // finds every definition a lookup by name finds.
  if (definitionRepo.findByIdGlobal) {
    return await definitionRepo.findByIdGlobal(definitionId);
  }
  const all = await definitionRepo.findAllGlobal();
  return all.find((entry) => entry.definition.id === definitionId) ?? null;
}

/**
 * Finds every definition that declares `id`, across all types and
 * auto-definitions, registered or not. Ids are not guaranteed unique — a
 * copied file keeps its id — and outputs and data are stored by definition
 * id, so each of these owns what is stored under it.
 */
export async function findDefinitionsByIdGlobal(
  definitionRepo: DefinitionRepository,
  id: string,
): Promise<DefinitionLookupResult[]> {
  if (!isUuid(id)) return [];
  const definitionId = createDefinitionId(id) as DefinitionId;
  if (definitionRepo.findAllByIdGlobal) {
    return await definitionRepo.findAllByIdGlobal(definitionId);
  }
  const all = await definitionRepo.findAllGlobal();
  return all.filter((entry) => entry.definition.id === definitionId);
}

/**
 * Finds a definition by ID or name, searching across all registered model types.
 * Tries name lookup first (most common in workflows), then falls back to ID.
 */
export async function findDefinitionByIdOrName(
  definitionRepo: DefinitionRepository,
  idOrName: string,
): Promise<DefinitionLookupResult | null> {
  // Try by name first (most common case in workflows)
  const byName = await definitionRepo.findByNameGlobal(idOrName);
  if (byName) {
    return { definition: byName.definition, type: byName.type };
  }

  // Fall back to ID lookup. findDefinitionByIdGlobal compares IDs with strict
  // equality, so a non-UUID string can never match — and reaching it parses
  // every definition in the repo once per registered type to prove that.
  // Partial/prefix ID matching lives in matchByPartialId(), not here.
  if (!isUuid(idOrName)) {
    return null;
  }
  return findDefinitionByIdGlobal(definitionRepo, idOrName);
}

/**
 * Resolves a `model("<name or id>")` data query call as `swamp data get
 * <model>` resolves its model argument: by definition name, then exact id.
 * Throws a UserError when no definition matches.
 */
export function createModelReferenceResolver(
  definitionRepo: DefinitionRepository,
): (idOrName: string) => Promise<{ modelType: string; modelId: string }> {
  return async (idOrName) => {
    const found = await findDefinitionByIdOrName(definitionRepo, idOrName);
    if (!found) throw new UserError(`Model not found: ${idOrName}`);
    return { modelType: found.type.normalized, modelId: found.definition.id };
  };
}
