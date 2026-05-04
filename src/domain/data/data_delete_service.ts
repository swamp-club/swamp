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

import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { findDefinitionByIdOrName } from "../models/model_lookup.ts";

/**
 * Result of a data delete operation.
 */
export interface DeleteResult {
  modelType: string;
  modelId: string;
  modelName: string;
  dataName: string;
  version?: number;
  versionsDeleted: number;
}

/**
 * Read-only preview of a delete operation. Used by the CLI to render the
 * confirmation prompt with an exact version count without mutating state.
 */
export interface DeletePreview {
  modelType: string;
  modelId: string;
  modelName: string;
  dataName: string;
  versionsCount: number;
}

/**
 * Service for deleting data instances.
 *
 * Pre-checks (in order):
 *   1. Model exists (resolved by id-or-name)
 *   2. Data artifact exists (listVersions non-empty)
 *   3. When a specific version is requested, that version exists in listVersions
 *
 * The third pre-check closes the silent-no-op surface left by
 * UnifiedDataRepository.delete catching Deno.errors.NotFound on a missing
 * version directory.
 */
export class DataDeleteService {
  constructor(
    private readonly dataRepo: UnifiedDataRepository,
    private readonly definitionRepo: YamlDefinitionRepository,
  ) {}

  async delete(
    modelRef: string,
    dataName: string,
    version?: number,
  ): Promise<DeleteResult> {
    const lookup = await findDefinitionByIdOrName(
      this.definitionRepo,
      modelRef,
    );
    if (!lookup) {
      throw new Error(`Model not found: ${modelRef}`);
    }
    const { definition, type: modelType } = lookup;

    const versions = await this.dataRepo.listVersions(
      modelType,
      definition.id,
      dataName,
    );
    if (versions.length === 0) {
      throw new Error(
        `No data named "${dataName}" exists for model ${definition.name}`,
      );
    }

    if (version !== undefined && !versions.includes(version)) {
      const sorted = [...versions].sort((a, b) => a - b);
      throw new Error(
        `Version ${version} does not exist for "${dataName}" (available versions: ${
          sorted.join(", ")
        })`,
      );
    }

    await this.dataRepo.delete(modelType, definition.id, dataName, version);

    return {
      modelType: modelType.normalized,
      modelId: definition.id,
      modelName: definition.name,
      dataName,
      version,
      versionsDeleted: version !== undefined ? 1 : versions.length,
    };
  }

  async previewDelete(
    modelRef: string,
    dataName: string,
  ): Promise<DeletePreview> {
    const lookup = await findDefinitionByIdOrName(
      this.definitionRepo,
      modelRef,
    );
    if (!lookup) {
      throw new Error(`Model not found: ${modelRef}`);
    }
    const { definition, type: modelType } = lookup;

    const versions = await this.dataRepo.listVersions(
      modelType,
      definition.id,
      dataName,
    );
    if (versions.length === 0) {
      throw new Error(
        `No data named "${dataName}" exists for model ${definition.name}`,
      );
    }

    return {
      modelType: modelType.normalized,
      modelId: definition.id,
      modelName: definition.name,
      dataName,
      versionsCount: versions.length,
    };
  }
}
