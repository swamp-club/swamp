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

import type { Data } from "./data.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
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

export interface BatchDeleteResult {
  modelType: string;
  modelId: string;
  modelName: string;
  deleted: Array<{ dataName: string; versionsDeleted: number }>;
  failed: Array<{ dataName: string; error: string }>;
  totalDeleted: number;
  totalVersionsDeleted: number;
}

export interface BatchDeletePreview {
  modelType: string;
  modelId: string;
  modelName: string;
  matchingItems: Array<{ dataName: string; versionsCount: number }>;
  totalItems: number;
  totalVersions: number;
}

export type BatchDeleteFilter =
  | { kind: "prefix"; value: string }
  | { kind: "all" };

function matchesFilter(
  data: Data,
  filter: BatchDeleteFilter,
): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "prefix":
      return data.name.startsWith(filter.value);
  }
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
    private readonly definitionRepo: DefinitionRepository,
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

  async batchDelete(
    modelRef: string,
    filter: BatchDeleteFilter,
  ): Promise<BatchDeleteResult> {
    const lookup = await findDefinitionByIdOrName(
      this.definitionRepo,
      modelRef,
    );
    if (!lookup) {
      throw new Error(`Model not found: ${modelRef}`);
    }
    const { definition, type: modelType } = lookup;

    const allData = await this.dataRepo.findAllForModel(
      modelType,
      definition.id,
    );
    const matching = allData.filter((d) => matchesFilter(d, filter));

    if (matching.length === 0) {
      const desc = filter.kind === "prefix"
        ? `prefix "${filter.value}"`
        : "any data";
      throw new Error(
        `No data matching ${desc} found for model ${definition.name}`,
      );
    }

    const deleted: Array<{ dataName: string; versionsDeleted: number }> = [];
    const failed: Array<{ dataName: string; error: string }> = [];
    let totalVersionsDeleted = 0;

    for (const data of matching) {
      try {
        const versions = await this.dataRepo.listVersions(
          modelType,
          definition.id,
          data.name,
        );
        await this.dataRepo.delete(modelType, definition.id, data.name);
        deleted.push({
          dataName: data.name,
          versionsDeleted: versions.length,
        });
        totalVersionsDeleted += versions.length;
      } catch (error) {
        failed.push({
          dataName: data.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      modelType: modelType.normalized,
      modelId: definition.id,
      modelName: definition.name,
      deleted,
      failed,
      totalDeleted: deleted.length,
      totalVersionsDeleted,
    };
  }

  async batchPreviewDelete(
    modelRef: string,
    filter: BatchDeleteFilter,
  ): Promise<BatchDeletePreview> {
    const lookup = await findDefinitionByIdOrName(
      this.definitionRepo,
      modelRef,
    );
    if (!lookup) {
      throw new Error(`Model not found: ${modelRef}`);
    }
    const { definition, type: modelType } = lookup;

    const allData = await this.dataRepo.findAllForModel(
      modelType,
      definition.id,
    );
    const matching = allData.filter((d) => matchesFilter(d, filter));

    if (matching.length === 0) {
      const desc = filter.kind === "prefix"
        ? `prefix "${filter.value}"`
        : "any data";
      throw new Error(
        `No data matching ${desc} found for model ${definition.name}`,
      );
    }

    let totalVersions = 0;
    const matchingItems: Array<{ dataName: string; versionsCount: number }> =
      [];

    for (const data of matching) {
      const versions = await this.dataRepo.listVersions(
        modelType,
        definition.id,
        data.name,
      );
      matchingItems.push({
        dataName: data.name,
        versionsCount: versions.length,
      });
      totalVersions += versions.length;
    }

    return {
      modelType: modelType.normalized,
      modelId: definition.id,
      modelName: definition.name,
      matchingItems,
      totalItems: matching.length,
      totalVersions,
    };
  }
}
