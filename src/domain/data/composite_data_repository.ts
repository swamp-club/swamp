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
  ContentAvailability,
  DeferredWriteReceipt,
  FindAllGlobalOptions,
  ForeignContentFetcher,
  GarbageCollectionResult,
  UnifiedDataRepository,
} from "./repositories.ts";

export class CompositeUnifiedDataRepository implements UnifiedDataRepository {
  readonly namespace: Namespace;
  // Foreign rows are catalog-only and never ephemeral.
  readonly fetchForeignContent?: ForeignContentFetcher;

  // Which repository issued each unsettled deferred version. A receipt
  // carries no lifetime, so settling looks its owner up here.
  private readonly deferredIssuers = new Map<
    string,
    Set<UnifiedDataRepository>
  >();

  constructor(
    private readonly persistent: UnifiedDataRepository,
    private readonly ephemeral: UnifiedDataRepository,
  ) {
    this.namespace = persistent.namespace;
    this.fetchForeignContent = persistent.fetchForeignContent;
  }

  private routeWrite(data: Data): UnifiedDataRepository {
    return data.lifetime === "ephemeral" ? this.ephemeral : this.persistent;
  }

  private recordDeferredIssuer(
    repo: UnifiedDataRepository,
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): void {
    const key = deferredKey({ type, modelId, dataName, version });
    const issuers = this.deferredIssuers.get(key);
    if (issuers) {
      issuers.add(repo);
    } else {
      this.deferredIssuers.set(key, new Set([repo]));
    }
  }

  /**
   * The receipts `repo` issued, each once. A receipt nothing recorded belongs
   * to the persistent repository.
   */
  private receiptsIssuedBy(
    repo: UnifiedDataRepository,
    receipts: DeferredWriteReceipt[],
  ): DeferredWriteReceipt[] {
    const seen = new Set<string>();
    return receipts.filter((receipt) => {
      const key = deferredKey(receipt);
      if (seen.has(key)) return false;
      const issuers = this.deferredIssuers.get(key);
      const issued = issuers ? issuers.has(repo) : repo === this.persistent;
      if (issued) seen.add(key);
      return issued;
    });
  }

  private forgetDeferredIssuers(receipts: DeferredWriteReceipt[]): void {
    for (const receipt of receipts) {
      this.deferredIssuers.delete(deferredKey(receipt));
    }
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

  async allocateVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    options?: { deferred?: boolean },
  ): Promise<
    { version: number; contentPath: string; priorVersions: number[] }
  > {
    const repo = this.routeWrite(data);
    const allocated = await repo.allocateVersion(type, modelId, data, options);
    if (options?.deferred) {
      this.recordDeferredIssuer(
        repo,
        type,
        modelId,
        data.name,
        allocated.version,
      );
    }
    return allocated;
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
    options?: { dryRun?: boolean },
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

  async findAllGlobal(options?: FindAllGlobalOptions): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > {
    const [ephResults, persResults] = await Promise.all([
      this.ephemeral.findAllGlobal(options),
      this.persistent.findAllGlobal(options),
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

  ensureContentLocal(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
    knownSize?: number,
  ): Promise<ContentAvailability> {
    const repo = this.holdsEphemerally(
        coerceModelType(type),
        modelId,
        dataName,
        version,
      )
      ? this.ephemeral
      : this.persistent;
    return repo.ensureContentLocal(
      type,
      modelId,
      dataName,
      version,
      knownSize,
    );
  }

  isContentAcceptedSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    size: number,
  ): boolean {
    const repo = this.holdsEphemerally(type, modelId, dataName, version)
      ? this.ephemeral
      : this.persistent;
    return repo.isContentAcceptedSync(type, modelId, dataName, version, size);
  }

  /**
   * Whether the ephemeral store holds the version a content read would read
   * from it, as {@link getContent} tries the ephemeral store for that exact
   * version first. Without a version, its latest.
   */
  private holdsEphemerally(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number | undefined,
  ): boolean {
    if (version === undefined) {
      return this.ephemeral.getLatestVersionSync(type, modelId, dataName) !==
        null;
    }
    return this.ephemeral.listVersionsSync(type, modelId, dataName)
      .includes(version);
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

  findAllGlobalSync(options?: FindAllGlobalOptions): Array<
    { data: Data; modelType: ModelType; modelId: string }
  > {
    const ephResults = this.ephemeral.findAllGlobalSync(options);
    const persResults = this.persistent.findAllGlobalSync(options);

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

  async saveDeferred(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<DeferredWriteReceipt> {
    const repo = this.routeWrite(data);
    const receipt = await repo.saveDeferred(type, modelId, data, content);
    this.recordDeferredIssuer(
      repo,
      receipt.type,
      receipt.modelId,
      receipt.dataName,
      receipt.version,
    );
    return receipt;
  }

  async finalizeVersionDeferred(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
    priorVersions?: number[],
  ): Promise<
    { receipt: DeferredWriteReceipt; size: number; checksum: string }
  > {
    const repo = this.routeWrite(data);
    const result = await repo.finalizeVersionDeferred(
      type,
      modelId,
      data,
      version,
      priorVersions,
    );
    this.recordDeferredIssuer(repo, type, modelId, data.name, version);
    return result;
  }

  /**
   * Promotes each receipt in the repository that issued it, persistent first:
   * a persistent failure then leaves nothing promoted. A failure keeps the
   * receipts' issuers, so the rollback that follows still finds them.
   */
  async advanceLatestMarkers(
    receipts: DeferredWriteReceipt[],
  ): Promise<void> {
    for (const repo of [this.persistent, this.ephemeral]) {
      const issued = this.receiptsIssuedBy(repo, receipts);
      if (issued.length > 0) await repo.advanceLatestMarkers(issued);
    }
    this.forgetDeferredIssuers(receipts);
  }

  /**
   * Rolls each receipt back in the repository that issued it. Both
   * repositories are attempted, so one failing never strands the other's
   * deferred versions.
   */
  async rollbackVersions(
    receipts: DeferredWriteReceipt[],
  ): Promise<void> {
    const errors: unknown[] = [];
    try {
      for (const repo of [this.persistent, this.ephemeral]) {
        const issued = this.receiptsIssuedBy(repo, receipts);
        if (issued.length === 0) continue;
        try {
          await repo.rollbackVersions(issued);
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.forgetDeferredIssuers(receipts);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Rolling back deferred writes failed");
    }
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

function deferredKey(receipt: DeferredWriteReceipt): string {
  return [
    receipt.type.normalized,
    receipt.modelId,
    receipt.dataName,
    receipt.version,
  ].join("\0");
}
