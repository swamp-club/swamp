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

import { Data, isReservedDataName } from "../../domain/data/data.ts";
import type { DataId } from "../../domain/data/data_id.ts";
import { generateDataId } from "../../domain/data/data_id.ts";
import {
  coerceModelType,
  ModelType,
  type ModelTypeInput,
} from "../../domain/models/model_type.ts";
import type { Namespace } from "../../domain/data/namespace.ts";
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import {
  EphemeralBudgetExceededError,
  type GarbageCollectionResult,
  OwnershipValidationError,
  type UnifiedDataRepository,
} from "../../domain/data/repositories.ts";
import type { CatalogStore } from "./catalog_store.ts";

const SEP = "\0";

function dataKey(
  typeNormalized: string,
  modelId: string,
  dataName: string,
  version: number,
): string {
  return `${typeNormalized}${SEP}${modelId}${SEP}${dataName}${SEP}${version}`;
}

function latestKey(
  typeNormalized: string,
  modelId: string,
  dataName: string,
): string {
  return `${typeNormalized}${SEP}${modelId}${SEP}${dataName}`;
}

export const DEFAULT_EPHEMERAL_MAX_BYTES = 512 * 1024 * 1024; // 512 MB

export class InMemoryUnifiedDataRepository implements UnifiedDataRepository {
  private readonly dataMap = new Map<string, Data>();
  private readonly contentMap = new Map<string, Uint8Array>();
  private readonly latestVersionMap = new Map<string, number>();
  private readonly allocatedPaths = new Map<string, {
    typeNormalized: string;
    modelId: string;
    data: Data;
    version: number;
  }>();
  private disposed = false;
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(
    private readonly catalogStore: CatalogStore,
    public readonly namespace: Namespace = SOLO_NAMESPACE,
    maxBytes?: number,
  ) {
    this.maxBytes = maxBytes ?? DEFAULT_EPHEMERAL_MAX_BYTES;
    catalogStore.markPopulated();
  }

  dispose(): void {
    for (const path of this.allocatedPaths.keys()) {
      try {
        Deno.removeSync(path);
      } catch {
        // Best-effort cleanup — file may already be gone
      }
    }
    this.dataMap.clear();
    this.contentMap.clear();
    this.latestVersionMap.clear();
    this.allocatedPaths.clear();
    this.disposed = true;
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error("InMemoryUnifiedDataRepository has been disposed");
    }
  }

  private ensureBudget(additionalBytes: number): void {
    if (this.totalBytes + additionalBytes > this.maxBytes) {
      throw new EphemeralBudgetExceededError(
        this.totalBytes,
        additionalBytes,
        this.maxBytes,
      );
    }
  }

  private catalogUpsert(type: ModelType, modelId: string, data: Data): void {
    this.catalogStore.upsertNewVersion({
      namespace: this.namespace,
      type_normalized: type.normalized,
      model_id: modelId,
      data_name: data.name,
      id: data.id,
      version: data.version,
      is_latest: 1,
      model_name: data.tags["modelName"] ?? "",
      spec_name: data.tags["specName"] ?? "",
      data_type: data.tags["type"] ?? "",
      content_type: data.contentType,
      lifetime: data.lifetime,
      owner_type: data.ownerDefinition.ownerType,
      streaming: data.streaming ? 1 : 0,
      size: data.size ?? 0,
      created_at: data.createdAt.toISOString(),
      tags: JSON.stringify(data.tags),
      owner_ref: data.ownerDefinition.ownerRef,
      workflow_run_id: data.ownerDefinition.workflowRunId ?? "",
      workflow_name: data.ownerDefinition.workflowName ?? "",
      job_name: data.ownerDefinition.jobName ?? "",
      step_name: data.ownerDefinition.stepName ?? "",
      source: data.ownerDefinition.source ?? "",
    });
  }

  private catalogRemove(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): void {
    this.catalogStore.remove(
      this.namespace,
      type.normalized,
      modelId,
      dataName,
    );
  }

  private getLatestVersionNumber(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number | null {
    const key = latestKey(type.normalized, modelId, dataName);
    return this.latestVersionMap.get(key) ?? null;
  }

  private nextVersion(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number {
    const current = this.getLatestVersionNumber(type, modelId, dataName);
    return (current ?? 0) + 1;
  }

  private pruneExcessVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
    priorVersions: number[],
    cap: number,
  ): void {
    if (priorVersions.length < cap) return;
    const sorted = [...priorVersions].sort((a, b) => a - b);
    const toRemove = sorted.slice(0, sorted.length - cap + 1);
    for (const version of toRemove) {
      const key = dataKey(type.normalized, modelId, dataName, version);
      const existing = this.contentMap.get(key);
      if (existing) {
        this.totalBytes -= existing.length;
      }
      this.dataMap.delete(key);
      this.contentMap.delete(key);
    }
  }

  private async computeChecksum(content: Uint8Array): Promise<string> {
    const buffer = new ArrayBuffer(content.length);
    new Uint8Array(buffer).set(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // --- Write Operations ---

  async save(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<{ version: number }> {
    this.ensureNotDisposed();

    if (isReservedDataName(data.name)) {
      throw new Error(
        `Data name '${data.name}' is reserved for internal use. Use a different name.`,
      );
    }

    const existing = this.findByNameSync(type, modelId, data.name);
    if (existing) {
      if (!existing.isOwnedBy(data.ownerDefinition)) {
        throw new OwnershipValidationError(
          data.name,
          existing.ownerDefinition,
          data.ownerDefinition,
        );
      }
    }

    const priorVersions = this.listVersionsSync(type, modelId, data.name);
    const newVersion = this.nextVersion(type, modelId, data.name);
    this.ensureBudget(content.length);

    const dataToSave = data.withNewVersion({
      version: newVersion,
      size: content.length,
      checksum: await this.computeChecksum(content),
    });

    const key = dataKey(type.normalized, modelId, data.name, newVersion);
    this.dataMap.set(key, dataToSave);
    this.contentMap.set(key, content);
    this.totalBytes += content.length;
    this.latestVersionMap.set(
      latestKey(type.normalized, modelId, data.name),
      newVersion,
    );

    this.catalogUpsert(type, modelId, dataToSave);

    const gc = data.garbageCollection;
    if (typeof gc === "number") {
      this.pruneExcessVersions(type, modelId, data.name, priorVersions, gc);
    }

    return { version: newVersion };
  }

  async append(
    type: ModelType,
    modelId: string,
    dataName: string,
    content: Uint8Array,
  ): Promise<void> {
    this.ensureNotDisposed();

    const latestVersion = this.getLatestVersionNumber(type, modelId, dataName);
    if (latestVersion === null) {
      throw new Error(`No existing data found for "${dataName}"`);
    }

    const data = this.findByNameSync(type, modelId, dataName, latestVersion);
    if (!data?.streaming) {
      throw new Error(`Data "${dataName}" is not configured for streaming`);
    }

    this.ensureBudget(content.length);

    const key = dataKey(type.normalized, modelId, dataName, latestVersion);
    const existing = this.contentMap.get(key) ?? new Uint8Array(0);
    const merged = new Uint8Array(existing.length + content.length);
    merged.set(existing);
    merged.set(content, existing.length);
    this.contentMap.set(key, merged);
    this.totalBytes += content.length;

    const updatedData = data.withNewVersion({
      version: latestVersion,
      size: merged.length,
      checksum: await this.computeChecksum(merged),
    });
    this.dataMap.set(key, updatedData);
    this.catalogUpsert(type, modelId, updatedData);
  }

  async allocateVersion(
    type: ModelType,
    modelId: string,
    data: Data,
  ): Promise<
    { version: number; contentPath: string; priorVersions: number[] }
  > {
    this.ensureNotDisposed();

    if (isReservedDataName(data.name)) {
      throw new Error(
        `Data name '${data.name}' is reserved for internal use. Use a different name.`,
      );
    }

    const existing = this.findByNameSync(type, modelId, data.name);
    if (existing) {
      if (!existing.isOwnedBy(data.ownerDefinition)) {
        throw new OwnershipValidationError(
          data.name,
          existing.ownerDefinition,
          data.ownerDefinition,
        );
      }
    }

    const priorVersions = this.listVersionsSync(type, modelId, data.name);
    const newVersion = this.nextVersion(type, modelId, data.name);
    const contentPath = await Deno.makeTempFile({
      prefix: "swamp-ephemeral-",
    });

    this.allocatedPaths.set(contentPath, {
      typeNormalized: type.normalized,
      modelId,
      data,
      version: newVersion,
    });

    return { version: newVersion, contentPath, priorVersions };
  }

  async finalizeVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
    priorVersions?: number[],
  ): Promise<{ size: number; checksum: string }> {
    this.ensureNotDisposed();

    let tempPath: string | undefined;
    for (const [path, alloc] of this.allocatedPaths) {
      if (
        alloc.typeNormalized === type.normalized &&
        alloc.modelId === modelId &&
        alloc.data.name === data.name &&
        alloc.version === version
      ) {
        tempPath = path;
        break;
      }
    }

    let content: Uint8Array;
    if (tempPath) {
      content = await Deno.readFile(tempPath);
      await Deno.remove(tempPath).catch(() => {});
      this.allocatedPaths.delete(tempPath);
    } else {
      content = new Uint8Array(0);
    }

    this.ensureBudget(content.length);

    const checksum = await this.computeChecksum(content);
    const size = content.length;

    const dataToSave = data.withNewVersion({
      version,
      size,
      checksum,
    });

    const key = dataKey(type.normalized, modelId, data.name, version);
    this.dataMap.set(key, dataToSave);
    this.contentMap.set(key, content);
    this.totalBytes += content.length;
    this.latestVersionMap.set(
      latestKey(type.normalized, modelId, data.name),
      version,
    );

    this.catalogUpsert(type, modelId, dataToSave);

    const gc = data.garbageCollection;
    if (typeof gc === "number" && priorVersions) {
      this.pruneExcessVersions(type, modelId, data.name, priorVersions, gc);
    }

    return { size, checksum };
  }

  // --- Read Operations ---

  findAllGlobal(): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > {
    this.ensureNotDisposed();
    return Promise.resolve(this.findAllGlobalSync());
  }

  findAllForType(
    type: ModelTypeInput,
  ): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > {
    this.ensureNotDisposed();
    type = coerceModelType(type);
    const results: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];

    for (const [key, version] of this.latestVersionMap) {
      const parts = key.split(SEP);
      if (parts[0] !== type.normalized) continue;
      const dKey = dataKey(parts[0], parts[1], parts[2], version);
      const data = this.dataMap.get(dKey);
      if (data && !data.isDeleted) {
        results.push({
          data,
          modelType: type,
          modelId: parts[1],
        });
      }
    }

    return Promise.resolve(results);
  }

  findByName(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Data | null> {
    this.ensureNotDisposed();
    return Promise.resolve(
      this.findByNameSync(coerceModelType(type), modelId, dataName, version),
    );
  }

  findById(
    _type: ModelType,
    _modelId: string,
    dataId: DataId,
    version?: number,
  ): Promise<Data | null> {
    this.ensureNotDisposed();

    for (const data of this.dataMap.values()) {
      if (data.id === dataId) {
        if (version !== undefined && data.version !== version) continue;
        return Promise.resolve(data);
      }
    }
    return Promise.resolve(null);
  }

  listVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number[]> {
    this.ensureNotDisposed();
    return Promise.resolve(this.listVersionsSync(type, modelId, dataName));
  }

  findAllForModel(
    type: ModelTypeInput,
    modelId: string,
  ): Promise<Data[]> {
    this.ensureNotDisposed();
    return Promise.resolve(
      this.findAllForModelSync(coerceModelType(type), modelId),
    );
  }

  getContent(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null> {
    this.ensureNotDisposed();
    return Promise.resolve(
      this.getContentSync(coerceModelType(type), modelId, dataName, version),
    );
  }

  async *stream(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): AsyncIterable<Uint8Array> {
    this.ensureNotDisposed();
    const content = this.getContentSync(type, modelId, dataName, version);
    if (content) {
      yield content;
    }
  }

  // --- Delete Operations ---

  delete(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<void> {
    this.ensureNotDisposed();

    if (version !== undefined) {
      const key = dataKey(type.normalized, modelId, dataName, version);
      const content = this.contentMap.get(key);
      if (content) this.totalBytes -= content.length;
      this.dataMap.delete(key);
      this.contentMap.delete(key);

      const latest = this.getLatestVersionNumber(type, modelId, dataName);
      if (latest === version) {
        const remaining = this.listVersionsSync(type, modelId, dataName);
        if (remaining.length > 0) {
          this.latestVersionMap.set(
            latestKey(type.normalized, modelId, dataName),
            remaining[remaining.length - 1],
          );
        } else {
          this.latestVersionMap.delete(
            latestKey(type.normalized, modelId, dataName),
          );
          this.catalogRemove(type, modelId, dataName);
        }
      }
    } else {
      const versions = this.listVersionsSync(type, modelId, dataName);
      for (const v of versions) {
        const key = dataKey(type.normalized, modelId, dataName, v);
        const content = this.contentMap.get(key);
        if (content) this.totalBytes -= content.length;
        this.dataMap.delete(key);
        this.contentMap.delete(key);
      }
      this.latestVersionMap.delete(
        latestKey(type.normalized, modelId, dataName),
      );
      this.catalogRemove(type, modelId, dataName);
    }
    return Promise.resolve();
  }

  removeLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<void> {
    this.ensureNotDisposed();
    this.latestVersionMap.delete(
      latestKey(type.normalized, modelId, dataName),
    );
    return Promise.resolve();
  }

  collectGarbage(
    type: ModelType,
    modelId: string,
    options?: { dryRun?: boolean },
  ): Promise<GarbageCollectionResult> {
    this.ensureNotDisposed();
    let versionsRemoved = 0;
    let bytesReclaimed = 0;

    const toProcess = new Map<string, number[]>();
    for (const [key] of this.dataMap) {
      const parts = key.split(SEP);
      if (parts[0] !== type.normalized || parts[1] !== modelId) continue;
      const dataName = parts[2];
      const version = parseInt(parts[3], 10);
      if (!toProcess.has(dataName)) toProcess.set(dataName, []);
      toProcess.get(dataName)!.push(version);
    }

    for (const [dataName, versions] of toProcess) {
      versions.sort((a, b) => a - b);
      const latest = this.getLatestVersionNumber(type, modelId, dataName);
      const latestData = latest
        ? this.dataMap.get(
          dataKey(type.normalized, modelId, dataName, latest),
        )
        : undefined;
      if (!latestData) continue;

      const keep = latestData.garbageCollection;
      if (typeof keep !== "number") continue;
      if (versions.length <= keep) continue;

      const toRemove = versions.slice(0, versions.length - keep);
      for (const v of toRemove) {
        const key = dataKey(type.normalized, modelId, dataName, v);
        const content = this.contentMap.get(key);
        bytesReclaimed += content?.length ?? 0;
        versionsRemoved++;

        if (!options?.dryRun) {
          if (content) this.totalBytes -= content.length;
          this.dataMap.delete(key);
          this.contentMap.delete(key);
        }
      }
    }

    return Promise.resolve({ versionsRemoved, bytesReclaimed });
  }

  rename(
    type: ModelType,
    modelId: string,
    oldName: string,
    newName: string,
  ): Promise<{
    oldName: string;
    newName: string;
    copiedVersion: number;
    newVersion: number;
  }> {
    this.ensureNotDisposed();

    const latest = this.getLatestVersionNumber(type, modelId, oldName);
    if (latest === null) {
      throw new Error(`No existing data found for "${oldName}"`);
    }

    const oldKey = dataKey(type.normalized, modelId, oldName, latest);
    const oldData = this.dataMap.get(oldKey);
    const oldContent = this.contentMap.get(oldKey);
    if (!oldData || !oldContent) {
      throw new Error(`No existing data found for "${oldName}"`);
    }

    const newVersion = this.nextVersion(type, modelId, newName);
    const newData = Data.create({
      id: oldData.id,
      name: newName,
      version: newVersion,
      contentType: oldData.contentType,
      lifetime: oldData.lifetime,
      garbageCollection: oldData.garbageCollection,
      streaming: oldData.streaming,
      tags: oldData.tags,
      ownerDefinition: oldData.ownerDefinition,
      size: oldData.size,
      checksum: oldData.checksum,
    });

    const newKey = dataKey(type.normalized, modelId, newName, newVersion);
    this.dataMap.set(newKey, newData);
    this.contentMap.set(newKey, oldContent);
    this.latestVersionMap.set(
      latestKey(type.normalized, modelId, newName),
      newVersion,
    );

    const tombstoneVersion = latest + 1;
    const tombstone = oldData.withRenameMarker({
      version: tombstoneVersion,
      renamedTo: newName,
    });
    const tombstoneKey = dataKey(
      type.normalized,
      modelId,
      oldName,
      tombstoneVersion,
    );
    this.dataMap.set(tombstoneKey, tombstone);
    this.contentMap.set(tombstoneKey, new TextEncoder().encode("{}"));
    this.latestVersionMap.set(
      latestKey(type.normalized, modelId, oldName),
      tombstoneVersion,
    );

    this.catalogUpsert(type, modelId, newData);

    return Promise.resolve({
      oldName,
      newName,
      copiedVersion: latest,
      newVersion,
    });
  }

  // --- Path Operations ---

  getPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    return `ephemeral://${type.normalized}/${modelId}/${dataName}/${version}`;
  }

  getContentPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    return `ephemeral://${type.normalized}/${modelId}/${dataName}/${version}/raw`;
  }

  // --- Identity ---

  nextId(): DataId {
    return generateDataId();
  }

  // --- Sync Read Methods (for CEL) ---

  getLatestVersionSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number | null {
    this.ensureNotDisposed();
    return this.getLatestVersionNumber(type, modelId, dataName);
  }

  findByNameSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Data | null {
    this.ensureNotDisposed();
    return this.findByNameWithDepth(type, modelId, dataName, version, 0);
  }

  private findByNameWithDepth(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number | undefined,
    depth: number,
  ): Data | null {
    const v = version ?? this.getLatestVersionNumber(type, modelId, dataName);
    if (v === null) return null;

    const key = dataKey(type.normalized, modelId, dataName, v);
    const data = this.dataMap.get(key);
    if (!data) return null;

    if (data.isRenamed && data.renamedTo) {
      if (depth >= 5) return null;
      return this.findByNameWithDepth(
        type,
        modelId,
        data.renamedTo,
        undefined,
        depth + 1,
      );
    }

    return data;
  }

  listVersionsSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number[] {
    this.ensureNotDisposed();
    const prefix = `${type.normalized}${SEP}${modelId}${SEP}${dataName}${SEP}`;
    const versions: number[] = [];

    for (const key of this.dataMap.keys()) {
      if (key.startsWith(prefix)) {
        const v = parseInt(key.slice(prefix.length), 10);
        if (!isNaN(v)) versions.push(v);
      }
    }

    return versions.sort((a, b) => a - b);
  }

  getContentSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Uint8Array | null {
    this.ensureNotDisposed();

    const v = version ?? this.getLatestVersionNumber(type, modelId, dataName);
    if (v === null) return null;

    const key = dataKey(type.normalized, modelId, dataName, v);
    return this.contentMap.get(key) ?? null;
  }

  findAllForModelSync(type: ModelType, modelId: string): Data[] {
    this.ensureNotDisposed();
    const results: Data[] = [];
    const seen = new Set<string>();

    for (const [key, version] of this.latestVersionMap) {
      const parts = key.split(SEP);
      if (parts[0] !== type.normalized || parts[1] !== modelId) continue;
      const dataName = parts[2];
      if (seen.has(dataName)) continue;

      const dKey = dataKey(type.normalized, modelId, dataName, version);
      const data = this.dataMap.get(dKey);
      if (data && !data.isDeleted) {
        seen.add(dataName);
        results.push(data);
      }
    }

    return results;
  }

  findAllGlobalSync(): Array<
    { data: Data; modelType: ModelType; modelId: string }
  > {
    this.ensureNotDisposed();
    const results: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];

    for (const [key, version] of this.latestVersionMap) {
      const parts = key.split(SEP);
      const typeNorm = parts[0];
      const modelId = parts[1];
      const dataName = parts[2];

      const dKey = dataKey(typeNorm, modelId, dataName, version);
      const data = this.dataMap.get(dKey);
      if (data && !data.isDeleted) {
        results.push({
          data,
          modelType: ModelType.create(typeNorm),
          modelId,
        });
      }
    }

    return results;
  }

  findByTaggedName(
    modelName: string,
    dataName: string,
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>> {
    this.ensureNotDisposed();
    return Promise.resolve(
      this.findAllGlobalSync().filter(
        ({ data }) =>
          data.name === dataName &&
          data.tags["modelName"] === modelName &&
          !data.isRenamed && !data.isDeleted,
      ),
    );
  }
}
