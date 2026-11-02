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

import type { ModelType } from "../models/model_type.ts";
import type { Definition, DefinitionId } from "./definition.ts";

/**
 * finds definitions declaring an id without reading every definition on each
 * request; answers as findAllIncludingAutoGlobal filtered by id would when the
 * view began
 */
export interface DefinitionOwnerIndex {
  begin(signal?: AbortSignal): Promise<DefinitionOwnerView>;
}

// not an executable definition, so an index may keep it between requests
export interface DefinitionOwner {
  definition: Pick<Definition, "id" | "name" | "tags">;
  type: ModelType;
}

export interface DefinitionOwnerView {
  /**
   * Every definition declaring `id`, each as its file declares it now, primary
   * definitions first, in the order a scan of every definition reads them.
   */
  findAllById(id: DefinitionId): Promise<DefinitionOwner[]>;
}

export interface DefinitionRepository {
  findById(type: ModelType, id: DefinitionId): Promise<Definition | null>;

  findAll(type: ModelType): Promise<Definition[]>;

  findByName(type: ModelType, name: string): Promise<Definition | null>;

  findByNameGlobal(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null>;

  findAllGlobal(): Promise<{ definition: Definition; type: ModelType }[]>;

  /**
   * optional: without it, a lookup by id only searches the registered types and
   * the primary definitions
   */
  findByIdGlobal?(
    id: DefinitionId,
  ): Promise<{ definition: Definition; type: ModelType } | null>;

  /**
   * ids are not guaranteed unique (a copied file keeps its id), so a caller
   * authorizing what is stored under an id must see all of them; without this,
   * callers fall back to findAllGlobal
   */
  findAllByIdGlobal?(
    id: DefinitionId,
  ): Promise<{ definition: Definition; type: ModelType }[]>;

  /**
   * one scan for a caller that needs findAllByIdGlobal for many ids: it groups
   * this by id instead of scanning once per id
   */
  findAllIncludingAutoGlobal?(): Promise<
    { definition: Definition; type: ModelType }[]
  >;

  /**
   * reads from where the repository last saw it, without scanning; null when
   * there is no hint or the file does not declare the id
   */
  findByIdCached?(
    id: DefinitionId,
  ): Promise<{ definition: Definition; type: ModelType } | null>;

  save(type: ModelType, definition: Definition): Promise<void>;

  /**
   * only files declaring id are removed; deleting a definition that does not
   * exist is a no-op
   */
  delete(type: ModelType, id: DefinitionId, name?: string): Promise<void>;

  nextId(): DefinitionId;

  getPath(type: ModelType, id: DefinitionId): string;
}
