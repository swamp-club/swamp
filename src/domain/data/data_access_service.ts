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

import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { ModelType } from "../models/model_type.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import type { Data } from "./data.ts";
import type { DataRecord } from "./data_record.ts";
import type { DataQueryService } from "./data_query_service.ts";
import { fromData } from "./data_record_mapper.ts";
import { parseNamespacedModelName } from "./namespace.ts";
import { getLogger } from "@logtape/logtape";

/**
 * tracks where data lives on disk, which may differ from the current definition
 * id for orphan-recovered data
 */
interface LocatedData {
  data: Data;
  modelType: ModelType;
  modelId: string;
}

export interface ResolvedModel {
  modelType: ModelType;
  modelId: string;
  modelName: string;
}

/**
 * unlike the modelName tag, which records the name at write time, the identity
 * survives a rename of the model instance
 */
export function modelIdentityPredicate(
  identity: { modelType: string; modelId: string },
  specName?: string,
): string {
  let predicate = `modelType == ${JSON.stringify(identity.modelType)}` +
    ` && modelId == ${JSON.stringify(identity.modelId)}`;
  if (specName) {
    predicate += ` && specName == ${JSON.stringify(specName)}`;
  }
  return predicate;
}

/**
 * keeps the first occurrence of each data item version, so a record matched by
 * both the name-tag and identity reads is returned once
 */
export function mergeModelData(...lists: DataRecord[][]): DataRecord[] {
  const seen = new Set<string>();
  const merged: DataRecord[] = [];
  for (const record of lists.flat()) {
    const key = [
      record.namespace,
      record.modelType,
      record.modelId,
      record.name,
      record.version,
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }
  return merged;
}

/**
 * direct model-to-model reads by name; a peer to WorkflowDataService, which
 * handles workflow-run-scoped traversal
 */
export class DataAccessService {
  /**
   * definitions resolved by name, including misses: a lookup without a cached
   * path walks every definition file, so a name read repeatedly is looked up
   * once
   */
  private readonly identities = new Map<string, ResolvedModel | null>();

  constructor(
    private readonly definitionRepo: DefinitionRepository,
    private readonly dataRepo: UnifiedDataRepository,
    private readonly vaultService?: VaultService,
    private readonly redactor?: SecretRedactor,
    private readonly dataQueryService?: DataQueryService,
  ) {}

  async resolveModel(modelName: string): Promise<ResolvedModel | null> {
    const result = await this.definitionRepo.findByNameGlobal(modelName);
    if (result) {
      return {
        modelType: result.type,
        modelId: result.definition.id,
        modelName: result.definition.name,
      };
    }
    return null;
  }

  private async resolveIdentity(
    modelName: string,
  ): Promise<ResolvedModel | null> {
    if (!this.identities.has(modelName)) {
      this.identities.set(modelName, await this.resolveModel(modelName));
    }
    return this.identities.get(modelName) ?? null;
  }

  async readModelData(
    modelName: string,
    specName?: string,
    caller?: ResolvedModel,
  ): Promise<DataRecord[]> {
    const parsed = parseNamespacedModelName(modelName);

    if (this.dataQueryService) {
      const escape = (s: string) =>
        s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      let predicate = `modelName == "${escape(parsed.modelName)}"`;
      if (specName) {
        predicate += ` && specName == "${escape(specName)}"`;
      }
      if (parsed.namespace === undefined) {
        const ownNs = this.dataRepo.namespace;
        predicate += ` && ns == "${escape(ownNs)}"`;
      } else if (parsed.namespace !== "*") {
        predicate += ` && ns == "${escape(parsed.namespace)}"`;
      }
      const byName = await this.dataQueryService.query(
        predicate,
      ) as DataRecord[];
      if (parsed.namespace !== undefined) {
        return byName;
      }

      // the name tag records the name at write time, so data written before a
      // rename is also read by the definition's identity
      const identity = caller?.modelName === parsed.modelName
        ? caller
        : await this.resolveIdentity(parsed.modelName);
      if (!identity) {
        return byName;
      }
      const byIdentity = await this.dataQueryService.query(
        modelIdentityPredicate(
          {
            modelType: identity.modelType.normalized,
            modelId: identity.modelId,
          },
          specName,
        ) + ` && ns == ${JSON.stringify(this.dataRepo.namespace)}`,
      ) as DataRecord[];
      return mergeModelData(byName, byIdentity);
    }

    if (parsed.namespace !== undefined && parsed.namespace !== "*") {
      getLogger(["data", "access"]).warn(
        "Cross-namespace read {ns}:{model} falling back to own-namespace " +
          "(filesystem path does not support cross-namespace resolution)",
        { ns: parsed.namespace, model: parsed.modelName },
      );
    }

    const resolved = await this.resolveModel(parsed.modelName);
    if (!resolved) {
      return [];
    }

    const currentData = (
      await this.dataRepo.findAllForModel(
        resolved.modelType,
        resolved.modelId,
      )
    ).map((data): LocatedData => ({
      data,
      modelType: resolved.modelType,
      modelId: resolved.modelId,
    }));

    const orphanData = await this.findOrphanData(
      resolved.modelType,
      resolved.modelId,
      modelName,
    );

    const allData: LocatedData[] = [...currentData, ...orphanData];

    if (allData.length === 0) {
      return [];
    }

    const filtered = specName
      ? allData.filter((d) => d.data.tags["specName"] === specName)
      : allData;

    const active = filtered.filter(
      (d) => !d.data.isRenamed && !d.data.isDeleted,
    );

    const records: DataRecord[] = [];
    for (const located of active) {
      const record = await this.dataToRecord(
        located.data,
        located.modelType,
        located.modelId,
        modelName,
      );
      if (record) {
        records.push(record);
      }
    }

    return records;
  }

  /**
   * finds data stored under a previous UUID after a delete/recreate, by
   * modelName tag or, when the type has a single definition, by type alone;
   * keeps the original modelId so content reads from the right path
   */
  private async findOrphanData(
    modelType: ModelType,
    currentModelId: string,
    modelName: string,
  ): Promise<LocatedData[]> {
    const allGlobal = await this.dataRepo.findAllGlobal();

    const orphanCandidates = allGlobal.filter(
      (item) =>
        item.modelType.normalized === modelType.normalized &&
        item.modelId !== currentModelId,
    );

    if (orphanCandidates.length === 0) {
      return [];
    }

    const byModelId = new Map<
      string,
      Array<{ data: Data; modelType: ModelType; modelId: string }>
    >();
    for (const item of orphanCandidates) {
      if (!byModelId.has(item.modelId)) {
        byModelId.set(item.modelId, []);
      }
      byModelId.get(item.modelId)!.push(item);
    }

    const allDefsOfType = await this.definitionRepo.findAll(modelType);

    const results: LocatedData[] = [];

    for (const [, items] of byModelId) {
      const hasNameTag = items.some(
        (item) => item.data.tags["modelName"] === modelName,
      );
      if (hasNameTag) {
        for (const item of items) {
          results.push({
            data: item.data,
            modelType: item.modelType,
            modelId: item.modelId,
          });
        }
        continue;
      }

      // Tier 2: single-definition heuristic — only if this is the sole
      // definition of this type
      if (allDefsOfType.length === 1) {
        for (const item of items) {
          results.push({
            data: item.data,
            modelType: item.modelType,
            modelId: item.modelId,
          });
        }
      }
    }

    return results;
  }

  private async dataToRecord(
    data: Data,
    modelType: ModelType,
    modelId: string,
    modelName?: string,
  ): Promise<DataRecord | null> {
    return await fromData(data, modelType, modelId, this.dataRepo, {
      modelName,
      vaultService: this.vaultService,
      redactor: this.redactor,
    });
  }
}
