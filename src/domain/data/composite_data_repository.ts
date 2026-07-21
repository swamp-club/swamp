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
import type { DataId } from "./data_id.ts";
import type { ModelType, ModelTypeInput } from "../models/model_type.ts";
import { coerceModelType } from "../models/model_type.ts";
import type { Namespace } from "./namespace.ts";
import type {
  GarbageCollectionResult,
  UnifiedDataRepository,
} from "./repositories.ts";

export class CompositeUnifiedDataRepository implements UnifiedDataRepository {
  readonly namespace: Namespace;

  constructor(
    private readonly persistent: UnifiedDataRepository,
    private readonly ephemeral: UnifiedDataRepository,
  ) {
    this.namespace = persistent.namespace;
  }

  private routeWrite(data: Data): UnifiedDataRepository {
    return data.lifetime === "ephemeral" ? this.ephemeral : this.persistent;
  }

  // --- Write Operations ---

  save(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<{ version: number }> {
    return this.routeWrite(data).save(type, modelId, data, content);
  }

  append(
    type: ModelType,
    modelId: string,
    dataName: string,
    content: Uint8Array,
  ): Promise<void> {
    return this.ephemeral.getLatestVersionSync(type, modelId, dataName) !== null
      ? this.ephemeral.append(type, modelId, dataName, content)
      : this.persistent.append(type, modelId, dataName, content);
  }

  allocateVersion(
    type: ModelType,
    modelId: string,
    data: Data,
  ): Promise<
    { version: number; contentPath: string; priorVersions: number[] }
  > {
    return this.routeWrite(data).allocateVersion(type, modelId, data);
  }

  finalizeVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
    priorVersions?: number[],
  ): Promise<{ size: number; checksum: string }> {
    return this.routeWrite(data).finalizeVersion(
      type,
      modelId,
      data,
      version,
      priorVersions,
    );
  }

  delete(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<void> {
    if (this.ephemeral.getLatestVersionSync(type, modelId, dataName) !== null) {
      return this.ephemeral.delete(type, modelId, dataName, version);
    }
    return this.persistent.delete(type, modelId, dataName, version);
  }

  removeLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<void> {
    if (this.ephemeral.getLatestVersionSync(type, modelId, dataName) !== null) {
      return this.ephemeral.removeLatestMarker(type, modelId, dataName);
    }
    return this.persistent.removeLatestMarker(type, modelId, dataName);
  }

  collectGarbage(
    type: ModelType,
    modelId: string,
    options?: { dryRun?: boolean; skipNumericCap?: boolean },
  ): Promise<GarbageCollectionResult> {
    return this.persistent.collectGarbage(type, modelId, options);
  }

  rename(
    type: ModelType,
    modelId: string,
    oldName: string,
    newName: string,
  ): Promise<
    {
      oldName: string;
      newName: string;
      copiedVersion: number;
      newVersion: number;
    }
  > {
    if (this.ephemeral.getLatestVersionSync(type, modelId, oldName) !== null) {
      return this.ephemeral.rename(type, modelId, oldName, newName);
    }
    return this.persistent.rename(type, modelId, oldName, newName);
  }

  // --- Read Operations (ephemeral-first fallback) ---

  async findByName(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Data | null> {
    const ephResult = await this.ephemeral.findByName(
      type,
      modelId,
      dataName,
      version,
    );
    if (ephResult) return ephResult;
    return this.persistent.findByName(type, modelId, dataName, version);
  }

  async findById(
    type: ModelType,
    modelId: string,
    dataId: DataId,
    version?: number,
  ): Promise<Data | null> {
    const ephResult = await this.ephemeral.findById(
      type,
      modelId,
      dataId,
      version,
    );
    if (ephResult) return ephResult;
    return this.persistent.findById(type, modelId, dataId, version);
  }

  async listVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number[]> {
    const ephVersions = await this.ephemeral.listVersions(
      type,
      modelId,
      dataName,
    );
    if (ephVersions.length > 0) return ephVersions;
    return this.persistent.listVersions(type, modelId, dataName);
  }

  async findAllForModel(
    type: ModelTypeInput,
    modelId: string,
  ): Promise<Data[]> {
    const coerced = coerceModelType(type);
    const [ephResults, persResults] = await Promise.all([
      this.ephemeral.findAllForModel(coerced, modelId),
      this.persistent.findAllForModel(coerced, modelId),
    ]);

    const seen = new Set<string>();
    const merged: Data[] = [];
    for (const data of ephResults) {
      seen.add(data.name);
      merged.push(data);
    }
    for (const data of persResults) {
      if (!seen.has(data.name)) merged.push(data);
    }
    return merged;
  }

  async findAllForType(
    type: ModelTypeInput,
  ): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > {
    const coerced = coerceModelType(type);
    const [ephResults, persResults] = await Promise.all([
      this.ephemeral.findAllForType(coerced),
      this.persistent.findAllForType(coerced),
    ]);

    const seen = new Set<string>();
    const merged: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    for (const item of ephResults) {
      seen.add(`${item.modelId}:${item.data.name}`);
      merged.push(item);
    }
    for (const item of persResults) {
      if (!seen.has(`${item.modelId}:${item.data.name}`)) merged.push(item);
    }
    return merged;
  }

  async findAllGlobal(): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > {
    const [ephResults, persResults] = await Promise.all([
      this.ephemeral.findAllGlobal(),
      this.persistent.findAllGlobal(),
    ]);

    const seen = new Set<string>();
    const merged: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    for (const item of ephResults) {
      seen.add(
        `${item.modelType.normalized}:${item.modelId}:${item.data.name}`,
      );
      merged.push(item);
    }
    for (const item of persResults) {
      const key =
        `${item.modelType.normalized}:${item.modelId}:${item.data.name}`;
      if (!seen.has(key)) merged.push(item);
    }
    return merged;
  }

  async getContent(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null> {
    const ephContent = await this.ephemeral.getContent(
      type,
      modelId,
      dataName,
      version,
    );
    if (ephContent) return ephContent;
    return this.persistent.getContent(type, modelId, dataName, version);
  }

  async *stream(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): AsyncIterable<Uint8Array> {
    if (this.ephemeral.getLatestVersionSync(type, modelId, dataName) !== null) {
      yield* this.ephemeral.stream(type, modelId, dataName, version);
      return;
    }
    yield* this.persistent.stream(type, modelId, dataName, version);
  }

  // --- Path Operations ---

  getPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    if (this.ephemeral.getLatestVersionSync(type, modelId, dataName) !== null) {
      return this.ephemeral.getPath(type, modelId, dataName, version);
    }
    return this.persistent.getPath(type, modelId, dataName, version);
  }

  getContentPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    if (this.ephemeral.getLatestVersionSync(type, modelId, dataName) !== null) {
      return this.ephemeral.getContentPath(type, modelId, dataName, version);
    }
    return this.persistent.getContentPath(type, modelId, dataName, version);
  }

  // --- Identity ---

  nextId(): DataId {
    return this.persistent.nextId();
  }

  // --- Sync Read Methods ---

  getLatestVersionSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number | null {
    const ephVersion = this.ephemeral.getLatestVersionSync(
      type,
      modelId,
      dataName,
    );
    if (ephVersion !== null) return ephVersion;
    return this.persistent.getLatestVersionSync(type, modelId, dataName);
  }

  findByNameSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Data | null {
    const ephResult = this.ephemeral.findByNameSync(
      type,
      modelId,
      dataName,
      version,
    );
    if (ephResult) return ephResult;
    return this.persistent.findByNameSync(type, modelId, dataName, version);
  }

  listVersionsSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number[] {
    const ephVersions = this.ephemeral.listVersionsSync(
      type,
      modelId,
      dataName,
    );
    if (ephVersions.length > 0) return ephVersions;
    return this.persistent.listVersionsSync(type, modelId, dataName);
  }

  getContentSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Uint8Array | null {
    const ephContent = this.ephemeral.getContentSync(
      type,
      modelId,
      dataName,
      version,
    );
    if (ephContent) return ephContent;
    return this.persistent.getContentSync(type, modelId, dataName, version);
  }

  findAllForModelSync(type: ModelType, modelId: string): Data[] {
    const ephResults = this.ephemeral.findAllForModelSync(type, modelId);
    const persResults = this.persistent.findAllForModelSync(type, modelId);

    const seen = new Set<string>();
    const merged: Data[] = [];
    for (const data of ephResults) {
      seen.add(data.name);
      merged.push(data);
    }
    for (const data of persResults) {
      if (!seen.has(data.name)) merged.push(data);
    }
    return merged;
  }

  findAllGlobalSync(): Array<
    { data: Data; modelType: ModelType; modelId: string }
  > {
    const ephResults = this.ephemeral.findAllGlobalSync();
    const persResults = this.persistent.findAllGlobalSync();

    const seen = new Set<string>();
    const merged: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    for (const item of ephResults) {
      seen.add(
        `${item.modelType.normalized}:${item.modelId}:${item.data.name}`,
      );
      merged.push(item);
    }
    for (const item of persResults) {
      const key =
        `${item.modelType.normalized}:${item.modelId}:${item.data.name}`;
      if (!seen.has(key)) merged.push(item);
    }
    return merged;
  }

  async findByTaggedName(
    modelName: string,
    dataName: string,
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>> {
    const ephResults = await this.ephemeral.findByTaggedName(
      modelName,
      dataName,
    );
    const persResults = await this.persistent.findByTaggedName(
      modelName,
      dataName,
    );

    const seen = new Set<string>();
    const merged: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    for (const item of ephResults) {
      seen.add(
        `${item.modelType.normalized}:${item.modelId}:${item.data.name}`,
      );
      merged.push(item);
    }
    for (const item of persResults) {
      const key =
        `${item.modelType.normalized}:${item.modelId}:${item.data.name}`;
      if (!seen.has(key)) merged.push(item);
    }
    return merged;
  }
}
