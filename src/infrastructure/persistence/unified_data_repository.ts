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

import { existsSync } from "@std/fs";
import { join, relative, resolve, SEPARATOR } from "@std/path";
import { dirname as posixDirname } from "@std/path/posix";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import {
  signalChange,
  stageTyped,
  typedStagingActive,
  unitAdmitsKey,
  versionFloorSource,
  withChangeSignalled,
} from "./unit_of_work_scope.ts";
import type { StagedChange } from "../../domain/datastore/unit_of_work.ts";
import type {
  ContentSource,
  TypedChange,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  type FileAccess,
  fileAccessOf,
} from "../../domain/datastore_v3/file_access.ts";
import { MAX_INLINE_BYTES } from "../../domain/datastore_v3/op.ts";
import {
  type DataRemoval,
  type DataVersionFile,
  type DataWrite,
  ModelChanges,
} from "../../domain/datastore_v3/repository_changes.ts";
import {
  atomicWriteFile,
  type AtomicWriteSync,
  atomicWriteTextFile,
  syncExistingFile,
  syncWrittenDirectory,
  syncWrittenFile,
  writeSyncedTempFile,
} from "./atomic_write.ts";
import { makeDirectories } from "./make_directories.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import {
  assertContainedPath,
  assertSafePath,
  resolveRealPath,
} from "./safe_path.ts";
import { verifiedContentStream } from "./verified_content_stream.ts";
import { isProcessGone, processHostIdentity } from "../runtime/process.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  Data,
  type DataId,
  type DataMetadata,
  generateDataId,
  isReservedDataName,
  type OwnerDefinition,
  parseDataDuration,
} from "../../domain/data/mod.ts";
import {
  coerceModelType,
  ModelType,
  type ModelTypeInput,
} from "../../domain/models/model_type.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";
import { maxOf } from "../../domain/array_extrema.ts";
import type {
  HydrateFileHook,
  MarkDirtyHook,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
import type { CatalogStore } from "./catalog_store.ts";
import { type Namespace, SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import {
  type AgedDataVersionPage,
  type ContentAvailability,
  type DeferredWriteReceipt,
  type FindAllForTypeOptions,
  type FindAllGlobalOptions,
  type FindVersionsCreatedBeforeOptions,
  type ForeignContentFetcher,
  type GarbageCollectionResult,
  OwnershipValidationError,
  type RenameForward,
  type UnifiedDataRepository,
} from "../../domain/data/repositories.ts";
import { garbageCollectionToColumn } from "../../domain/data/data_metadata.ts";
import { assertKindContinues } from "../../domain/data/data_kind.ts";
import { computeLatestFlags } from "../../domain/data/data_query_service.ts";
import {
  isRestatement,
  versionsBeyondKeep,
} from "../../domain/data/keep_last_versions.ts";
import { currentDiagnosticTally } from "../../domain/diagnostics/diagnostic_phase.ts";
import {
  describeUnreadableVersionReason,
  type LatestMarkerState,
  type UnreadableVersionReason,
} from "../../domain/data/unreadable_data_version.ts";

/**
 * versions start at 1, so no write is ever allocated 0 and reads through the
 * marker find nothing
 */
const NO_PROMOTED_VERSION = 0;

// re-exported so importers of the infra path keep working; new domain code
// imports from domain/data/repositories.ts
export {
  type GarbageCollectionResult,
  OwnershipValidationError,
  type UnifiedDataRepository,
};

const logger = getSwampLogger(["data", "repository"]);

const DATA_VERSION_FILES: readonly DataVersionFile[] = ["metadata.yaml", "raw"];

interface DurableRecord {
  readonly type: ModelType;
  readonly modelId: string;
  readonly dataName: string;
  readonly version: number;
}

/**
 * warned once per process, so a command reading a version twice, or serve's
 * repeated sweeps, does not repeat the warning
 */
const warnedUnreadableVersions = new Set<string>();

export interface DataNameKey {
  type: ModelType;
  modelId: string;
  dataName: string;
}

export interface VersionInspection {
  reason?: UnreadableVersionReason;
  modelName?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function looksLikeModelId(name: string): boolean {
  return UUID_RE.test(name);
}

/**
 * a numeric directory is either a version or a numeric data name, so confirm it
 * holds metadata.yaml; otherwise the walk mistakes the type dir for a model-id
 * dir and drops data, which backfill then deletes
 */
async function hasVersionMetadata(versionDir: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(join(versionDir, "metadata.yaml"));
    return stat.isFile;
  } catch {
    return false;
  }
}

/**
 * walks visit a level in this order so every filesystem walks identically:
 * readdir order is sorted on APFS and NTFS but hash order on ext4, and backfill
 * inserts rows in walk order
 */
export function sortedSubdirectoryNames(
  entries: Iterable<Pick<Deno.DirEntry, "name" | "isDirectory">>,
): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) names.push(entry.name);
  }
  return names.sort();
}

async function listSubdirectories(dir: string): Promise<string[]> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) entries.push(entry);
  return sortedSubdirectoryNames(entries);
}

function listSubdirectoriesSync(dir: string): string[] {
  return sortedSubdirectoryNames(Deno.readDirSync(dir));
}

/**
 * the remote's copy is short too while another host has pushed metadata but not
 * yet content, so a short file is used as is for this window before the next
 * read downloads it again
 */
export const ACCEPTED_SHORT_CONTENT_TTL_MS = 30_000;

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await Deno.stat(path)).size;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function fileSizeSync(path: string): number | null {
  try {
    return Deno.statSync(path).size;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function hasVersionMetadataSync(versionDir: string): boolean {
  try {
    return Deno.statSync(join(versionDir, "metadata.yaml")).isFile;
  } catch {
    return false;
  }
}

/**
 * holds a data name's version floor beside its directory; .. never occurs in a
 * data name, so it cannot collide
 */
export const VERSION_FLOOR_SUFFIX = "..version-floor";

export class FileSystemUnifiedDataRepository implements UnifiedDataRepository {
  private readonly baseDir: string;

  constructor(
    private readonly repoDir: string,
    baseDir: string | undefined,
    private readonly catalogStore: CatalogStore,
    private readonly markDirty?: MarkDirtyHook,
    private readonly hydrateFile?: HydrateFileHook,
    /**
     * direct construction sites default to SOLO_NAMESPACE and an un-namespaced
     * layout until they thread the configured namespace through in lockstep
     * with the path resolver
     */
    public readonly namespace: Namespace = SOLO_NAMESPACE,
    private readonly enableWriteGc: boolean = false,
    private readonly now: () => number = Date.now,
    public readonly fetchForeignContent?: ForeignContentFetcher,
    /**
     * content the datastore could not materialise from absent content;
     * consulted only when a content read finds no file
     */
    public readonly unreadableContent?: UnreadableContentLookup,
    /**
     * off unless the datastore config or SWAMP_DATASTORE_DURABLE turns it on;
     * off, a write is atomic but not synced
     */
    private readonly durable: boolean = false,
    private readonly durableWriteHooks: AtomicWriteSync = {},
  ) {
    this.baseDir = baseDir ?? swampPath(repoDir, SWAMP_SUBDIRS.data);
  }

  /**
   * the workflow service hands it to the repositories it builds, so they sync
   * the same way
   */
  get writeSync(): AtomicWriteSync {
    return this.durableWriteHooks;
  }

  /**
   * on v3 a record the unit commits stays unsynced, as commits are durable and
   * replay rewrites the checkout; a record kept local by the datastore filter
   * is never committed, so it syncs as on v2
   */
  private durableSync(record: DurableRecord): AtomicWriteSync | undefined {
    if (!this.durable) return undefined;
    return typedStagingActive(this.markDirty) && this.replayed(record)
      ? undefined
      : this.durableWriteHooks;
  }

  /**
   * one key kept local is enough to sync the whole version: replay rewrites the
   * others, but not that one nor the directory entries reaching it
   */
  private replayed(record: DurableRecord): boolean {
    const changes = new ModelChanges(record.type, record.modelId);
    const keys = [
      changes.latestKey(record.dataName),
      ...DATA_VERSION_FILES.map((file) =>
        changes.dataKey(record.dataName, record.version, file)
      ),
    ];
    return keys.every((key) => unitAdmitsKey(this.markDirty, key.toString()));
  }

  private async syncDir(sync: AtomicWriteSync, dir: string): Promise<void> {
    await syncWrittenDirectory(dir, sync);
  }

  /**
   * syncs the data-name and model directories, so a data-name directory that GC
   * removed and a save recreated is durable before either writer publishes
   * under it
   */
  private async syncVersionReach(
    sync: AtomicWriteSync,
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<void> {
    await settleAll([
      this.syncDir(sync, this.getDataNameDir(type, modelId, dataName)),
      this.syncDir(sync, this.getModelDataDir(type, modelId)),
    ]);
  }

  private async syncWrittenContent(
    sync: AtomicWriteSync | undefined,
    contentPath: string,
    options: { contentSynced?: boolean } | undefined,
  ): Promise<void> {
    if (sync === undefined || options?.contentSynced) return;
    await syncExistingFile(contentPath, sync);
  }

  private async writeVersionFiles(
    sync: AtomicWriteSync | undefined,
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    metadataContent: string,
    content: Uint8Array,
  ): Promise<void> {
    const metadataPath = this.getMetadataPath(type, modelId, dataName, version);
    const contentPath = this.getContentPath(type, modelId, dataName, version);
    await assertSafePath(metadataPath, this.baseDir);
    await assertSafePath(contentPath, this.baseDir);
    if (sync === undefined) {
      await atomicWriteTextFile(metadataPath, metadataContent);
      await atomicWriteFile(contentPath, content);
      return;
    }
    const files = { ...sync, syncParent: false };
    await settleAll([
      atomicWriteTextFile(metadataPath, metadataContent, { sync: files }),
      atomicWriteFile(contentPath, content, { sync: files }),
    ]);
    await this.syncDir(sync, this.getPath(type, modelId, dataName, version));
    await this.syncVersionReach(sync, type, modelId, dataName);
  }

  private readonly acceptedShort = new Map<string, number>();

  private async stage(change: StagedChange): Promise<void> {
    await signalChange(this.markDirty, change, { typed: true });
  }

  /**
   * signals before the write and, on v2, again after it, so a push that ran
   * while the write was in flight cannot have cleared the mark for good
   */
  private staged<T>(
    changes: StagedChange | readonly StagedChange[],
    write: () => Promise<T>,
  ): Promise<T> {
    return withChangeSignalled(this.markDirty, changes, { typed: true }, write);
  }

  private async stageTypedChanges(
    type: ModelType,
    modelId: string,
    build: (changes: ModelChanges) => Promise<readonly TypedChange[]>,
  ): Promise<void> {
    await stageTyped(
      this.markDirty,
      () => build(new ModelChanges(type, modelId)),
    );
  }

  private async writtenVersionChanges(
    changes: ModelChanges,
    why: DataWrite,
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    metadataExpect?: { readonly sha256: string },
  ): Promise<TypedChange[]> {
    const metadataBytes = await Deno.readFile(
      this.getMetadataPath(type, modelId, dataName, version),
    );
    const metadata = parseYaml(new TextDecoder().decode(metadataBytes));
    const raw = await this.rawSource(
      this.getContentPath(type, modelId, dataName, version),
      metadata,
    );
    return changes.writeVersion(why, {
      name: dataName,
      version,
      metadata,
      metadataBytes,
      metadataExpect,
      raw: raw.content,
      ...(raw.access === undefined ? {} : { rawAccess: raw.access }),
    });
  }

  /**
   * the stream is checked against the file's size and checksum, so a file
   * changed before the commit is never committed under metadata that does not
   * describe it
   */
  private async rawSource(
    contentPath: string,
    metadata: unknown,
  ): Promise<{ content: ContentSource; access?: FileAccess }> {
    const { size, mode } = await Deno.stat(contentPath);
    const access = fileAccessOf(mode);
    const withAccess = (content: ContentSource) =>
      access === undefined ? { content } : { content, access };
    if (size <= MAX_INLINE_BYTES) {
      return withAccess(await Deno.readFile(contentPath));
    }
    const recorded = metadata as { size?: unknown; checksum?: unknown } | null;
    const sha256 = recorded?.size === size &&
        typeof recorded.checksum === "string"
      ? recorded.checksum
      : undefined;
    return withAccess(async () =>
      verifiedContentStream(
        (await Deno.open(contentPath)).readable,
        contentPath,
        {
          size,
          ...(sha256 !== undefined ? { sha256 } : {}),
        },
      )
    );
  }

  private async readLatestMarkerBytes(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<Uint8Array | undefined> {
    try {
      return await Deno.readFile(
        join(this.getDataNameDir(type, modelId, dataName), "latest"),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  private async latestAfterWrite(
    changes: ModelChanges,
    why: DataWrite,
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<TypedChange[]> {
    const bytes = await this.readLatestMarkerBytes(type, modelId, dataName);
    if (
      bytes === undefined ||
      Number(new TextDecoder().decode(bytes).trim()) !== version
    ) {
      return [];
    }
    return [changes.latestPut(why, dataName, version, bytes)];
  }

  private async latestAfterRemoval(
    changes: ModelChanges,
    why: DataRemoval,
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<TypedChange[]> {
    const bytes = await this.readLatestMarkerBytes(type, modelId, dataName);
    if (bytes === undefined) return [changes.removeLatest(why, dataName)];
    return [
      changes.latestPut(
        { kind: why },
        dataName,
        Number(new TextDecoder().decode(bytes).trim()),
        bytes,
      ),
    ];
  }

  private async stageRemovedVersion(
    why: DataRemoval,
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<void> {
    await this.stageTypedChanges(
      type,
      modelId,
      (changes) =>
        Promise.resolve(changes.removeVersion(why, dataName, version)),
    );
  }

  private async stageLatestAfterRemoval(
    why: DataRemoval,
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<void> {
    await this.stageTypedChanges(
      type,
      modelId,
      (changes) =>
        this.latestAfterRemoval(changes, why, type, modelId, dataName),
    );
  }

  private async stagePromotedVersion(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    hasMetadata: boolean,
  ): Promise<void> {
    const why: DataWrite = { kind: "data.save" };
    await this.stageTypedChanges(type, modelId, async (changes) => {
      const contentPath = this.getContentPath(
        type,
        modelId,
        dataName,
        version,
      );
      let files: TypedChange[] = [];
      if (hasMetadata) {
        files = await this.writtenVersionChanges(
          changes,
          why,
          type,
          modelId,
          dataName,
          version,
        );
      } else if (existsSync(contentPath)) {
        const raw = await this.rawSource(contentPath, undefined);
        files = [
          changes.writeContent(
            why,
            dataName,
            version,
            raw.content,
            raw.access,
          ),
        ];
      }
      return [
        ...files,
        ...await this.latestAfterWrite(
          changes,
          why,
          type,
          modelId,
          dataName,
          version,
        ),
      ];
    });
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
      is_step_latest: 1,
      model_name: data.tags["modelName"] ?? "",
      spec_name: data.tags["specName"] ?? "",
      data_type: data.tags["type"] ?? "",
      content_type: data.contentType,
      lifetime: data.lifetime,
      garbage_collection: garbageCollectionToColumn(data.garbageCollection),
      lifecycle: data.lifecycle,
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
    this.catalogStore.recordLocalWrite();
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
    this.catalogStore.removeRename(
      this.namespace,
      type.normalized,
      modelId,
      dataName,
    );
    this.catalogStore.recordLocalWrite();
  }

  /**
   * files are authoritative and the catalog is a projection the next backfill
   * rebuilds, so a failed write only logs
   */
  private recordRenameForward(
    type: ModelType,
    modelId: string,
    dataName: string,
    renamedTo: string,
  ): void {
    try {
      this.catalogStore.recordRename({
        namespace: this.namespace,
        type_normalized: type.normalized,
        model_id: modelId,
        data_name: dataName,
        renamed_to: renamedTo,
      });
    } catch (error) {
      logger
        .warn`Could not record the rename forward ${dataName} -> ${renamedTo} in the data catalog: ${error}. A query by the old name finds the new one after the catalog is next rebuilt.`;
    }
  }

  /**
   * walked in name order at each level so a freshly backfilled catalog has the
   * same rowid order on every filesystem
   */
  async findAllGlobal(options?: FindAllGlobalOptions): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > {
    const results: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    const baseDir = this.getBaseDir();

    await this.collectAllData(
      baseDir,
      [],
      results,
      undefined,
      options?.renames,
    );

    return results;
  }

  async findAllForType(
    type: ModelTypeInput,
    options?: FindAllForTypeOptions,
  ): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > {
    const modelType = coerceModelType(type);
    const typeDir = this.getTypeDir(modelType);
    const results: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];

    try {
      for (const modelId of await listSubdirectories(typeDir)) {
        try {
          const unreadable = options?.unreadable;
          const dataItems = unreadable
            ? await this.collectModelData(
              modelType,
              modelId,
              undefined,
              (dataName, error) =>
                unreadable.push({ modelType, modelId, dataName, error }),
            )
            : await this.findAllForModel(modelType, modelId);
          for (const data of dataItems) {
            results.push({ data, modelType, modelId });
          }
        } catch (error) {
          options?.unreadable?.push({ modelType, modelId, error });
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return results;
  }

  /**
   * the catalog does not track createdAt, so metadata.yaml is the source for
   * time-bounded filtering; an mtime pre-filter skips old files unparsed
   */
  async findAllGlobalSince(
    cutoff: Date,
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>> {
    const results: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    const baseDir = this.getBaseDir();

    await this.collectAllData(baseDir, [], results, cutoff);

    return results;
  }

  private async collectAllData(
    currentDir: string,
    pathSegments: string[],
    results: Array<{ data: Data; modelType: ModelType; modelId: string }>,
    cutoff?: Date,
    renames?: RenameForward[],
  ): Promise<void> {
    try {
      const entries = await listSubdirectories(currentDir);

      for (const name of entries) {
        const childPath = join(currentDir, name);
        const childSegments = [...pathSegments, name];

        const isModelIdDir = await this.isModelIdDirectory(childPath);

        if (isModelIdDir && childSegments.length >= 2) {
          const typeSegments = pathSegments;
          const modelId = name;
          const typeStr = typeSegments.join("/");

          try {
            const modelType = ModelType.create(typeStr);
            const dataItems = cutoff
              ? await this.findAllForModelSince(modelType, modelId, cutoff)
              : await this.collectModelData(modelType, modelId, renames);
            for (const data of dataItems) {
              results.push({ data, modelType, modelId });
            }
          } catch {
            // an invalid model type drops every item below it from the walk;
            // logged because a silent drop reads as no data and the catalog
            // backfill then deletes the model's rows
            logger
              .debug`Skipping ${childPath} during walk: ${typeStr} is not a valid model type. If data is missing from data query, run swamp doctor datastores --repair.`;
          }
        } else {
          await this.collectAllData(
            childPath,
            childSegments,
            results,
            cutoff,
            renames,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  iterateDataNames(): AsyncIterable<DataNameKey> {
    return this.walkDataNames(this.getBaseDir(), []);
  }

  private async *walkDataNames(
    currentDir: string,
    pathSegments: string[],
  ): AsyncIterable<DataNameKey> {
    let entries: string[];
    try {
      entries = await listSubdirectories(currentDir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const name of entries) {
      const childPath = join(currentDir, name);
      const childSegments = [...pathSegments, name];
      if (
        childSegments.length >= 2 && await this.isModelIdDirectory(childPath)
      ) {
        let type: ModelType;
        try {
          type = ModelType.create(pathSegments.join("/"));
        } catch {
          continue;
        }
        let dataNames: string[];
        try {
          dataNames = await listSubdirectories(childPath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        for (const dataName of dataNames) {
          yield { type, modelId: name, dataName };
        }
      } else {
        yield* this.walkDataNames(childPath, childSegments);
      }
    }
  }

  private async findAllForModelSince(
    type: ModelType,
    modelId: string,
    cutoff: Date,
  ): Promise<Data[]> {
    const dataDir = this.getModelDataDir(type, modelId);
    const results: Data[] = [];
    const seen = new Set<string>();
    const cutoffMs = cutoff.getTime();

    try {
      for (const dataName of await listSubdirectories(dataDir)) {
        const latestVersion = await this.getLatestVersion(
          type,
          modelId,
          dataName,
        );
        if (latestVersion === null) continue;

        const metadataPath = this.getMetadataPath(
          type,
          modelId,
          dataName,
          latestVersion,
        );

        try {
          const stat = await Deno.stat(metadataPath);
          const mtimeMs = stat.mtime?.getTime();
          if (mtimeMs !== undefined && mtimeMs < cutoffMs) continue;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }

        const data = await this.findByName(type, modelId, dataName);
        if (!data) continue;
        if (data.createdAt.getTime() < cutoffMs) continue;
        if (seen.has(data.name)) continue;

        seen.add(data.name);
        results.push(data);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return results;
  }

  private async isModelIdDirectory(dir: string): Promise<boolean> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isDirectory && !entry.isSymlink) continue;

        // latest is not checked here: a data item can be named latest, which
        // would make a type directory look like a model-id directory
        const childPath = join(dir, entry.name);
        try {
          for await (const subEntry of Deno.readDir(childPath)) {
            if (!subEntry.isDirectory || !/^\d+$/.test(subEntry.name)) continue;
            if (await hasVersionMetadata(join(childPath, subEntry.name))) {
              return true;
            }
          }
        } catch {
          // Skip unreadable directories
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return false;
  }

  findByName(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Data | null> {
    return this.findByNameWithDepth(
      coerceModelType(type),
      modelId,
      dataName,
      version,
      0,
    );
  }

  /**
   * with strict, a metadata file that parses to nothing throws SyntaxError and
   * one missing from an existing version throws NotFound, instead of reading as
   * no data
   */
  private async findByNameWithDepth(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number | undefined,
    depth: number,
    strict = false,
  ): Promise<Data | null> {
    const versionToRead = version ?? (await this.getLatestVersion(
      type,
      modelId,
      dataName,
    ));
    if (versionToRead === null) return null;

    const metadataPath = this.getMetadataPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );
    await this.assertModelReadPath(metadataPath, type, modelId);
    try {
      const content = await Deno.readTextFile(metadataPath);
      const metadata = parseYaml(content) as DataMetadata | null;
      if (!metadata) {
        if (strict) {
          throw new SyntaxError(
            `metadata.yaml of ${dataName} version ${versionToRead} is empty`,
          );
        }
        this.warnUnreadableVersion(
          type,
          modelId,
          dataName,
          versionToRead,
          "metadata_empty",
        );
        return null;
      }
      const data = Data.fromData(metadata);

      if (version === undefined && data.isRenamed && data.renamedTo) {
        if (depth >= 5) {
          logger
            .warn`Rename chain depth exceeded for ${dataName} (behavior ${modelId}). Data exists but is unreachable — simplify the rename chain.`;
          return null;
        }
        return this.findByNameWithDepth(
          type,
          modelId,
          data.renamedTo,
          undefined,
          depth + 1,
          strict,
        );
      }

      return data;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        if (strict) {
          throw new Deno.errors.NotFound(
            `metadata.yaml of ${dataName} version ${versionToRead} is missing`,
          );
        }
        return null;
      }
      throw error;
    }
  }

  async findById(
    type: ModelType,
    modelId: string,
    dataId: DataId,
    version?: number,
  ): Promise<Data | null> {
    const dataDir = this.getModelDataDir(type, modelId);
    try {
      for await (const entry of Deno.readDir(dataDir)) {
        if (!entry.isDirectory) continue;
        const dataName = entry.name;

        const data = await this.findByName(type, modelId, dataName, version);
        if (data && data.id === dataId) {
          return data;
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
    return null;
  }

  async listVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number[]> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    const versions: number[] = [];

    try {
      for await (const entry of Deno.readDir(dataNameDir)) {
        if (!entry.isDirectory) continue;
        if (entry.name === "latest") continue;

        const version = parseInt(entry.name, 10);
        if (!isNaN(version) && version > 0) {
          versions.push(version);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return versions.sort((a, b) => a - b);
  }

  async findAllForModel(
    type: ModelTypeInput,
    modelId: string,
  ): Promise<Data[]> {
    if (!isUuid(modelId)) {
      logger
        .debug`findAllForModel called with model name ${modelId} instead of a UUID — use context.readModelData(${modelId}) for cross-model access by name`;
    }
    return await this.collectModelData(coerceModelType(type), modelId);
  }

  async *iterateForModel(
    type: ModelTypeInput,
    modelId: string,
  ): AsyncIterable<Data> {
    if (!isUuid(modelId)) {
      logger
        .debug`iterateForModel called with model name ${modelId} instead of a UUID — use context.readModelData(${modelId}) for cross-model access by name`;
    }
    const coerced = coerceModelType(type);
    let dataNames: string[];
    try {
      dataNames = await listSubdirectories(
        this.getModelDataDir(coerced, modelId),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    const seen = new Set<string>();
    for (const dataName of dataNames) {
      const found: Data[] = [];
      await this.collectDataName(coerced, modelId, dataName, found, seen, {
        strict: false,
      });
      yield* found;
    }
  }

  private async collectModelData(
    type: ModelType,
    modelId: string,
    renames?: RenameForward[],
    skipped?: (dataName: string, error: unknown) => void,
  ): Promise<Data[]> {
    const dataDir = this.getModelDataDir(type, modelId);
    const results: Data[] = [];
    const seen = new Set<string>();

    try {
      for (const dataName of await listSubdirectories(dataDir)) {
        if (!skipped) {
          await this.collectDataName(type, modelId, dataName, results, seen, {
            renames,
            strict: false,
          });
          continue;
        }
        try {
          await this.collectDataName(type, modelId, dataName, results, seen, {
            renames,
            strict: true,
          });
        } catch (error) {
          skipped(dataName, error);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return results;
  }

  private async collectDataName(
    type: ModelType,
    modelId: string,
    dataName: string,
    results: Data[],
    seen: Set<string>,
    { renames, strict }: { renames?: RenameForward[]; strict: boolean },
  ): Promise<void> {
    const latest = await this.getLatestVersion(type, modelId, dataName);
    let data = latest === null ? null : await this.findByNameWithDepth(
      type,
      modelId,
      dataName,
      latest,
      0,
      strict,
    );
    if (data?.isRenamed && data.renamedTo) {
      renames?.push({
        modelType: type,
        modelId,
        dataName,
        renamedTo: data.renamedTo,
      });
      data = await this.findByNameWithDepth(
        type,
        modelId,
        data.renamedTo,
        undefined,
        1,
        strict,
      );
    }
    if (data && !seen.has(data.name)) {
      seen.add(data.name);
      results.push(data);
    }
  }

  save(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<{ version: number; checksum?: string }> {
    return this.saveVersion(type, modelId, data, content, {
      kind: "data.save",
    });
  }

  private async saveVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
    stageAs: DataWrite | undefined,
  ): Promise<{ version: number; checksum?: string }> {
    if (isReservedDataName(data.name)) {
      throw new Error(
        `Data name '${data.name}' is reserved for internal use. Use a different name.`,
      );
    }

    return await this.staged({
      kind: "write",
      path: this.getDataNameDir(type, modelId, data.name),
    }, async () => {
      await this.assertWritable(type, modelId, data);

      const { version: newVersion, priorVersions } = await this
        .atomicAllocateVersionDir(
          type,
          modelId,
          data.name,
        );

      const checksum = await this.computeChecksum(content);
      const dataToSave = data.withNewVersion({
        version: newVersion,
        size: content.length,
        checksum,
      });

      const metadata = dataToSave.toData();
      const cleanData = JSON.parse(JSON.stringify(metadata));
      const metadataContent = stringifyYaml(
        cleanData as Record<string, unknown>,
      );
      await this.writeVersionFiles(
        this.durableSync({
          type,
          modelId,
          dataName: data.name,
          version: newVersion,
        }),
        type,
        modelId,
        data.name,
        newVersion,
        metadataContent,
        content,
      );

      await this.advanceLatestMarker(
        type,
        modelId,
        data.name,
        newVersion,
        () => this.catalogUpsert(type, modelId, dataToSave),
      );

      // staged before the prune below, so a failed prune never leaves the
      // version local-only
      if (stageAs !== undefined) {
        await this.stageTypedChanges(type, modelId, async (changes) => [
          ...await this.writtenVersionChanges(
            changes,
            stageAs,
            type,
            modelId,
            data.name,
            newVersion,
          ),
          ...await this.latestAfterWrite(
            changes,
            stageAs,
            type,
            modelId,
            data.name,
            newVersion,
          ),
        ]);
      }

      this.catalogUpsert(type, modelId, dataToSave);

      if (this.enableWriteGc && typeof data.garbageCollection === "number") {
        await this.pruneExcessVersions(
          type,
          modelId,
          data.name,
          priorVersions,
          data.garbageCollection,
        );
      }

      return typedStagingActive(this.markDirty)
        ? { version: newVersion, checksum }
        : { version: newVersion };
    });
  }

  async saveDeferred(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<DeferredWriteReceipt> {
    if (isReservedDataName(data.name)) {
      throw new Error(
        `Data name '${data.name}' is reserved for internal use. Use a different name.`,
      );
    }

    return await this.staged({
      kind: "write",
      path: this.getDataNameDir(type, modelId, data.name),
    }, async () => {
      await this.assertWritable(type, modelId, data);

      const checksum = await this.computeChecksum(content);
      const { version: newVersion } = await this.atomicAllocateVersionDir(
        type,
        modelId,
        data.name,
      );

      const dataToSave = data.withNewVersion({
        version: newVersion,
        size: content.length,
        checksum,
      });
      try {
        // registered as pending before any file reaches disk, so delete and GC
        // never mistake the new version for a promoted one
        this.upsertPendingRow(type, modelId, dataToSave);

        const metadata = dataToSave.toData();
        const cleanData = JSON.parse(JSON.stringify(metadata));
        const metadataContent = stringifyYaml(
          cleanData as Record<string, unknown>,
        );
        // durable on v2 before the receipt returns, so promotion only settles a
        // synced version
        await this.writeVersionFiles(
          this.durableSync({
            type,
            modelId,
            dataName: data.name,
            version: newVersion,
          }),
          type,
          modelId,
          data.name,
          newVersion,
          metadataContent,
          content,
        );
      } catch (error) {
        // no receipt reaches the caller, so nothing else would roll this
        // version back
        await this.rollbackKeepingError([
          { type, modelId, dataName: data.name, version: newVersion },
        ]);
        throw error;
      }

      return { type, modelId, dataName: data.name, version: newVersion };
    });
  }

  async append(
    type: ModelType,
    modelId: string,
    dataName: string,
    content: Uint8Array,
  ): Promise<void> {
    return await this.staged({
      kind: "write",
      path: this.getDataNameDir(type, modelId, dataName),
    }, async () => {
      const latestVersion = await this.getLatestVersion(
        type,
        modelId,
        dataName,
      );
      if (latestVersion === null) {
        throw new Error(`No existing data found for "${dataName}"`);
      }

      const data = await this.findByName(
        type,
        modelId,
        dataName,
        latestVersion,
      );
      if (!data?.streaming) {
        throw new Error(`Data "${dataName}" is not configured for streaming`);
      }

      // appending to a missing or stale content file would write new bytes
      // after a truncated prefix, record that size, and push the corrupt file
      const availability = await this.ensureContentFile(
        type,
        modelId,
        dataName,
        latestVersion,
        data.size,
      );
      if (availability !== "current") {
        throw new Error(
          availability === "missing"
            ? `Cannot append to "${dataName}" version ${latestVersion}: its ` +
              `content could not be downloaded from the datastore`
            : `Cannot append to "${dataName}" version ${latestVersion}: the ` +
              `datastore holds less content than its metadata records, so ` +
              `another host's push may not have finished; retry once it has`,
        );
      }

      const contentPath = this.getContentPath(
        type,
        modelId,
        dataName,
        latestVersion,
      );
      await assertSafePath(contentPath, this.baseDir);
      // on v3 the metadata put expects the digest it replaces, so a version
      // another writer recorded under this number refuses it; read before the
      // rewrite destroys it
      const priorMetadata = typedStagingActive(this.markDirty)
        ? await this.computeChecksum(
          await Deno.readFile(
            this.getMetadataPath(type, modelId, dataName, latestVersion),
          ),
        )
        : undefined;
      const sync = this.durableSync({
        type,
        modelId,
        dataName,
        version: latestVersion,
      });
      const file = await Deno.open(contentPath, { append: true });
      try {
        await file.write(content);
        // on v2 the appended bytes are synced on the handle that wrote them,
        // before the metadata and catalog record the new size
        if (sync !== undefined) {
          await syncWrittenFile(
            file,
            { temp: contentPath, target: contentPath },
            sync,
          );
        }
      } finally {
        file.close();
      }

      const stat = await Deno.stat(contentPath);
      const metadataPath = this.getMetadataPath(
        type,
        modelId,
        dataName,
        latestVersion,
      );
      const metadata = data.toData();
      metadata.size = stat.size;
      // stale checksum dropped: the content changed and recomputing it would
      // read the whole file into memory
      delete metadata.checksum;
      const cleanData = JSON.parse(JSON.stringify(metadata));
      await atomicWriteTextFile(
        metadataPath,
        stringifyYaml(cleanData as Record<string, unknown>),
        sync === undefined ? undefined : { sync },
      );

      const updatedData = Data.fromData(metadata);
      this.catalogUpsert(type, modelId, updatedData);

      await this.stageTypedChanges(
        type,
        modelId,
        (changes) =>
          this.writtenVersionChanges(
            changes,
            { kind: "data.append" },
            type,
            modelId,
            dataName,
            latestVersion,
            priorMetadata === undefined ? undefined : { sha256: priorMetadata },
          ),
      );
    });
  }

  async *stream(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): AsyncIterable<Uint8Array> {
    const versionToRead = version ??
      await this.getLatestVersion(type, modelId, dataName);
    if (versionToRead === null) return;

    const contentPath = this.getContentPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );
    // ensures content first, so a never-pulled file does not stream as empty
    // and a stale one does not stream its old bytes
    await this.ensureContentFile(type, modelId, dataName, versionToRead);

    try {
      const file = await Deno.open(contentPath, { read: true });
      try {
        const buffer = new Uint8Array(8192);
        while (true) {
          const bytesRead = await file.read(buffer);
          if (bytesRead === null) break;
          yield buffer.slice(0, bytesRead);
        }
      } finally {
        file.close();
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        await this.throwIfUnreadable(contentPath);
        return;
      }
      throw error;
    }
  }

  async getContent(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null> {
    if (!isUuid(modelId)) {
      logger
        .debug`getContent called with model name ${modelId} instead of a UUID — use context.readModelData(${modelId}) for cross-model access by name`;
    }
    type = coerceModelType(type);
    const versionToRead = version ??
      await this.getLatestVersion(type, modelId, dataName);
    if (versionToRead === null) return null;

    const contentPath = this.getContentPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );
    await this.assertModelReadPath(contentPath, type, modelId);
    await this.ensureContentFile(type, modelId, dataName, versionToRead);
    await this.assertModelReadPath(contentPath, type, modelId);
    try {
      const bytes = await Deno.readFile(contentPath);
      if (bytes.length === 0) {
        this.warnEmptyContent(type, modelId, dataName, versionToRead);
      }
      return bytes;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        await this.throwIfUnreadable(contentPath);
        this.warnMissingContent(type, modelId, dataName, versionToRead);
        return null;
      }
      throw error;
    }
  }

  private async throwIfUnreadable(contentPath: string): Promise<void> {
    const error = await this.unreadableContent?.(contentPath);
    if (error !== undefined) throw error;
  }

  async ensureContentLocal(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
    knownSize?: number,
  ): Promise<ContentAvailability> {
    if (!this.hydrateFile && !this.unreadableContent) return "current";
    const modelType = coerceModelType(type);
    const versionToRead = version ??
      await this.getLatestVersion(modelType, modelId, dataName);
    if (!this.hydrateFile) {
      // synchronous readers must fail loudly on a record the datastore could
      // not materialise rather than read it as empty; only an absent file is
      // looked up
      if (versionToRead !== null) {
        const contentPath = this.getContentPath(
          modelType,
          modelId,
          dataName,
          versionToRead,
        );
        if ((await fileSize(contentPath)) === null) {
          await this.throwIfUnreadable(contentPath);
        }
      }
      return "current";
    }
    if (versionToRead === null) return "missing";
    return await this.ensureContentFile(
      modelType,
      modelId,
      dataName,
      versionToRead,
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
    if (!this.hydrateFile) {
      this.warnShortContent(type, modelId, dataName, version, size);
      return true;
    }
    const contentPath = this.getContentPath(type, modelId, dataName, version);
    const localSize = fileSizeSync(contentPath);
    if (localSize === null) return false;
    if (localSize >= size) return true;
    return this.isAcceptedShort(contentPath, size);
  }

  /**
   * with a hydrate hook a missing or short file is downloaded; one still short
   * after is the remote's copy and is used for the accepted-short TTL. Without
   * a hook the file is current unlooked-at.
   */
  private async ensureContentFile(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    knownSize?: number,
  ): Promise<ContentAvailability> {
    const hydrate = this.hydrateFile;
    if (!hydrate) return "current";
    const contentPath = this.getContentPath(type, modelId, dataName, version);
    // recorded size is read before the file: a local append writes raw before
    // metadata, so this order never sees a size larger than the file's and
    // replaces a current file
    const recordedSize = knownSize ??
      await this.readRecordedSize(type, modelId, dataName, version);
    let localSize = await fileSize(contentPath);
    let refreshed = false;
    if (localSize === null) {
      if (!(await hydrate(contentPath))) return "missing";
      localSize = await fileSize(contentPath);
      if (localSize === null) return "missing";
      refreshed = true;
    }
    if (recordedSize === undefined || localSize >= recordedSize) {
      return "current";
    }
    if (!refreshed) {
      if (this.isAcceptedShort(contentPath, recordedSize)) {
        return "acceptedShort";
      }
      await hydrate(contentPath);
      localSize = await fileSize(contentPath);
      if (localSize === null) return "missing";
      if (localSize >= recordedSize) return "current";
    }
    logger
      .debug`Content of ${dataName} v${version} is ${localSize} bytes, short of the ${recordedSize} its metadata records, after downloading it; using it as it is`;
    this.acceptedShort.set(
      `${contentPath}\0${recordedSize}`,
      this.now() + ACCEPTED_SHORT_CONTENT_TTL_MS,
    );
    return "acceptedShort";
  }

  private isAcceptedShort(contentPath: string, recordedSize: number): boolean {
    const key = `${contentPath}\0${recordedSize}`;
    const until = this.acceptedShort.get(key);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.acceptedShort.delete(key);
    return false;
  }

  private async readRecordedSize(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<number | undefined> {
    const metadataPath = join(
      this.getPath(type, modelId, dataName, version),
      "metadata.yaml",
    );
    let text: string;
    try {
      text = await Deno.readTextFile(metadataPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    let metadata: { size?: unknown } | null;
    try {
      metadata = parseYaml(text) as { size?: unknown } | null;
    } catch {
      return undefined;
    }
    return typeof metadata?.size === "number" ? metadata.size : undefined;
  }

  async delete(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<void> {
    const tally = currentDiagnosticTally();
    if (version !== undefined) {
      const versionDir = this.getPath(type, modelId, dataName, version);
      let removed = false;
      await tally.measure("change_stage", () =>
        this.staged({
          kind: "remove",
          path: this.getPath(type, modelId, dataName, version),
        }, () =>
          tally.measure("file_remove", async () => {
            try {
              await Deno.remove(versionDir, { recursive: true });
              removed = true;
            } catch (error) {
              if (!(error instanceof Deno.errors.NotFound)) {
                throw error;
              }
            }
          })));
      tally.add("versions_removed", removed ? 1 : 0);

      // drop the catalog row before touching the latest marker, so the catalog
      // stays valid even if the marker update fails
      tally.measureSync("catalog_update", () => {
        this.catalogStore.removeVersion(
          this.namespace,
          type.normalized,
          modelId,
          dataName,
          version,
          computeLatestFlags,
        );
        this.catalogStore.recordLocalWrite();
      });

      await tally.measure("latest_update", async () => {
        const { onDisk, promoted } = await this.listPromotedVersions(
          type,
          modelId,
          dataName,
        );

        const newLatest = maxOf(promoted);
        if (newLatest !== undefined) {
          await this.updateLatestMarker(type, modelId, dataName, newLatest);
          const latestData = await this.findByName(
            type,
            modelId,
            dataName,
            newLatest,
          );
          if (latestData?.isRenamed && latestData.renamedTo) {
            // the rename marker stays latest: the name still forwards, and a
            // marker is not a catalog row
            const forwardTo = latestData.renamedTo;
            tally.measureSync("catalog_update", () => {
              this.catalogRemove(type, modelId, dataName);
              this.recordRenameForward(type, modelId, dataName, forwardTo);
            });
          } else if (latestData) {
            tally.measureSync(
              "catalog_update",
              () => this.catalogUpsert(type, modelId, latestData),
            );
          }
        } else if (onDisk.length > 0) {
          // only in-flight deferred writes remain: point at NO_PROMOTED_VERSION
          // so reads find nothing instead of the highest version on disk;
          // promotion moves the marker forward again
          await this.updateLatestMarker(
            type,
            modelId,
            dataName,
            NO_PROMOTED_VERSION,
          );
        } else {
          // the latest marker goes with the directory, so its removal is staged
          // too; unstaged, a synced datastore keeps a remote latest naming a
          // version that is gone
          const dataNameDir = this.getDataNameDir(type, modelId, dataName);
          await tally.measure("change_stage", () =>
            this.staged(
              { kind: "remove", path: join(dataNameDir, "latest") },
              () =>
                tally.measure(
                  "file_remove",
                  () =>
                    Deno.remove(dataNameDir, { recursive: true }).catch(
                      () => {},
                    ),
                ),
            ));
          tally.measureSync(
            "catalog_update",
            () => this.catalogRemove(type, modelId, dataName),
          );
        }
      });
      await tally.measure("change_stage", async () => {
        await this.stageRemovedVersion(
          "data.delete",
          type,
          modelId,
          dataName,
          version,
        );
        await this.stageLatestAfterRemoval(
          "data.delete",
          type,
          modelId,
          dataName,
        );
      });
    } else {
      // emit per-version-directory removals so the sync service sees individual
      // absent paths it can match against its index; one data-name directory
      // signal maps to no index entry
      const dataNameDir = this.getDataNameDir(type, modelId, dataName);
      let versions: number[] = [];
      let removals: StagedChange[];
      try {
        versions = await tally.measure(
          "version_list",
          () => this.listVersions(type, modelId, dataName),
        );
        removals = versions.map((v) => ({
          kind: "remove",
          path: this.getPath(type, modelId, dataName, v),
        }));
        removals.push({ kind: "remove", path: join(dataNameDir, "latest") });
      } catch {
        removals = [{ kind: "remove", path: dataNameDir }];
      }
      await tally.measure(
        "change_stage",
        () =>
          this.staged(removals, () =>
            tally.measure("file_remove", async () => {
              try {
                await Deno.remove(dataNameDir, { recursive: true });
              } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) {
                  throw error;
                }
              }
            })),
      );
      tally.add("versions_removed", versions.length);
      tally.measureSync(
        "catalog_update",
        () => this.catalogRemove(type, modelId, dataName),
      );
      // each version seen is its own versioned tombstone so a concurrently
      // written version survives; one batch each, so a name with many versions
      // splits across commits
      await tally.measure("change_stage", async () => {
        for (const v of versions) {
          await this.stageRemovedVersion(
            "data.delete",
            type,
            modelId,
            dataName,
            v,
          );
        }
        await this.stageTypedChanges(
          type,
          modelId,
          (changes) =>
            Promise.resolve([changes.removeLatest("data.delete", dataName)]),
        );
      });
    }
  }

  async removeLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<void> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    return await this.staged({ kind: "write", path: dataNameDir }, async () => {
      const latestMarker = join(dataNameDir, "latest");

      try {
        await Deno.remove(latestMarker);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }

      this.catalogRemove(type, modelId, dataName);
      await this.stageTypedChanges(
        type,
        modelId,
        (changes) =>
          Promise.resolve([changes.removeLatest("data.gc", dataName)]),
      );
    });
  }

  async rename(
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
    return await this.staged({
      kind: "write",
      path: this.getDataNameDir(type, modelId, oldName),
    }, async () => {
      const oldData = await this.findByName(type, modelId, oldName);
      if (!oldData) {
        throw new Error(`Data "${oldName}" not found`);
      }
      if (oldData.isDeleted) {
        throw new Error(`Data "${oldName}" is already deleted or renamed`);
      }

      const existingNew = await this.findByName(type, modelId, newName);
      if (existingNew && !existingNew.isDeleted) {
        throw new Error(`Data "${newName}" already exists`);
      }

      const content = await this.getContent(
        type,
        modelId,
        oldName,
        oldData.version,
      );
      if (!content) {
        throw new Error(
          `Content not found for "${oldName}" version ${oldData.version}`,
        );
      }

      const newData = Data.create({
        name: newName,
        contentType: oldData.contentType,
        lifetime: oldData.lifetime,
        garbageCollection: oldData.garbageCollection,
        streaming: oldData.streaming,
        tags: { ...oldData.tags },
        ownerDefinition: { ...oldData.ownerDefinition },
      });

      const { version: newVersion } = await this.saveVersion(
        type,
        modelId,
        newData,
        content,
        undefined,
      );
      let tombstoneVersion = 0;

      // if the tombstone write fails, roll back the new data so old and new
      // names never both hold active data
      try {
        const versions = await this.listVersions(type, modelId, oldName);
        const nextTombstoneVersion = (maxOf(versions) ?? 0) + 1;
        const tombstone = oldData.withRenameMarker({
          version: nextTombstoneVersion,
          renamedTo: newName,
        });

        ({ version: tombstoneVersion } = await this.atomicAllocateVersionDir(
          type,
          modelId,
          oldName,
        ));
        const tombstoneData = tombstone.withNewVersion({
          version: tombstoneVersion,
        });

        const tombstoneContent = new TextEncoder().encode(
          JSON.stringify({
            renamedTo: newName,
            renamedAt: new Date().toISOString(),
          }),
        );

        const metadata = tombstoneData.toData();
        const cleanData = JSON.parse(JSON.stringify(metadata));
        const metadataYaml = stringifyYaml(
          cleanData as Record<string, unknown>,
        );
        await this.writeVersionFiles(
          this.durableSync({
            type,
            modelId,
            dataName: oldName,
            version: tombstoneVersion,
          }),
          type,
          modelId,
          oldName,
          tombstoneVersion,
          metadataYaml,
          tombstoneContent,
        );

        await this.updateLatestMarker(type, modelId, oldName, tombstoneVersion);
      } catch (tombstoneError) {
        logger
          .warn`Tombstone write failed during rename ${oldName} -> ${newName}. Rolling back new data.`;
        try {
          const newVersionDir = this.getPath(
            type,
            modelId,
            newName,
            newVersion,
          );
          await Deno.remove(newVersionDir, { recursive: true });
          // only version: remove the data name directory; otherwise reset
          // latest to the highest remaining version so the marker never points
          // at the deleted one
          const remaining = await this.listVersions(type, modelId, newName);
          const maxRemaining = maxOf(remaining);
          if (maxRemaining === undefined) {
            const dataNameDir = this.getDataNameDir(type, modelId, newName);
            await Deno.remove(dataNameDir, { recursive: true }).catch(() => {});
          } else {
            await this.updateLatestMarker(type, modelId, newName, maxRemaining);
          }
        } catch (rollbackError) {
          logger
            .error`Rollback also failed during rename ${oldName} -> ${newName}: ${
            String(rollbackError)
          }. Manual cleanup may be needed.`;
        }
        // the new version was never staged, so stage the new name's marker as
        // the rollback left it; a staging error must not hide the rename's
        try {
          await this.stageLatestAfterRemoval(
            "data.delete",
            type,
            modelId,
            newName,
          );
        } catch (stageError) {
          logger
            .error`Staging the rollback of rename ${oldName} -> ${newName} failed: ${stageError}`;
        }
        throw tombstoneError;
      }

      // one batch so the rename lands in one commit: the new name's version,
      // the old name's marker version, and each name's latest marker
      const why: DataWrite = {
        kind: "data.rename",
        from: oldName,
        to: newName,
      };
      await this.stageTypedChanges(type, modelId, async (changes) => [
        ...await this.writtenVersionChanges(
          changes,
          why,
          type,
          modelId,
          newName,
          newVersion,
        ),
        ...await this.latestAfterWrite(
          changes,
          why,
          type,
          modelId,
          newName,
          newVersion,
        ),
        ...await this.writtenVersionChanges(
          changes,
          why,
          type,
          modelId,
          oldName,
          tombstoneVersion,
        ),
        ...await this.latestAfterWrite(
          changes,
          why,
          type,
          modelId,
          oldName,
          tombstoneVersion,
        ),
      ]);

      // outside the rollback above: files are authoritative and the catalog is
      // a projection the next backfill rebuilds, so a failed catalog write must
      // never undo the rename
      try {
        this.catalogRemove(type, modelId, oldName);
      } catch (error) {
        logger
          .warn`Could not remove ${oldName} from the data catalog after renaming it to ${newName}: ${error}. Run swamp doctor datastores --repair if data query still lists it.`;
      }
      this.recordRenameForward(type, modelId, oldName, newName);

      return {
        oldName,
        newName,
        copiedVersion: oldData.version,
        newVersion,
      };
    });
  }

  async allocateVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    options?: { deferred?: boolean },
  ): Promise<
    {
      version: number;
      contentPath: string;
      priorVersions: number[];
      durable?: boolean;
      syncContent?: (file: Deno.FsFile) => Promise<void>;
    }
  > {
    if (isReservedDataName(data.name)) {
      throw new Error(
        `Data name '${data.name}' is reserved for internal use. Use a different name.`,
      );
    }

    return await this.staged({
      kind: "write",
      path: this.getDataNameDir(type, modelId, data.name),
    }, async () => {
      await this.assertWritable(type, modelId, data);

      const { version: newVersion, priorVersions } = await this
        .atomicAllocateVersionDir(
          type,
          modelId,
          data.name,
        );

      if (options?.deferred) {
        try {
          this.upsertPendingRow(
            type,
            modelId,
            data.withNewVersion({ version: newVersion, size: 0 }),
          );
        } catch (error) {
          // the writer never gets the allocation, so nothing else would roll
          // the empty version directory back
          await this.rollbackKeepingError([
            { type, modelId, dataName: data.name, version: newVersion },
          ]);
          throw error;
        }
      }

      const contentPath = this.getContentPath(
        type,
        modelId,
        data.name,
        newVersion,
      );

      // on v2 the writer syncs what it streams in through this repository's
      // sync policy; the hook is called bare because the writer names the path
      // in its own error
      const sync = this.durableSync({
        type,
        modelId,
        dataName: data.name,
        version: newVersion,
      });
      const syncFile = sync?.syncFile;
      return {
        version: newVersion,
        contentPath,
        priorVersions,
        durable: sync !== undefined,
        ...(syncFile === undefined ? {} : {
          syncContent: (file: Deno.FsFile) =>
            syncFile(file, { temp: contentPath, target: contentPath }),
        }),
      };
    });
  }

  async finalizeVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
    priorVersions?: number[],
    options?: { contentSynced?: boolean },
  ): Promise<{ size: number; checksum: string }> {
    return await this.staged({
      kind: "write",
      path: this.getPath(type, modelId, data.name, version),
    }, async () => {
      const contentPath = this.getContentPath(
        type,
        modelId,
        data.name,
        version,
      );

      const content = await Deno.readFile(contentPath);
      const size = content.length;
      const checksum = await this.computeChecksum(content);
      const sync = this.durableSync({
        type,
        modelId,
        dataName: data.name,
        version,
      });
      await this.syncWrittenContent(sync, contentPath, options);

      const dataToSave = data.withNewVersion({
        version,
        size,
        checksum,
      });

      const metadataPath = this.getMetadataPath(
        type,
        modelId,
        data.name,
        version,
      );
      const metadata = dataToSave.toData();
      const cleanData = JSON.parse(JSON.stringify(metadata));
      const metadataContent = stringifyYaml(
        cleanData as Record<string, unknown>,
      );
      await atomicWriteTextFile(
        metadataPath,
        metadataContent,
        sync === undefined ? undefined : { sync },
      );
      if (sync !== undefined) {
        await this.syncVersionReach(sync, type, modelId, data.name);
      }

      await this.advanceLatestMarker(
        type,
        modelId,
        data.name,
        version,
        () => this.catalogUpsert(type, modelId, dataToSave),
      );

      const why: DataWrite = { kind: "data.save" };
      await this.stageTypedChanges(type, modelId, async (changes) => [
        ...await this.writtenVersionChanges(
          changes,
          why,
          type,
          modelId,
          data.name,
          version,
        ),
        ...await this.latestAfterWrite(
          changes,
          why,
          type,
          modelId,
          data.name,
          version,
        ),
      ]);

      this.catalogUpsert(type, modelId, dataToSave);

      if (
        this.enableWriteGc && typeof data.garbageCollection === "number" &&
        priorVersions
      ) {
        await this.pruneExcessVersions(
          type,
          modelId,
          data.name,
          priorVersions,
          data.garbageCollection,
        );
      }

      return { size, checksum };
    });
  }

  async finalizeVersionDeferred(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
    _priorVersions?: number[],
    options?: { contentSynced?: boolean },
  ): Promise<
    { receipt: DeferredWriteReceipt; size: number; checksum: string }
  > {
    return await this.staged({
      kind: "write",
      path: this.getPath(type, modelId, data.name, version),
    }, async () => {
      const contentPath = this.getContentPath(
        type,
        modelId,
        data.name,
        version,
      );
      const content = await Deno.readFile(contentPath);
      const size = content.length;
      const checksum = await this.computeChecksum(content);
      const sync = this.durableSync({
        type,
        modelId,
        dataName: data.name,
        version,
      });
      await this.syncWrittenContent(sync, contentPath, options);

      const dataToSave = data.withNewVersion({ version, size, checksum });

      const metadataPath = this.getMetadataPath(
        type,
        modelId,
        data.name,
        version,
      );
      const metadata = dataToSave.toData();
      const cleanData = JSON.parse(JSON.stringify(metadata));
      const metadataContent = stringifyYaml(
        cleanData as Record<string, unknown>,
      );
      await atomicWriteTextFile(
        metadataPath,
        metadataContent,
        sync === undefined ? undefined : { sync },
      );
      if (sync !== undefined) {
        await this.syncVersionReach(sync, type, modelId, data.name);
      }

      this.upsertPendingRow(type, modelId, dataToSave);

      return {
        receipt: { type, modelId, dataName: data.name, version },
        size,
        checksum,
      };
    });
  }

  async advanceLatestMarkers(
    receipts: DeferredWriteReceipt[],
  ): Promise<void> {
    const stagingErrors: unknown[] = [];
    for (const receipt of receipts) {
      let promoted: { hasMetadata: boolean } | undefined;
      try {
        const data = await this.findByName(
          receipt.type,
          receipt.modelId,
          receipt.dataName,
          receipt.version,
        );
        // a writer that never finalized left raw nothing synced; on v2 sync it,
        // its version directory and the reach before the row settles or the
        // marker names it, since content reads skip metadata
        const sync = this.durableSync({
          type: receipt.type,
          modelId: receipt.modelId,
          dataName: receipt.dataName,
          version: receipt.version,
        });
        if (data === null && sync !== undefined) {
          await syncExistingFile(
            this.getContentPath(
              receipt.type,
              receipt.modelId,
              receipt.dataName,
              receipt.version,
            ),
            sync,
          );
          await this.syncDir(
            sync,
            this.getPath(
              receipt.type,
              receipt.modelId,
              receipt.dataName,
              receipt.version,
            ),
          );
          await this.syncVersionReach(
            sync,
            receipt.type,
            receipt.modelId,
            receipt.dataName,
          );
        }
        // settle the pending row before the marker moves, so a crash between
        // the two never leaves a marker-named version looking like an orphan GC
        // may reclaim
        this.catalogStore.settlePending(
          this.namespace,
          receipt.type.normalized,
          receipt.modelId,
          receipt.dataName,
          receipt.version,
          data !== null,
        );
        this.catalogStore.recordLocalWrite();
        // Promoted once the marker moved, whatever fails after it.
        const publish = () => {
          promoted = { hasMetadata: data !== null };
          if (data) {
            this.catalogUpsert(receipt.type, receipt.modelId, data);
          }
        };
        await this.advanceLatestMarker(
          receipt.type,
          receipt.modelId,
          receipt.dataName,
          receipt.version,
          publish,
        );
        publish();
        if (
          data && this.enableWriteGc &&
          typeof data.garbageCollection === "number"
        ) {
          await this.prunePromotedVersion(
            receipt,
            data.garbageCollection,
          );
        }
      } catch (error) {
        logger
          .warn`Failed to advance latest marker for ${receipt.dataName} v${receipt.version}: ${error}`;
      }
      // outside the catch above so a v3 staging error is never only logged;
      // collected so the receipts after it are still promoted
      if (promoted !== undefined) {
        try {
          await this.stagePromotedVersion(
            receipt.type,
            receipt.modelId,
            receipt.dataName,
            receipt.version,
            promoted.hasMetadata,
          );
        } catch (error) {
          stagingErrors.push(error);
        }
      }
    }
    throwStagingErrors(stagingErrors);
  }

  /**
   * the promoted version need not be the newest, so it is counted with the rest
   * and the newest cap are kept; pruneExcessVersions leaves room for one more,
   * hence cap + 1
   */
  private async prunePromotedVersion(
    receipt: DeferredWriteReceipt,
    cap: number,
  ): Promise<void> {
    try {
      const versions = await this.listVersions(
        receipt.type,
        receipt.modelId,
        receipt.dataName,
      );
      await this.pruneExcessVersions(
        receipt.type,
        receipt.modelId,
        receipt.dataName,
        versions,
        cap + 1,
      );
    } catch (error) {
      logger
        .warn`Failed to prune excess versions of ${receipt.dataName} after promoting v${receipt.version}: ${error}`;
    }
  }

  async rollbackVersions(
    receipts: DeferredWriteReceipt[],
  ): Promise<void> {
    const stagingErrors: unknown[] = [];
    for (const receipt of receipts) {
      let rolledBack = false;
      try {
        const versionDir = this.getPath(
          receipt.type,
          receipt.modelId,
          receipt.dataName,
          receipt.version,
        );
        await Deno.remove(versionDir, { recursive: true });
        this.catalogStore.removeVersion(
          this.namespace,
          receipt.type.normalized,
          receipt.modelId,
          receipt.dataName,
          receipt.version,
          computeLatestFlags,
        );
        this.catalogStore.recordLocalWrite();
        await this.removeNameLeftWithDanglingMarker(
          receipt.type,
          receipt.modelId,
          receipt.dataName,
        );
        rolledBack = true;
      } catch (error) {
        logger
          .warn`Failed to rollback version ${receipt.dataName} v${receipt.version}: ${error}`;
      }
      // an unpromoted version was never staged, so its tombstones are harmless
      // and keep v3 right should a rollback follow a promotion
      if (rolledBack) {
        try {
          await this.stageRemovedVersion(
            "data.delete",
            receipt.type,
            receipt.modelId,
            receipt.dataName,
            receipt.version,
          );
          await this.stageLatestAfterRemoval(
            "data.delete",
            receipt.type,
            receipt.modelId,
            receipt.dataName,
          );
        } catch (error) {
          stagingErrors.push(error);
        }
      }
    }
    throwStagingErrors(stagingErrors);
  }

  /**
   * on v3 an error of the rollback is logged so it never replaces the write
   * error that caused it; on v2 it reaches the caller
   */
  private async rollbackKeepingError(
    receipts: DeferredWriteReceipt[],
  ): Promise<void> {
    if (!typedStagingActive(this.markDirty)) {
      await this.rollbackVersions(receipts);
      return;
    }
    try {
      await this.rollbackVersions(receipts);
    } catch (error) {
      logger.error`Staging the rollback of a failed write failed: ${error}`;
    }
  }

  nextId(): DataId {
    return generateDataId();
  }

  getPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    return join(
      this.getDataNameDir(type, modelId, dataName),
      version.toString(),
    );
  }

  getContentPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    return join(this.getPath(type, modelId, dataName, version), "raw");
  }

  getLatestVersionSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number | null {
    const latestPath = join(
      this.getDataNameDir(type, modelId, dataName),
      "latest",
    );
    try {
      const content = Deno.readTextFileSync(latestPath);
      const version = parseInt(content.trim(), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a text file or not found
    }
    try {
      const linkTarget = Deno.readLinkSync(latestPath);
      const version = parseInt(linkTarget.replace(/\/$/, ""), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a symlink either
    }
    const versions = this.listVersionsSync(type, modelId, dataName);
    return maxOf(versions) ?? null;
  }

  findByNameSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Data | null {
    return this.findByNameSyncWithDepth(type, modelId, dataName, version, 0);
  }

  private findByNameSyncWithDepth(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number | undefined,
    depth: number,
  ): Data | null {
    const versionToRead = version ??
      this.getLatestVersionSync(type, modelId, dataName);
    if (versionToRead === null) return null;

    const metadataPath = this.getMetadataPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );
    try {
      const content = Deno.readTextFileSync(metadataPath);
      const metadata = parseYaml(content) as DataMetadata | null;
      if (!metadata) return null;
      const data = Data.fromData(metadata);

      if (version === undefined && data.isRenamed && data.renamedTo) {
        if (depth >= 5) {
          logger
            .warn`Rename chain depth exceeded for ${dataName} (behavior ${modelId}). Data exists but is unreachable — simplify the rename chain.`;
          return null;
        }
        return this.findByNameSyncWithDepth(
          type,
          modelId,
          data.renamedTo,
          undefined,
          depth + 1,
        );
      }

      return data;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  listVersionsSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number[] {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    const versions: number[] = [];

    try {
      for (const entry of Deno.readDirSync(dataNameDir)) {
        if (!entry.isDirectory) continue;
        if (entry.name === "latest") continue;

        const version = parseInt(entry.name, 10);
        if (!isNaN(version) && version > 0) {
          versions.push(version);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return versions.sort((a, b) => a - b);
  }

  getContentSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Uint8Array | null {
    const versionToRead = version ??
      this.getLatestVersionSync(type, modelId, dataName);
    if (versionToRead === null) return null;

    const contentPath = this.getContentPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );
    try {
      const bytes = Deno.readFileSync(contentPath);
      if (bytes.length === 0) {
        this.warnEmptyContent(type, modelId, dataName, versionToRead);
      }
      return bytes;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        this.warnMissingContent(type, modelId, dataName, versionToRead);
        return null;
      }
      throw error;
    }
  }

  findAllForModelSync(type: ModelType, modelId: string): Data[] {
    return this.collectModelDataSync(type, modelId);
  }

  private collectModelDataSync(
    type: ModelType,
    modelId: string,
    renames?: RenameForward[],
  ): Data[] {
    const dataDir = this.getModelDataDir(type, modelId);
    const results: Data[] = [];
    const seen = new Set<string>();

    try {
      for (const dataName of listSubdirectoriesSync(dataDir)) {
        const latest = this.getLatestVersionSync(type, modelId, dataName);
        let data = latest === null
          ? null
          : this.findByNameSync(type, modelId, dataName, latest);
        if (data?.isRenamed && data.renamedTo) {
          renames?.push({
            modelType: type,
            modelId,
            dataName,
            renamedTo: data.renamedTo,
          });
          data = this.findByNameSyncWithDepth(
            type,
            modelId,
            data.renamedTo,
            undefined,
            1,
          );
        }
        if (data && !seen.has(data.name)) {
          seen.add(data.name);
          results.push(data);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return results;
  }

  findAllGlobalSync(options?: FindAllGlobalOptions): Array<
    { data: Data; modelType: ModelType; modelId: string }
  > {
    const results: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    const baseDir = this.getBaseDir();
    this.collectAllDataSync(baseDir, [], results, options?.renames);
    return results;
  }

  async findByTaggedName(
    modelName: string,
    dataName: string,
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>> {
    const results: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    const baseDir = this.getBaseDir();
    await this.collectByTaggedName(baseDir, [], dataName, modelName, results);
    return results;
  }

  private async collectByTaggedName(
    currentDir: string,
    pathSegments: string[],
    targetDataName: string,
    targetModelName: string,
    results: Array<{ data: Data; modelType: ModelType; modelId: string }>,
  ): Promise<void> {
    try {
      const entries = await listSubdirectories(currentDir);

      for (const name of entries) {
        const childPath = join(currentDir, name);

        if (looksLikeModelId(name)) {
          if (pathSegments.length < 1) continue;
          const dataNameDir = join(childPath, targetDataName);
          try {
            const stat = await Deno.stat(dataNameDir);
            if (!stat.isDirectory) continue;
          } catch {
            continue;
          }

          const typeStr = pathSegments.join("/");
          try {
            const modelType = ModelType.create(typeStr);
            const data = await this.findByName(
              modelType,
              name,
              targetDataName,
            );
            if (
              data && !data.isRenamed &&
              data.tags["modelName"] === targetModelName
            ) {
              results.push({ data, modelType, modelId: name });
            }
          } catch {
            // Skip invalid model types or read errors
          }
        } else {
          await this.collectByTaggedName(
            childPath,
            [...pathSegments, name],
            targetDataName,
            targetModelName,
            results,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  private collectAllDataSync(
    currentDir: string,
    pathSegments: string[],
    results: Array<{ data: Data; modelType: ModelType; modelId: string }>,
    renames?: RenameForward[],
  ): void {
    try {
      const entries = listSubdirectoriesSync(currentDir);

      for (const name of entries) {
        const childPath = join(currentDir, name);
        const childSegments = [...pathSegments, name];

        const isModelIdDir = this.isModelIdDirectorySync(childPath);

        if (isModelIdDir && childSegments.length >= 2) {
          const typeSegments = pathSegments;
          const modelId = name;
          const typeStr = typeSegments.join("/");

          try {
            const modelType = ModelType.create(typeStr);
            const dataItems = this.collectModelDataSync(
              modelType,
              modelId,
              renames,
            );
            for (const data of dataItems) {
              results.push({ data, modelType, modelId });
            }
          } catch {
            // a silent drop here becomes a catalog delete
            logger
              .debug`Skipping ${childPath} during walk: ${typeStr} is not a valid model type. If data is missing from data query, run swamp doctor datastores --repair.`;
          }
        } else {
          this.collectAllDataSync(childPath, childSegments, results, renames);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  private isModelIdDirectorySync(dir: string): boolean {
    try {
      for (const entry of Deno.readDirSync(dir)) {
        if (!entry.isDirectory && !entry.isSymlink) continue;
        const childPath = join(dir, entry.name);
        try {
          for (const subEntry of Deno.readDirSync(childPath)) {
            if (!subEntry.isDirectory || !/^\d+$/.test(subEntry.name)) continue;
            if (hasVersionMetadataSync(join(childPath, subEntry.name))) {
              return true;
            }
          }
        } catch {
          // Skip unreadable directories
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return false;
  }

  async collectGarbage(
    type: ModelType,
    modelId: string,
    options?: { dryRun?: boolean },
  ): Promise<GarbageCollectionResult> {
    const dryRun = options?.dryRun ?? false;
    let versionsRemoved = 0;
    let bytesReclaimed = 0;

    if (!dryRun) {
      const reclaimed = await this.reclaimOrphanedDeferredWrites(
        type,
        modelId,
      );
      versionsRemoved += reclaimed.versionsRemoved;
      bytesReclaimed += reclaimed.bytesReclaimed;
    }

    const allData = await this.findAllForModel(type, modelId);

    for (const data of allData) {
      // Only promoted versions are counted, kept or pruned.
      const { promoted: versions } = await this.listPromotedVersions(
        type,
        modelId,
        data.name,
      );
      if (versions.length <= 1) continue;

      const gc = data.garbageCollection;
      let versionsToRemove: number[] = [];

      if (typeof gc === "number") {
        if (versions.length > gc) {
          versionsToRemove = await versionsBeyondKeep(
            versions,
            gc,
            this.restatesIn(type, modelId, data.name),
          );
        }
      } else {
        const duration = parseDataDuration(gc);
        const cutoff = Date.now() - duration;
        const latestVersion = maxOf(versions);

        for (const version of versions) {
          const versionData = await this.findByName(
            type,
            modelId,
            data.name,
            version,
          );
          if (versionData && versionData.createdAt.getTime() < cutoff) {
            if (version !== latestVersion) {
              versionsToRemove.push(version);
            }
          }
        }
      }

      const removalTasks = versionsToRemove.map((version) => ({
        version,
        contentPath: this.getContentPath(type, modelId, data.name, version),
        versionDir: this.getPath(type, modelId, data.name, version),
      }));
      const removed: number[] = [];

      const GC_BATCH_CONCURRENCY = 20;
      for (let i = 0; i < removalTasks.length; i += GC_BATCH_CONCURRENCY) {
        const batch = removalTasks.slice(i, i + GC_BATCH_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async ({ contentPath, versionDir }) => {
            let bytes = 0;
            try {
              const stat = await Deno.stat(contentPath);
              bytes = stat.size;
            } catch {
              // Ignore stat errors
            }
            if (!dryRun) {
              await this.staged(
                { kind: "remove", path: versionDir },
                async () => {
                  try {
                    await Deno.remove(versionDir, { recursive: true });
                  } catch (error) {
                    if (!(error instanceof Deno.errors.NotFound)) throw error;
                  }
                },
              );
            }
            return bytes;
          }),
        );
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") {
            bytesReclaimed += result.value;
            versionsRemoved++;
            if (!dryRun) removed.push(batch[index].version);
          } else {
            logger
              .error`GC failed to remove version directory: ${result.reason}`;
          }
        }
      }
      // staged after the parallel removals, outside allSettled, so a v3 staging
      // error surfaces; one batch per version
      for (const version of removed) {
        await this.stageRemovedVersion(
          "data.gc",
          type,
          modelId,
          data.name,
          version,
        );
      }

      // re-scan actual versions after the parallel deletions to avoid a stale
      // marker
      if (!dryRun && versionsToRemove.length > 0) {
        this.catalogStore.bulkRemoveVersions(
          this.namespace,
          type.normalized,
          modelId,
          data.name,
          versionsToRemove,
          computeLatestFlags,
        );
        this.catalogStore.recordLocalWrite();

        const { onDisk, promoted } = await this.listPromotedVersions(
          type,
          modelId,
          data.name,
        );
        const latestVersion = maxOf(promoted);
        if (latestVersion !== undefined) {
          await this.updateLatestMarker(
            type,
            modelId,
            data.name,
            latestVersion,
          );
          const latestData = await this.findByName(
            type,
            modelId,
            data.name,
            latestVersion,
          );
          if (latestData) {
            this.catalogUpsert(type, modelId, latestData);
          }
        } else if (onDisk.length > 0) {
          await this.updateLatestMarker(
            type,
            modelId,
            data.name,
            NO_PROMOTED_VERSION,
          );
        } else {
          const dataNameDir = this.getDataNameDir(type, modelId, data.name);
          await this.staged(
            { kind: "remove", path: dataNameDir },
            () => Deno.remove(dataNameDir, { recursive: true }).catch(() => {}),
          );
          this.catalogRemove(type, modelId, data.name);
        }
        await this.stageLatestAfterRemoval("data.gc", type, modelId, data.name);
      }
    }

    return { versionsRemoved, bytesReclaimed };
  }

  private getBaseDir(): string {
    return this.baseDir;
  }

  private getTypeDir(type: ModelType): string {
    return join(this.getBaseDir(), type.toDirectoryPath());
  }

  private getModelDataDir(type: ModelType, modelId: string): string {
    const typeDir = this.getTypeDir(type);
    const result = join(typeDir, modelId);
    this.assertPathContained(result, typeDir, `modelId "${modelId}"`);
    return result;
  }

  /**
   * append the model identity lexically to the resolved datastore root:
   * resolving the model boundary would trust a symlink that redirects the model
   * directory into another model
   */
  private async assertModelReadPath(
    path: string,
    type: ModelType,
    modelId: string,
  ): Promise<void> {
    const boundary = join(
      await resolveRealPath(this.baseDir),
      relative(this.baseDir, this.getModelDataDir(type, modelId)),
    );
    assertContainedPath(
      relative(boundary, await resolveRealPath(path)),
      boundary,
    );
  }

  getDataNameDir(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): string {
    const modelDir = this.getModelDataDir(type, modelId);
    const result = join(modelDir, dataName);
    this.assertPathContained(result, modelDir, `dataName "${dataName}"`);
    return result;
  }

  /**
   * highest version a name had when its newest were deleted, so a write never
   * reuses a number another clone may hold; named with .. so it is never a data
   * name, and holds only the number
   */
  private getVersionFloorPath(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): string {
    return `${
      this.getDataNameDir(type, modelId, dataName)
    }${VERSION_FLOOR_SUFFIX}`;
  }

  private async readVersionFloor(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number> {
    try {
      const value = Number.parseInt(
        (await Deno.readTextFile(
          this.getVersionFloorPath(type, modelId, dataName),
        )).trim(),
        10,
      );
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  /**
   * v2 only: a v3 partition keeps its own high-water mark, and a plain file is
   * not one of the changes a v3 unit commits
   */
  async raiseVersionFloor(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<void> {
    if (typedStagingActive(this.markDirty)) return;
    if (await this.readVersionFloor(type, modelId, dataName) >= version) return;
    const path = this.getVersionFloorPath(type, modelId, dataName);
    await this.staged({ kind: "write", path }, async () => {
      await Deno.mkdir(this.getModelDataDir(type, modelId), {
        recursive: true,
      });
      await atomicWriteTextFile(path, `${version}\n`);
    });
  }

  /**
   * the parent of each directory created here is synced before returning, so
   * its entry is durable before any version under it is published
   */
  private async makeDataNameDir(
    dataNameDir: string,
    record: DurableRecord,
  ): Promise<void> {
    const sync = this.durableSync(record);
    await makeDirectories(
      dataNameDir,
      sync === undefined ? undefined : (dir) => this.syncDir(sync, dir),
    );
  }

  /**
   * ownership is checked against a rename marker's target, as reads resolve
   * it; the kind against the stored latest, which a marker resets
   */
  private async assertWritable(
    type: ModelType,
    modelId: string,
    data: Data,
  ): Promise<void> {
    const version = await this.getLatestVersion(type, modelId, data.name);
    if (version === null) return;
    const latest = await this.findByName(type, modelId, data.name, version);
    const owner = latest?.isRenamed
      ? await this.findByName(type, modelId, data.name)
      : latest;
    if (owner && !owner.isOwnedBy(data.ownerDefinition)) {
      throw new OwnershipValidationError(
        data.name,
        owner.ownerDefinition,
        data.ownerDefinition,
      );
    }
    assertKindContinues(latest, data, modelId);
  }

  private async atomicAllocateVersionDir(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<{ version: number; versionDir: string; priorVersions: number[] }> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    await assertSafePath(dataNameDir, this.baseDir);

    const versions = await this.listVersions(type, modelId, dataName);
    // never below the version floor, so a number deleted versions used is not
    // given to new content; v3 still reads version directories because the
    // mkdir below keeps this process's units apart
    const floor = await this.readVersionFloor(type, modelId, dataName);
    const v3Floors = versionFloorSource(this.markDirty);
    const changes = v3Floors === undefined
      ? undefined
      : new ModelChanges(type, modelId);
    const partition = changes === undefined ? "" : changes.partition.toString();
    const v3Floor = v3Floors === undefined
      ? 0
      : await v3Floors.floor(partition, dataName);
    let nextVersion = Math.max(maxOf(versions) ?? 0, floor, v3Floor) + 1;
    // made once the first version to try is known, so on v3 the sync decision
    // covers that version's own keys
    await this.makeDataNameDir(dataNameDir, {
      type,
      modelId,
      dataName,
      version: nextVersion,
    });

    const maxRetries = 100;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const versionDir = this.getPath(type, modelId, dataName, nextVersion);
      try {
        await Deno.mkdir(versionDir);
        v3Floors?.claim(partition, dataName, nextVersion);
        if (changes !== undefined) {
          v3Floors?.allocated(
            posixDirname(
              changes.dataKey(dataName, nextVersion, "raw").toString(),
            ),
          );
        }
        return { version: nextVersion, versionDir, priorVersions: versions };
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) {
          nextVersion++;
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Failed to allocate version for "${dataName}" after ${maxRetries} retries`,
    );
  }

  private async pruneExcessVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
    priorVersions: number[],
    cap: number,
  ): Promise<void> {
    const pending = this.catalogStore.pendingVersions(
      this.namespace,
      type.normalized,
      modelId,
      dataName,
    );
    const promoted = priorVersions.filter((v) => !pending.has(v));
    if (promoted.length < cap) return;
    // Room for the version being written: cap - 1 prior observations stay,
    // restatements among them not counted.
    const toRemove = await versionsBeyondKeep(
      promoted,
      cap - 1,
      this.restatesIn(type, modelId, dataName),
    );
    for (const version of toRemove) {
      const versionDir = this.getPath(type, modelId, dataName, version);
      await this.staged({ kind: "remove", path: versionDir }, async () => {
        try {
          await Deno.remove(versionDir, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      });
      await this.stageRemovedVersion(
        "data.gc",
        type,
        modelId,
        dataName,
        version,
      );
    }
    if (toRemove.length > 0) {
      this.catalogStore.bulkRemoveVersions(
        this.namespace,
        type.normalized,
        modelId,
        dataName,
        toRemove,
        computeLatestFlags,
      );
      this.catalogStore.recordLocalWrite();
      logger
        .debug`Pruned ${toRemove.length} excess version(s) of ${dataName} (cap: ${cap}, prior: ${priorVersions.length})`;
    }
  }

  /**
   * a version that cannot be read counts as an observation, silently: a write
   * or a collection never fails or warns over it
   */
  private restatesIn(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): (version: number) => Promise<boolean> {
    return async (version) => {
      try {
        const path = this.getMetadataPath(type, modelId, dataName, version);
        await this.assertModelReadPath(path, type, modelId);
        const metadata = parseYaml(await Deno.readTextFile(path)) as
          | { readonly tags?: unknown }
          | null;
        const tags = metadata?.tags;
        return typeof tags === "object" && tags !== null &&
          !Array.isArray(tags) &&
          isRestatement(tags as Readonly<Record<string, string>>);
      } catch {
        return false;
      }
    };
  }

  private assertPathContained(
    path: string,
    expectedParent: string,
    context: string,
  ): void {
    const resolvedPath = resolve(path);
    const resolvedParent = resolve(expectedParent);
    if (
      resolvedPath !== resolvedParent &&
      !resolvedPath.startsWith(resolvedParent + SEPARATOR)
    ) {
      throw new Error(
        `Path traversal detected: ${context} resolves outside expected directory`,
      );
    }
  }

  getMetadataPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    return join(
      this.getPath(type, modelId, dataName, version),
      "metadata.yaml",
    );
  }

  private async getLatestVersion(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number | null> {
    const latestPath = join(
      this.getDataNameDir(type, modelId, dataName),
      "latest",
    );
    try {
      const content = await Deno.readTextFile(latestPath);
      const version = parseInt(content.trim(), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a text file or not found
    }
    try {
      const linkTarget = await Deno.readLink(latestPath);
      const version = parseInt(linkTarget.replace(/\/$/, ""), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a symlink either
    }
    const versions = await this.listVersions(type, modelId, dataName);
    return maxOf(versions) ?? null;
  }

  /**
   * moves the marker only forward; the read-compare-write is synchronous
   * against same-process writers and the model lock covers others. On a failed
   * v2 sync, published runs before the rethrow.
   */
  private async advanceLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    published?: () => void,
  ): Promise<void> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    await assertSafePath(dataNameDir, this.baseDir);
    const latestPath = join(dataNameDir, "latest");
    // on v2 the new marker is written and synced before the synchronous section
    // below, so no fsync runs inside it
    const sync = this.durableSync({ type, modelId, dataName, version });
    const syncedTmp = sync === undefined
      ? undefined
      : await writeSyncedTempFile(
        latestPath,
        new TextEncoder().encode(version.toString()),
        sync,
      );

    let current: number | null = null;
    try {
      current = parseInt(Deno.readTextFileSync(latestPath).trim(), 10);
    } catch {
      // Missing, or a legacy symlink: replaced below.
    }
    if (
      current !== null && !isNaN(current) && current > version &&
      existsSync(this.getPath(type, modelId, dataName, current))
    ) {
      if (syncedTmp !== undefined) await Deno.remove(syncedTmp).catch(() => {});
      return;
    }

    try {
      if (Deno.lstatSync(latestPath).isSymlink) Deno.removeSync(latestPath);
    } catch {
      // Ignore if not found
    }
    const tmpPath = syncedTmp ??
      join(dataNameDir, `.${crypto.randomUUID()}.tmp`);
    try {
      if (syncedTmp === undefined) {
        Deno.writeTextFileSync(tmpPath, version.toString());
      }
      Deno.renameSync(tmpPath, latestPath);
    } catch (error) {
      try {
        Deno.removeSync(tmpPath);
      } catch {
        // Temp file may not exist if the write failed before creating it
      }
      throw error;
    }
    if (sync === undefined) return;
    try {
      await this.syncDir(sync, dataNameDir);
    } catch (error) {
      published?.();
      throw error;
    }
  }

  /**
   * re-stages the version directory and marker after the write when a pull
   * replaced the marker with an older one; does nothing if the metadata is
   * gone, and never lowers the marker
   */
  async reassertLatestVersion(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<{ versionDir: string; latestPath: string } | undefined> {
    try {
      const stat = await Deno.stat(
        this.getMetadataPath(type, modelId, dataName, version),
      );
      if (!stat.isFile) return undefined;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    if (await this.readLatestMarker(type, modelId, dataName) !== version) {
      await this.advanceLatestMarker(type, modelId, dataName, version);
    }
    const versionDir = this.getPath(type, modelId, dataName, version);
    const latestPath = join(
      this.getDataNameDir(type, modelId, dataName),
      "latest",
    );
    // The directory before the marker: a push cut short must not publish a
    // marker naming a version it left behind.
    await this.stage({ kind: "write", path: versionDir });
    await this.stage({ kind: "write", path: latestPath });
    return { versionDir, latestPath };
  }

  /**
   * unlike getLatestVersion, never falls back to scanning the version
   * directories
   */
  private async readLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number | null> {
    const latestPath = join(
      this.getDataNameDir(type, modelId, dataName),
      "latest",
    );
    try {
      const version = parseInt(
        (await Deno.readTextFile(latestPath)).trim(),
        10,
      );
      if (!isNaN(version)) return version;
    } catch {
      // Not a text file or not found
    }
    try {
      const version = parseInt(
        (await Deno.readLink(latestPath)).replace(/\/$/, ""),
        10,
      );
      if (!isNaN(version)) return version;
    } catch {
      // Not a symlink either
    }
    return null;
  }

  /**
   * read as readLatestMarker reads it, never falling back to the highest
   * version directory, which could be a write in flight
   */
  async latestMarkerState(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<LatestMarkerState> {
    try {
      await Deno.lstat(
        join(this.getDataNameDir(type, modelId, dataName), "latest"),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { kind: "absent" };
      throw error;
    }
    const version = await this.readLatestMarker(type, modelId, dataName);
    return version === null
      ? { kind: "unreadable" }
      : { kind: "version", version };
  }

  /**
   * only meaningful for a published version: a write in flight looks the same
   * as an unreadable one
   */
  async inspectVersion(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<VersionInspection> {
    try {
      await Deno.stat(this.getPath(type, modelId, dataName, version));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { reason: "version_missing" };
      }
      throw error;
    }
    let text: string;
    try {
      text = await Deno.readTextFile(
        this.getMetadataPath(type, modelId, dataName, version),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { reason: "metadata_missing" };
      }
      throw error;
    }
    if (text.trim() === "") return { reason: "metadata_empty" };
    let data: Data;
    try {
      const metadata = parseYaml(text) as DataMetadata | null;
      if (!metadata) return { reason: "metadata_empty" };
      data = Data.fromData(metadata);
    } catch {
      return { reason: "metadata_unparseable" };
    }
    const modelName = data.tags["modelName"];
    const found = modelName === undefined ? {} : { modelName };
    const size = await this.contentFileSize(type, modelId, dataName, version);
    if (size === null) return { ...found, reason: "content_missing" };
    if (data.size !== undefined && size < data.size) {
      return { ...found, reason: "content_short" };
    }
    return found;
  }

  private async contentFileSize(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<number | null> {
    return await fileSize(
      this.getContentPath(type, modelId, dataName, version),
    );
  }

  /**
   * a save that crashed before it was published is the newest version
   * allocated, so it is always above this ceiling
   */
  private async publishedCeiling(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number | undefined> {
    const published = this.catalogStore.versionKeys(this.namespace, {
      typeNormalized: type.normalized,
      modelId,
      dataName,
    }).map((row) => row.version);
    const marker = await this.latestMarkerState(type, modelId, dataName);
    if (marker.kind === "version" && marker.version > 0) {
      published.push(marker.version);
    }
    return maxOf(published);
  }

  /**
   * a pending deferred write is not promoted and a crashed unpublished save is
   * above the ceiling, so neither is ever chosen; a rollback passes the ceiling
   * it measured before removing anything
   */
  async highestReadableVersion(
    type: ModelType,
    modelId: string,
    dataName: string,
    ceiling?: number,
  ): Promise<number | null> {
    const limit = ceiling ??
      await this.publishedCeiling(type, modelId, dataName);
    if (limit === undefined) return null;
    const { promoted } = await this.listPromotedVersions(
      type,
      modelId,
      dataName,
    );
    const candidates = promoted.filter((v) => v <= limit);
    for (const version of candidates.sort((a, b) => b - a)) {
      const { reason } = await this.inspectVersion(
        type,
        modelId,
        dataName,
        version,
      );
      if (reason === undefined) return version;
    }
    return null;
  }

  /**
   * run under the model's lock; leaves the marker as it is when no version can
   * be read
   */
  async resetLatestMarkerToReadable(
    type: ModelType,
    modelId: string,
    dataName: string,
    ceiling?: number,
  ): Promise<number | null> {
    const version = await this.highestReadableVersion(
      type,
      modelId,
      dataName,
      ceiling,
    );
    if (version === null) return null;
    await this.staged(
      {
        kind: "write",
        path: join(this.getDataNameDir(type, modelId, dataName), "latest"),
      },
      () => this.updateLatestMarker(type, modelId, dataName, version),
    );
    const hasRow = this.catalogStore.versionKeys(this.namespace, {
      typeNormalized: type.normalized,
      modelId,
      dataName,
    }).some((row) => row.version === version);
    if (!hasRow) {
      // A rename marker is never a row; its forward stays as it is.
      const data = await this.findByName(type, modelId, dataName, version);
      if (data && !data.isRenamed) this.catalogUpsert(type, modelId, data);
    }
    return version;
  }

  /**
   * delete makes the highest version on disk latest, possibly a crashed
   * unpublished save, so its added rows are dropped and the new latest is
   * chosen at or below the pre-rollback published ceiling
   */
  async rollBackToReadable(
    type: ModelType,
    modelId: string,
    dataName: string,
    unreadable: readonly number[],
  ): Promise<{ latest: number | null; removed: boolean }> {
    const group = { typeNormalized: type.normalized, modelId, dataName };
    const hadRow = new Set(
      this.catalogStore.versionKeys(this.namespace, group).map((row) =>
        row.version
      ),
    );
    // Measured before anything is removed: the deletes move the marker.
    const ceiling = await this.publishedCeiling(type, modelId, dataName);
    for (const version of [...unreadable].sort((a, b) => b - a)) {
      await this.delete(type, modelId, dataName, version);
    }
    const added = this.catalogStore.versionKeys(this.namespace, group)
      .map((row) => row.version)
      .filter((version) => !hadRow.has(version));
    if (added.length > 0) {
      this.catalogStore.bulkRemoveVersions(
        this.namespace,
        type.normalized,
        modelId,
        dataName,
        added,
        computeLatestFlags,
      );
      this.catalogStore.recordLocalWrite();
    }
    const latest = ceiling === undefined
      ? null
      : await this.resetLatestMarkerToReadable(
        type,
        modelId,
        dataName,
        ceiling,
      );
    const left = await this.listVersions(type, modelId, dataName);
    if (latest === null && unreadable.length > 0 && left.length > 0) {
      await this.staged(
        {
          kind: "write",
          path: join(this.getDataNameDir(type, modelId, dataName), "latest"),
        },
        () =>
          this.updateLatestMarker(
            type,
            modelId,
            dataName,
            NO_PROMOTED_VERSION,
          ),
      );
    }
    return { latest, removed: left.length === 0 };
  }

  /**
   * only a v2 datastore with all files local: a hydrate hook downloads missing
   * or short files, and a v3 checkout replays records from the commit log
   */
  private checksUnreadableVersions(): boolean {
    return this.hydrateFile === undefined &&
      this.unreadableContent === undefined &&
      !typedStagingActive(this.markDirty);
  }

  /**
   * published means a non-pending catalog row or a latest marker naming it; a
   * save in flight and a pending deferred write are not
   */
  private isPublishedVersionSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): boolean {
    const rows = this.catalogStore.versionKeys(this.namespace, {
      typeNormalized: type.normalized,
      modelId,
      dataName,
    });
    if (rows.some((row) => row.version === version)) return true;
    try {
      const marker = Deno.readTextFileSync(
        join(this.getDataNameDir(type, modelId, dataName), "latest"),
      );
      return parseInt(marker.trim(), 10) === version;
    } catch {
      return false;
    }
  }

  /**
   * an unpublished version is passed over silently and a failed check only logs
   * at debug, so a read never fails over it
   */
  private warnUnreadableVersion(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    reason: UnreadableVersionReason,
  ): void {
    if (!this.checksUnreadableVersions()) return;
    const key = this.getPath(type, modelId, dataName, version);
    if (warnedUnreadableVersions.has(key)) return;
    try {
      if (!this.isPublishedVersionSync(type, modelId, dataName, version)) {
        return;
      }
    } catch (error) {
      logger
        .debug`Could not check whether version ${version} of ${dataName} is published: ${error}`;
      return;
    }
    warnedUnreadableVersions.add(key);
    logger
      .warn`Version ${version} of ${dataName} (behavior ${modelId}) cannot be read: ${
      describeUnreadableVersionReason(reason)
    }, so it reads as empty or not found. Run swamp doctor datastores --repair to preview rolling it back to its last readable version.`;
  }

  /**
   * a version whose metadata is missing too is not warned about: a first write
   * in flight looks the same
   */
  private warnMissingContent(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): void {
    if (!this.checksUnreadableVersions()) return;
    if (
      !hasVersionMetadataSync(this.getPath(type, modelId, dataName, version))
    ) {
      return;
    }
    this.warnUnreadableVersion(
      type,
      modelId,
      dataName,
      version,
      "content_missing",
    );
  }

  /** only an empty read looks the catalog row up, so other reads cost nothing */
  private warnEmptyContent(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): void {
    if (!this.checksUnreadableVersions()) return;
    let recorded: number | undefined;
    try {
      recorded = this.catalogStore.versionKeys(this.namespace, {
        typeNormalized: type.normalized,
        modelId,
        dataName,
      }).find((row) => row.version === version)?.size;
    } catch (error) {
      logger
        .debug`Could not look up the recorded size of version ${version} of ${dataName}: ${error}`;
      return;
    }
    if (recorded === undefined || recorded === 0) return;
    this.warnUnreadableVersion(
      type,
      modelId,
      dataName,
      version,
      "content_short",
    );
  }

  noteUnreadableVersionReported(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): void {
    warnedUnreadableVersions.add(
      this.getPath(type, modelId, dataName, version),
    );
  }

  private warnShortContent(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    size: number,
  ): void {
    if (!this.checksUnreadableVersions()) return;
    const localSize = fileSizeSync(
      this.getContentPath(type, modelId, dataName, version),
    );
    if (localSize === null || localSize >= size) return;
    this.warnUnreadableVersion(
      type,
      modelId,
      dataName,
      version,
      "content_short",
    );
  }

  /**
   * a name without a marker (a first deferred write rolled back) is left as it
   * is
   */
  private async removeNameLeftWithDanglingMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<void> {
    if ((await this.listVersions(type, modelId, dataName)).length > 0) return;
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    try {
      await Deno.lstat(join(dataNameDir, "latest"));
    } catch {
      return;
    }
    await this.staged(
      { kind: "remove", path: dataNameDir },
      () => Deno.remove(dataNameDir, { recursive: true }).catch(() => {}),
    );
    this.catalogRemove(type, modelId, dataName);
  }

  /**
   * both latest flags 0 and marked pending with this process's pid and host
   * identity, so delete and GC leave it alone in flight and GC can reclaim it
   * if this process dies
   */
  private upsertPendingRow(type: ModelType, modelId: string, data: Data): void {
    this.catalogStore.upsert({
      namespace: this.namespace,
      type_normalized: type.normalized,
      model_id: modelId,
      data_name: data.name,
      id: data.id,
      version: data.version,
      is_latest: 0,
      is_step_latest: 0,
      model_name: data.tags["modelName"] ?? "",
      spec_name: data.tags["specName"] ?? "",
      data_type: data.tags["type"] ?? "",
      content_type: data.contentType,
      lifetime: data.lifetime,
      garbage_collection: garbageCollectionToColumn(data.garbageCollection),
      lifecycle: data.lifecycle,
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
      is_pending: 1,
      pending_pid: Deno.pid,
      pending_host: processHostIdentity(),
    });
    this.catalogStore.recordLocalWrite();
  }

  findVersionsCreatedBefore(
    cutoff: Date,
    options: FindVersionsCreatedBeforeOptions,
  ): Promise<AgedDataVersionPage> {
    const after = options.cursor === undefined
      ? undefined
      : JSON.parse(options.cursor) as { createdAt: string; rowId: number };
    const rows = this.catalogStore.rowsCreatedBefore(
      this.namespace,
      cutoff.toISOString(),
      options.limit,
      after,
      options.excludeTypes,
    );
    const last = rows[rows.length - 1];
    return Promise.resolve({
      versions: rows.map((row) => ({
        type: ModelType.create(row.type_normalized),
        modelId: row.model_id,
        dataName: row.data_name,
        version: row.version,
        createdAt: new Date(row.created_at),
        size: row.size,
      })),
      cursor: last && rows.length >= options.limit
        ? JSON.stringify({ createdAt: last.created_at, rowId: last.row_id })
        : undefined,
    });
  }

  hasPendingVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<boolean> {
    return Promise.resolve(
      this.catalogStore.pendingVersions(
        this.namespace,
        type.normalized,
        modelId,
        dataName,
      ).size > 0,
    );
  }

  /**
   * an in-flight deferred write is on disk before promotion, so delete and GC
   * must not make it latest, count it or prune it; only a catalog rebuilt from
   * empty treats every version as promoted
   */
  private async listPromotedVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<{ onDisk: number[]; promoted: number[] }> {
    const onDisk = await this.listVersions(type, modelId, dataName);
    const pending = this.catalogStore.pendingVersions(
      this.namespace,
      type.normalized,
      modelId,
      dataName,
    );
    return { onDisk, promoted: onDisk.filter((v) => !pending.has(v)) };
  }

  /**
   * an orphan is a pending row written under this host identity whose pid is
   * dead; rows from another host or container, this process or a live pid stay
   * in flight
   */
  private async reclaimOrphanedDeferredWrites(
    type: ModelType,
    modelId: string,
  ): Promise<GarbageCollectionResult> {
    const host = processHostIdentity();
    const orphans = this.catalogStore
      .pendingRows(this.namespace, type.normalized, modelId)
      .filter((row) =>
        row.pending_host === host && row.pending_pid !== undefined &&
        row.pending_pid > 0 && row.pending_pid !== Deno.pid &&
        isProcessGone(row.pending_pid)
      );
    let versionsRemoved = 0;
    let bytesReclaimed = 0;
    const names = new Set<string>();
    for (const row of orphans) {
      // promotion settles the pending row before moving the marker, so a marker
      // naming this version means it was promoted: finish settling instead of
      // reclaiming
      if (
        await this.readLatestMarker(type, modelId, row.data_name) ===
          row.version
      ) {
        const data = await this.findByName(
          type,
          modelId,
          row.data_name,
          row.version,
        );
        this.catalogStore.settlePending(
          this.namespace,
          type.normalized,
          modelId,
          row.data_name,
          row.version,
          data !== null,
        );
        this.catalogStore.recordLocalWrite();
        if (data) this.catalogUpsert(type, modelId, data);
        // promoted by a process that died before it could commit: stage it now,
        // or v3 never gets it
        await this.stagePromotedVersion(
          type,
          modelId,
          row.data_name,
          row.version,
          data !== null,
        );
        continue;
      }
      const versionDir = this.getPath(
        type,
        modelId,
        row.data_name,
        row.version,
      );
      await this.staged({ kind: "remove", path: versionDir }, async () => {
        try {
          bytesReclaimed += (await Deno.stat(
            this.getContentPath(type, modelId, row.data_name, row.version),
          )).size;
        } catch {
          // Ignore stat errors
        }
        try {
          await Deno.remove(versionDir, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      });
      this.catalogStore.removeVersion(
        this.namespace,
        type.normalized,
        modelId,
        row.data_name,
        row.version,
        computeLatestFlags,
      );
      this.catalogStore.recordLocalWrite();
      await this.stageRemovedVersion(
        "data.gc",
        type,
        modelId,
        row.data_name,
        row.version,
      );
      versionsRemoved++;
      names.add(row.data_name);
      logger
        .debug`Reclaimed orphaned deferred write ${row.data_name} v${row.version} (pid ${row.pending_pid} is gone)`;
    }
    // Kept inline rather than shared with removeNameLeftWithDanglingMarker:
    // the write-seams ratchet pins each staged change by call site.
    for (const name of names) {
      if ((await this.listVersions(type, modelId, name)).length > 0) continue;
      const dataNameDir = this.getDataNameDir(type, modelId, name);
      await this.staged(
        { kind: "remove", path: dataNameDir },
        () => Deno.remove(dataNameDir, { recursive: true }).catch(() => {}),
      );
      this.catalogRemove(type, modelId, name);
      await this.stageLatestAfterRemoval("data.gc", type, modelId, name);
    }
    return { versionsRemoved, bytesReclaimed };
  }

  private async updateLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<void> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    await assertSafePath(dataNameDir, this.baseDir);
    const latestPath = join(dataNameDir, "latest");

    // a plain marker is replaced by the rename below, so a crash never leaves
    // the name without one
    try {
      if ((await Deno.lstat(latestPath)).isSymlink) {
        await Deno.remove(latestPath);
      }
    } catch {
      // Ignore if not found
    }

    const sync = this.durableSync({ type, modelId, dataName, version });
    await atomicWriteTextFile(
      latestPath,
      version.toString(),
      sync === undefined ? undefined : { sync },
    );
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
}

function throwStagingErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Staging typed changes failed");
  }
}

/**
 * waits for every write or sync to settle before rethrowing the first failure,
 * so a rollback never races a write still in flight
 */
async function settleAll(work: readonly Promise<void>[]): Promise<void> {
  for (const result of await Promise.allSettled(work)) {
    if (result.status === "rejected") throw result.reason;
  }
}

export function createModelMethodOwner(
  modelType: string,
  methodName: string,
  workflowId?: string,
  workflowRunId?: string,
): OwnerDefinition {
  return {
    ownerType: "model-method",
    ownerRef: `${modelType}:${methodName}`,
    workflowId,
    workflowRunId,
  };
}

export function createWorkflowStepOwner(
  workflowId: string,
  jobName: string,
  stepName: string,
  workflowRunId?: string,
): OwnerDefinition {
  return {
    ownerType: "workflow-step",
    ownerRef: `${workflowId}:${jobName}:${stepName}`,
    workflowId,
    workflowRunId,
  };
}

export function createManualOwner(
  description: string,
): OwnerDefinition {
  return {
    ownerType: "manual",
    ownerRef: description,
  };
}
