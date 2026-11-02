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
import { wordedText, wordedUserError } from "../behavior_wording.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PARTIAL_ID_PATTERN = /^[0-9a-f-]{3,}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isPartialId(value: string): boolean {
  return PARTIAL_ID_PATTERN.test(value);
}

export interface PartialIdMatch<T> {
  match: T;
  id: string;
}

export type PartialIdResult<T> =
  | { status: "found"; match: T }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: PartialIdMatch<T>[] };

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

  // ids are not unique (a copied file keeps its id), so a caller passing the
  // name it authorized gets that definition by name, accepted only if it still
  // has this id; otherwise null
  if (expectedName !== undefined) {
    const byName = await findByNameFromIndex(definitionRepo, expectedName);
    return byName?.definition.id === definitionId
      ? { definition: byName.definition, type: byName.type }
      : null;
  }

  // A definition just found by name is usually cached: one read, no scan of
  // the type directories that come before it in registry order.
  const cached = await definitionRepo.findByIdCached?.(definitionId);
  if (cached) return cached;

  // the index holds every definition of every type, so its miss is final
  const indexed = await definitionRepo.findByIdFromIndex?.(definitionId);
  if (indexed !== undefined) return indexed;

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

  // a definition of an unregistered type is still found by name via a disk
  // walk, so walk for the id too, auto-definitions included
  if (definitionRepo.findByIdGlobal) {
    return await definitionRepo.findByIdGlobal(definitionId);
  }
  const all = await definitionRepo.findAllGlobal();
  return all.find((entry) => entry.definition.id === definitionId) ?? null;
}

/**
 * ids are not unique (a copied file keeps its id) and outputs and data are
 * stored by definition id, so each match owns what is stored under it
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

export async function findDefinitionByIdOrName(
  definitionRepo: DefinitionRepository,
  idOrName: string,
  findByName: (
    name: string,
  ) => Promise<DefinitionLookupResult | null> = (name) =>
    // a UUID is almost always an id, so its name lookup must not walk
    isUuid(name)
      ? findByNameFromIndex(definitionRepo, name)
      : definitionRepo.findByNameGlobal(name),
): Promise<DefinitionLookupResult | null> {
  const byName = await findByName(idOrName);
  if (byName) {
    return { definition: byName.definition, type: byName.type };
  }

  // a non-UUID string can never match by id, and checking would parse every
  // definition once per type; partial ids live in matchByPartialId()
  if (!isUuid(idOrName)) {
    return null;
  }
  return findDefinitionByIdGlobal(definitionRepo, idOrName);
}

function findByNameFromIndex(
  definitionRepo: DefinitionRepository,
  name: string,
): Promise<DefinitionLookupResult | null> {
  return definitionRepo.findByNameGlobalFromIndex
    ? definitionRepo.findByNameGlobalFromIndex(name)
    : definitionRepo.findByNameGlobal(name);
}

export function createModelReferenceResolver(
  definitionRepo: DefinitionRepository,
): (idOrName: string) => Promise<{ modelType: string; modelId: string }> {
  return async (idOrName) => {
    const found = await findDefinitionByIdOrName(definitionRepo, idOrName);
    if (!found) {
      throw wordedUserError(
        wordedText((w) => `${w.Noun} not found: ${idOrName}`),
      );
    }
    return { modelType: found.type.normalized, modelId: found.definition.id };
  };
}
