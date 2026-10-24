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
  type DataWrite,
  ModelChanges,
} from "../../domain/datastore_v3/repository_changes.ts";
import { atomicWriteFile, atomicWriteTextFile } from "./atomic_write.ts";
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
import { computeLatestFlags } from "../../domain/data/data_query_service.ts";

/**
 * The latest marker's value when a data name has versions on disk but none
 * promoted, only in-flight deferred writes. Versions start at 1, so no write
 * is ever allocated it and reads through the marker find nothing.
 */
const NO_PROMOTED_VERSION = 0;

// Re-export domain repository types so existing infra-path importers keep working.
// New domain code should import directly from src/domain/data/repositories.ts.
export {
  type GarbageCollectionResult,
  OwnershipValidationError,
  type UnifiedDataRepository,
};

const logger = getSwampLogger(["data", "repository"]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function looksLikeModelId(name: string): boolean {
  return UUID_RE.test(name);
}

/**
 * A purely numeric directory name is ambiguous: it is the version directory of
 * a data item, but it is equally a legitimate *data name* — models that key
 * resources by an external numeric id (a TMDB id, an issue number) produce
 * `{model-id}/{207333}/{2}/`. Depth alone cannot tell the two apart, so the
 * tree walk has to confirm that a numeric directory actually holds a version's
 * `metadata.yaml` before treating its grandparent as a model-id directory.
 *
 * Without this check the walk mistakes the *type* directory for a model-id
 * directory, derives an invalid ModelType from the truncated path, and silently
 * drops every data item under that model — which the catalog backfill then
 * treats as "this model has no data" and deletes from the catalog.
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
 * Names of the directory entries that are directories, sorted by UTF-16
 * code unit (the default string sort, which no locale can change).
 *
 * Every walk in {@link FileSystemUnifiedDataRepository} visits a level in
 * this order so the same repository walks identically on every filesystem.
 * readdir order is sorted on APFS and NTFS but hash order on ext4, and the
 * catalog backfill inserts rows in walk order, so without the sort a
 * limited `data query` page came back in a different order per machine
 * (swamp-club#3066).
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

/** {@link sortedSubdirectoryNames} of `dir`; NotFound propagates. */
async function listSubdirectories(dir: string): Promise<string[]> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dir)) entries.push(entry);
  return sortedSubdirectoryNames(entries);
}

/** Sync twin of {@link listSubdirectories}. */
function listSubdirectoriesSync(dir: string): string[] {
  return sortedSubdirectoryNames(Deno.readDirSync(dir));
}

/**
 * How long a content file found short against its metadata, even after
 * downloading it again, is used as it is before the next read downloads it
 * again. The remote's copy is short too while another host's push has
 * uploaded the metadata but not yet the content; once that lands, a read
 * after this window picks it up.
 */
export const ACCEPTED_SHORT_CONTENT_TTL_MS = 30_000;

/** The size of the file at `path`, or null when there is none. */
async function fileSize(path: string): Promise<number | null> {
  try {
    return (await Deno.stat(path)).size;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** Sync twin of {@link fileSize}. */
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
 * File system implementation of UnifiedDataRepository.
 *
 * Storage layout:
 * .swamp/data/{normalized-type}/{model-id}/{data-name}/
 *   1/
 *     raw              # Content (binary or text)
 *     metadata.yaml    # Metadata
 *   2/
 *     raw
 *     metadata.yaml
 *   latest             # Text file containing current version (e.g. "2")
 */

/**
 * Suffix of the file beside a data name's directory that holds its version
 * floor (swamp-club#3473). `..` never occurs in a data name.
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
     * The namespace this repository writes as (giga-swamp Phase 2). All catalog
     * rows written here are stamped with this namespace. Defaults to
     * SOLO_NAMESPACE ('') — the correct value for solo mode and for the ~15
     * direct construction sites that do not yet resolve a configured namespace.
     *
     * PHASE 3 DEPENDENCY: those direct construction sites (libswamp/models/*,
     * libswamp/data/*, libswamp/workflows/evaluate, domain/workflows/
     * execution_service, etc.) must thread the configured namespace through in
     * lockstep with the path resolver prefixing storage paths. Until then they
     * intentionally default to SOLO_NAMESPACE and write to an un-namespaced
     * filesystem layout. This is a tracked dependency, not an oversight.
     */
    public readonly namespace: Namespace = SOLO_NAMESPACE,
    private readonly enableWriteGc: boolean = false,
    /** Clock for {@link ACCEPTED_SHORT_CONTENT_TTL_MS}; tests inject one. */
    private readonly now: () => number = Date.now,
    public readonly fetchForeignContent?: ForeignContentFetcher,
    /**
     * Tells content the datastore could not materialise from content that
     * is absent (swamp-club#3617); consulted only when a content read finds
     * no file.
     */
    public readonly unreadableContent?: UnreadableContentLookup,
  ) {
    this.baseDir = baseDir ?? swampPath(repoDir, SWAMP_SUBDIRS.data);
  }

  /**
   * Content files still short against their metadata after a fresh
   * download, keyed by content path and recorded size, with the time until
   * which that copy is used without downloading it again.
   */
  private readonly acceptedShort = new Map<string, number>();

  /**
   * Stages a typed change for the configured sync service: the cache has
   * uncommitted work at `change.path`.
   *
   * Called directly only where a write has already landed (see
   * {@link reassertLatestVersion}); every other mutation goes through
   * {@link staged}, which signals before and after the write.
   */
  private async stage(change: StagedChange): Promise<void> {
    // Every write this repository makes stages its typed changes after it
    // (swamp-club#3250), so a v3 unit takes no path change from it.
    await signalChange(this.markDirty, change, { typed: true });
  }

  /**
   * Runs a mutation that writes into (or removes from) the cache directory
   * with its changes signalled before it and, on v2, again once it has
   * settled (swamp-club#2421): a push that ran while the write was in
   * flight cannot have cleared the mark for good. A `write` names a file or
   * directory that exists after the operation; a `remove` names one that is
   * gone after it. The path is absolute; the wiring layer converts it to a
   * cache-relative form before forwarding to the sync service. The changes
   * go into the ambient unit of work bound to this repository's hook, or
   * straight to the hook, which is a no-op when no sync service is wired.
   * See `design/enablers/datastores.md` for the contract.
   */
  private staged<T>(
    changes: StagedChange | readonly StagedChange[],
    write: () => Promise<T>,
  ): Promise<T> {
    // Every write this repository makes stages its typed changes after it
    // (swamp-club#3250), so a v3 unit takes no path change from it.
    return withChangeSignalled(this.markDirty, changes, { typed: true }, write);
  }

  /**
   * Stages one batch of typed changes after a write, on v3 only
   * (swamp-club#3250): on v2 `build` never runs, so nothing here reads a
   * file. A batch always lands in one commit.
   */
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

  /**
   * A version's files as they are on disk, as typed changes. Called only
   * after this repository wrote, finalized, appended to or promoted the
   * version, so its content is local and current: no ensuring step.
   */
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
   * A content file as a put's source: its bytes when they inline, otherwise
   * a stream that opens the file at commit, so large content is never held
   * in memory until then. The stream is checked against the file's size
   * now, and against the metadata's checksum when it has one for this size
   * (an append drops it), so a file changed before the commit is never
   * committed under metadata that does not describe it (swamp-club#3564).
   * With it, the file's access as the same stat shows it (swamp-club#3693).
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

  /** The latest marker's bytes, or undefined when there is none. */
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

  /** The marker's put after a write, when the marker now names `version`. */
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

  /**
   * The marker as a removal left it: a put of what it holds now (a lowered
   * latest, or NO_PROMOTED_VERSION), or a tombstone when it is gone.
   */
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

  /** Stages a removed version as its own batch. */
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

  /** Stages the latest marker as a removal left it, as its own batch. */
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

  /**
   * Stages a promoted deferred version: its files and, when the marker moved
   * to it, the marker. A version whose metadata is gone records no version,
   * as its catalog row is dropped.
   */
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
        // No metadata: checked against its size alone.
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

  /**
   * Records `data` as the latest version for (type, modelId, data.name) in
   * the catalog. {@link CatalogStore.upsertNewVersion} sets both latest
   * flags by version order and demotes lower rows inside a single SQLite
   * transaction.
   *
   * Every production write path that mutates a data item (save, append,
   * rename, restore, delete-specific-version) calls this exactly once with
   * the row that should become authoritative afterwards.
   */
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
    // A name that leaves the catalog no longer forwards anywhere: a deleted
    // or expired name reads as not found, as `data get` reads it.
    this.catalogStore.removeRename(
      this.namespace,
      type.normalized,
      modelId,
      dataName,
    );
    this.catalogStore.recordLocalWrite();
  }

  /**
   * Records that `dataName` forwards to `renamedTo`. The files are already
   * authoritative and the catalog is a projection the next backfill rebuilds,
   * so a failed write only logs.
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
   * Every model's data, walked in name order at each level: type path
   * segments, then model id, then data name (see
   * {@link sortedSubdirectoryNames}). The catalog backfill relies on this
   * order so a freshly backfilled catalog has the same rowid order on every
   * filesystem.
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

  /** One type's data, model ids in name order; see {@link findAllGlobal}. */
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
          // A caller collecting what it skips learns of each data name that
          // failed, empty metadata included, which otherwise reads as the
          // data not being there, and still gets the model's other data.
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
          // Skip invalid model directories, telling a caller that asks.
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
   * Finds all data items whose `createdAt` is at or after the cutoff using a
   * two-stage filter (mtime pre-filter, then parse-and-verify) on each
   * version's metadata.yaml. Old version files are skipped without parse.
   *
   * The `_catalog.db` SQLite catalog does not track `createdAt`, so the only
   * source of truth for time-bounded filtering is the metadata YAML — hence
   * the same walk shape as `findAllGlobal`, plus a stat per file before
   * parse.
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

  /**
   * Recursively collects all data from the directory tree.
   * Walks .swamp/data/{type-segments...}/{model-id}/{data-name}/ structure.
   *
   * When a directory contains a subdirectory with numeric version directories
   * (or a "latest" marker file), we've reached a data-name level. The path segments
   * before the model-id form the model type.
   */
  private async collectAllData(
    currentDir: string,
    pathSegments: string[],
    results: Array<{ data: Data; modelType: ModelType; modelId: string }>,
    cutoff?: Date,
    renames?: RenameForward[],
  ): Promise<void> {
    try {
      const entries = await listSubdirectories(currentDir);

      // Check if we're at a model-id level by seeing if any child directories
      // contain data-name directories (which contain version subdirectories)
      for (const name of entries) {
        const childPath = join(currentDir, name);
        const childSegments = [...pathSegments, name];

        // Try to determine if this is a model-id directory by checking if
        // its children look like data-name directories (containing version dirs)
        const isModelIdDir = await this.isModelIdDirectory(childPath);

        if (isModelIdDir && childSegments.length >= 2) {
          // pathSegments = type segments, name = model ID
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
            // Not a valid model type — every data item below this directory is
            // dropped from the walk. Logged because a silent drop here reads
            // downstream as "this model has no data", which the catalog
            // backfill then commits by deleting the model's rows.
            logger
              .debug`Skipping ${childPath} during walk: ${typeStr} is not a valid model type. If data is missing from data query, run swamp doctor datastores --repair.`;
          }
        } else {
          // Keep recursing deeper into type directories
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

  /**
   * Like `findAllForModel`, but only returns data items whose latest-version
   * `createdAt` is at or after the cutoff. Stats the metadata file first
   * (Stage A) so old data is skipped without parsing.
   */
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

        // Stage A: mtime pre-filter
        try {
          const stat = await Deno.stat(metadataPath);
          const mtimeMs = stat.mtime?.getTime();
          if (mtimeMs !== undefined && mtimeMs < cutoffMs) continue;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }

        // Stage B: parse and verify
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

  /**
   * Checks if a directory looks like a model-id directory by examining
   * if its children contain version subdirectories or a "latest" marker file.
   */
  private async isModelIdDirectory(dir: string): Promise<boolean> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isDirectory && !entry.isSymlink) continue;

        // Check if this child is a data-name directory by looking for
        // numeric version subdirectories (1/, 2/, 3/, ...).
        // We intentionally skip checking for "latest" here because a data
        // item could be literally named "latest", which would cause a
        // type directory to be misidentified as a model-ID directory.
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
   * With `strict`, a metadata file that parses to nothing (an empty or
   * truncated `metadata.yaml`) throws SyntaxError, and one missing from a
   * version that exists throws NotFound, instead of reading as no data.
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
        return null;
      }
      const data = Data.fromData(metadata);

      // Follow forward references for latest lookups (not explicit version requests)
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
    // We need to scan all data directories to find the one with this ID
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

  /** One model's data, in data-name order; see {@link findAllGlobal}. */
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

  /**
   * One model's data, a data name at a time; see {@link findAllForModel}.
   * Each name is read only when the consumer asks for the next item.
   */
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

  /**
   * The latest data of each name under a model, following rename forwards.
   * Each rename marker followed is pushed to `renames` when given.
   *
   * With `skipped`, a data name that cannot be read, or whose metadata is
   * empty or missing (see {@link findByNameWithDepth}), is passed to it and
   * the other names are still read; without it, any such name fails the
   * whole model, and missing or empty metadata reads as no data.
   */
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

  /**
   * Adds one data name's latest data to `results`, unless `seen` already
   * holds its name: its own latest version, then a rename marker followed
   * from depth 1 — the same reads as an unversioned findByName, with the
   * marker visible on the way.
   */
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

  /**
   * Saves a new version. `stageAs` is the write its typed changes stage as;
   * rename passes undefined and stages the version itself, with its own
   * intent, in the rename's batch.
   */
  private async saveVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
    stageAs: DataWrite | undefined,
  ): Promise<{ version: number; checksum?: string }> {
    // Reject reserved data names that collide with internal markers
    if (isReservedDataName(data.name)) {
      throw new Error(
        `Data name '${data.name}' is reserved for internal use. Use a different name.`,
      );
    }

    // Pre-write notify with the data-name directory: version not yet
    // allocated, so the truthful signal is "this subtree is changing."
    return await this.staged({
      kind: "write",
      path: this.getDataNameDir(type, modelId, data.name),
    }, async () => {
      // Check if data with this name already exists
      const existing = await this.findByName(type, modelId, data.name);
      if (existing) {
        // Validate ownership
        if (!existing.isOwnedBy(data.ownerDefinition)) {
          throw new OwnershipValidationError(
            data.name,
            existing.ownerDefinition,
            data.ownerDefinition,
          );
        }
      }

      // Atomically allocate a new version directory
      const { version: newVersion, priorVersions } = await this
        .atomicAllocateVersionDir(
          type,
          modelId,
          data.name,
        );

      // Create the data with updated version and size
      const checksum = await this.computeChecksum(content);
      const dataToSave = data.withNewVersion({
        version: newVersion,
        size: content.length,
        checksum,
      });

      // Save metadata
      const metadataPath = this.getMetadataPath(
        type,
        modelId,
        data.name,
        newVersion,
      );
      const boundary = this.baseDir;
      await assertSafePath(metadataPath, boundary);
      const metadata = dataToSave.toData();
      // Remove undefined values
      const cleanData = JSON.parse(JSON.stringify(metadata));
      const metadataContent = stringifyYaml(
        cleanData as Record<string, unknown>,
      );
      await atomicWriteTextFile(metadataPath, metadataContent);

      // Save content
      const contentPath = this.getContentPath(
        type,
        modelId,
        data.name,
        newVersion,
      );
      await assertSafePath(contentPath, boundary);
      await atomicWriteFile(contentPath, content);

      // Update latest marker
      await this.advanceLatestMarker(type, modelId, data.name, newVersion);

      // Staged before the prune below, so a failed prune never leaves the
      // version local-only.
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

      // Reported only on v3, where a run record keeps it (swamp-club#3279);
      // nothing about a v2 save changes.
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
      const existing = await this.findByName(type, modelId, data.name);
      if (existing) {
        if (!existing.isOwnedBy(data.ownerDefinition)) {
          throw new OwnershipValidationError(
            data.name,
            existing.ownerDefinition,
            data.ownerDefinition,
          );
        }
      }

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
        // Register the write as pending before any of its files reach disk, so
        // delete and GC never mistake the new version for a promoted one.
        this.upsertPendingRow(type, modelId, dataToSave);

        const metadataPath = this.getMetadataPath(
          type,
          modelId,
          data.name,
          newVersion,
        );
        const boundary = this.baseDir;
        await assertSafePath(metadataPath, boundary);
        const metadata = dataToSave.toData();
        const cleanData = JSON.parse(JSON.stringify(metadata));
        const metadataContent = stringifyYaml(
          cleanData as Record<string, unknown>,
        );
        await atomicWriteTextFile(metadataPath, metadataContent);

        const contentPath = this.getContentPath(
          type,
          modelId,
          data.name,
          newVersion,
        );
        await assertSafePath(contentPath, boundary);
        await atomicWriteFile(contentPath, content);
      } catch (error) {
        // No receipt reaches the caller, so nothing else would roll this
        // version back; its pending row would stay under this live process.
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

      // Appending to a missing or stale content file would write new bytes
      // after a truncated prefix, record that size, and push the corrupt file
      // (swamp-club#3178).
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
      // On v3 the append edits the version it was loaded from: its metadata
      // put expects the digest it replaces, so a version another writer
      // recorded under this number refuses it rather than being overwritten.
      // Read only on v3, before the rewrite destroys it.
      const priorMetadata = typedStagingActive(this.markDirty)
        ? await this.computeChecksum(
          await Deno.readFile(
            this.getMetadataPath(type, modelId, dataName, latestVersion),
          ),
        )
        : undefined;
      const file = await Deno.open(contentPath, { append: true });
      try {
        await file.write(content);
      } finally {
        file.close();
      }

      // Update metadata with new size (O(1) via stat, no file read)
      const stat = await Deno.stat(contentPath);
      const metadataPath = this.getMetadataPath(
        type,
        modelId,
        dataName,
        latestVersion,
      );
      const metadata = data.toData();
      metadata.size = stat.size;
      // Remove stale checksum — content has changed and recomputing
      // would require reading the entire file into memory
      delete metadata.checksum;
      const cleanData = JSON.parse(JSON.stringify(metadata));
      await atomicWriteTextFile(
        metadataPath,
        stringifyYaml(cleanData as Record<string, unknown>),
      );

      // Update catalog with new size
      const updatedData = Data.fromData(metadata);
      this.catalogUpsert(type, modelId, updatedData);

      // The append re-records the live version it extended.
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
    // Without this a file that was never pulled streamed as empty, and one
    // left stale by a metadata-only pull streamed its old bytes
    // (swamp-club#3178).
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
      return await Deno.readFile(contentPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        await this.throwIfUnreadable(contentPath);
        return null;
      }
      throw error;
    }
  }

  /**
   * Throws when the datastore recorded the missing content at `contentPath`
   * as unreadable (swamp-club#3617), so the read fails loudly instead of
   * reading as absent. Content that is simply absent returns.
   */
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
      // Nothing could replace the file, but the synchronous readers that
      // ensure content first must fail loudly on a record the datastore
      // could not materialise rather than read it as empty
      // (swamp-club#3617). Only an absent file is looked up.
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
    if (!this.hydrateFile) return true;
    const contentPath = this.getContentPath(type, modelId, dataName, version);
    const localSize = fileSizeSync(contentPath);
    if (localSize === null) return false;
    if (localSize >= size) return true;
    return this.isAcceptedShort(contentPath, size);
  }

  /**
   * The content-ensuring step every read of a content file goes through
   * (swamp-club#3178). With a hydrate hook, a missing file is downloaded,
   * and so is one shorter than the size its metadata records: a
   * metadata-only pull brings the new size of a version another host
   * appended to but leaves the old bytes. A local write never leaves a file
   * short: append writes the content before the metadata, and save writes
   * the metadata first while the content file is still absent. A file
   * still short after the download is the remote's copy; it is used as it
   * is for {@link ACCEPTED_SHORT_CONTENT_TTL_MS}.
   *
   * Without a hydrate hook nothing could replace the file, so it is
   * `current` without being looked at, and callers read it as before.
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
    // The recorded size is read before the file is: a local append writes
    // raw before metadata.yaml, so a size read first can never exceed the
    // file's. Read after, it could be the size of an append that landed in
    // between, and the current file would look stale and be replaced.
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

  /**
   * Whether a refresh within {@link ACCEPTED_SHORT_CONTENT_TTL_MS} found
   * the content at `contentPath` short of `recordedSize`. An expired entry
   * is deleted, so a long-lived repository does not accumulate them.
   */
  private isAcceptedShort(contentPath: string, recordedSize: number): boolean {
    const key = `${contentPath}\0${recordedSize}`;
    const until = this.acceptedShort.get(key);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.acceptedShort.delete(key);
    return false;
  }

  /** The size a version's metadata records, if it records one. */
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
    // A metadata file that does not parse records no size; the read goes
    // ahead as it did before the size check.
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
    if (version !== undefined) {
      // Delete specific version
      const versionDir = this.getPath(type, modelId, dataName, version);
      await this.staged({
        kind: "remove",
        path: this.getPath(type, modelId, dataName, version),
      }, async () => {
        try {
          await Deno.remove(versionDir, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            throw error;
          }
        }
      });

      // Drop the deleted version's catalog row before touching the latest
      // marker — leaves the catalog in a valid state even if the follow-up
      // latest update fails.
      this.catalogStore.removeVersion(
        this.namespace,
        type.normalized,
        modelId,
        dataName,
        version,
        computeLatestFlags,
      );
      this.catalogStore.recordLocalWrite();

      // Update latest marker if needed
      const { onDisk, promoted } = await this.listPromotedVersions(
        type,
        modelId,
        dataName,
      );

      const newLatest = maxOf(promoted);
      if (newLatest !== undefined) {
        await this.updateLatestMarker(type, modelId, dataName, newLatest);
        // Update catalog to reflect new latest version
        const latestData = await this.findByName(
          type,
          modelId,
          dataName,
          newLatest,
        );
        if (latestData?.isRenamed && latestData.renamedTo) {
          // The rename marker stays latest: the name still forwards, and a
          // marker is not a catalog row.
          this.catalogRemove(type, modelId, dataName);
          this.recordRenameForward(
            type,
            modelId,
            dataName,
            latestData.renamedTo,
          );
        } else if (latestData) {
          this.catalogUpsert(type, modelId, latestData);
        }
      } else if (onDisk.length > 0) {
        // Only in-flight deferred writes are left. Point the marker at
        // NO_PROMOTED_VERSION, which no write is ever allocated, so reads
        // find nothing instead of falling back to the highest version on
        // disk; the write's promotion moves the marker forward again.
        await this.updateLatestMarker(
          type,
          modelId,
          dataName,
          NO_PROMOTED_VERSION,
        );
      } else {
        // No versions left, remove the data name directory. The latest
        // marker goes with it, so its removal is staged too: unstaged, a
        // synced datastore kept a remote `latest` naming a version no
        // longer there (swamp-club#3473).
        const dataNameDir = this.getDataNameDir(type, modelId, dataName);
        await this.staged(
          { kind: "remove", path: join(dataNameDir, "latest") },
          () => Deno.remove(dataNameDir, { recursive: true }).catch(() => {}),
        );
        this.catalogRemove(type, modelId, dataName);
      }
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
    } else {
      // Delete all versions. Emit per-version-directory signals so the
      // sync service sees individual absent paths it can match against
      // its index — a single data-name-directory signal does not map to
      // any individual index entry and the extension skips deletion.
      // Matches the collectGarbage pattern (swamp-club#2277).
      const dataNameDir = this.getDataNameDir(type, modelId, dataName);
      let versions: number[] = [];
      let removals: StagedChange[];
      try {
        versions = await this.listVersions(type, modelId, dataName);
        removals = versions.map((v) => ({
          kind: "remove",
          path: this.getPath(type, modelId, dataName, v),
        }));
        removals.push({ kind: "remove", path: join(dataNameDir, "latest") });
      } catch {
        // Enumeration failed (directory absent, lazy hydration) — fall
        // back to the data-name directory signal.
        removals = [{ kind: "remove", path: dataNameDir }];
      }
      await this.staged(removals, async () => {
        try {
          await Deno.remove(dataNameDir, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            throw error;
          }
        }
      });
      this.catalogRemove(type, modelId, dataName);
      // Each version seen is its own versioned tombstone, so a version
      // written concurrently survives; one batch each, so a name with many
      // versions splits across commits.
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
    }
  }

  /**
   * Removes the latest marker for expired data (soft delete).
   * Version directories remain on disk but data becomes inaccessible.
   */
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
        // Marker already missing is OK
      }

      this.catalogRemove(type, modelId, dataName);
      // Expiry: a version-less data.gc of the marker; the versions stay.
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
    // Old-name directory covers tombstone, content, and latest-marker
    // writes. The inner save() emits its own per-path signal for newName.
    return await this.staged({
      kind: "write",
      path: this.getDataNameDir(type, modelId, oldName),
    }, async () => {
      // Read the latest version of old data
      const oldData = await this.findByName(type, modelId, oldName);
      if (!oldData) {
        throw new Error(`Data "${oldName}" not found`);
      }
      if (oldData.isDeleted) {
        throw new Error(`Data "${oldName}" is already deleted or renamed`);
      }

      // Verify new name doesn't already have active data
      const existingNew = await this.findByName(type, modelId, newName);
      if (existingNew && !existingNew.isDeleted) {
        throw new Error(`Data "${newName}" already exists`);
      }

      // Read the content to copy
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

      // Create new data under the new name with a fresh ID
      const newData = Data.create({
        name: newName,
        contentType: oldData.contentType,
        lifetime: oldData.lifetime,
        garbageCollection: oldData.garbageCollection,
        streaming: oldData.streaming,
        tags: { ...oldData.tags },
        ownerDefinition: { ...oldData.ownerDefinition },
      });

      // Save under the new name. Its typed changes stage below, in the
      // rename's own batch with the rename intent.
      const { version: newVersion } = await this.saveVersion(
        type,
        modelId,
        newData,
        content,
        undefined,
      );
      let tombstoneVersion = 0;

      // Write a tombstone with forward reference on the old name.
      // If this fails, roll back the newly saved data to avoid an inconsistent
      // state where both old and new names have valid active data.
      try {
        const versions = await this.listVersions(type, modelId, oldName);
        const nextTombstoneVersion = (maxOf(versions) ?? 0) + 1;
        const tombstone = oldData.withRenameMarker({
          version: nextTombstoneVersion,
          renamedTo: newName,
        });

        // Save tombstone metadata and content
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

        const metadataPath = this.getMetadataPath(
          type,
          modelId,
          oldName,
          tombstoneVersion,
        );
        const boundary = this.baseDir;
        await assertSafePath(metadataPath, boundary);
        const metadata = tombstoneData.toData();
        const cleanData = JSON.parse(JSON.stringify(metadata));
        const metadataYaml = stringifyYaml(
          cleanData as Record<string, unknown>,
        );
        await atomicWriteTextFile(metadataPath, metadataYaml);

        const contentPath = this.getContentPath(
          type,
          modelId,
          oldName,
          tombstoneVersion,
        );
        await assertSafePath(contentPath, boundary);
        await atomicWriteFile(contentPath, tombstoneContent);

        // Update latest marker to point to tombstone
        await this.updateLatestMarker(type, modelId, oldName, tombstoneVersion);
      } catch (tombstoneError) {
        // Roll back: remove the newly created data under the new name
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
          // If this was the only version, clean up the data name directory.
          // Otherwise, reset the latest marker to the highest remaining version
          // to avoid a corrupted marker pointing to the deleted version.
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
        // The new version was never staged; stage the new name's marker as
        // the rollback left it. A staging error must not hide the rename's.
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

      // One batch, so the rename lands in one commit: the new name's version
      // and the old name's marker version, both with the rename intent, and
      // each name's latest marker.
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

      // The old name is now a tombstone: drop its rows and record the forward
      // so data query can follow it. Outside the rollback above: the files are
      // authoritative and the catalog is a projection the next backfill
      // rebuilds, so a failed catalog write must never undo the rename.
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
    { version: number; contentPath: string; priorVersions: number[] }
  > {
    // Reject reserved data names that collide with internal markers
    if (isReservedDataName(data.name)) {
      throw new Error(
        `Data name '${data.name}' is reserved for internal use. Use a different name.`,
      );
    }

    // Pre-write notify with the data-name directory: version not yet
    // allocated. Same granularity as save/append.
    return await this.staged({
      kind: "write",
      path: this.getDataNameDir(type, modelId, data.name),
    }, async () => {
      // Validate ownership if data with this name already exists
      const existing = await this.findByName(type, modelId, data.name);
      if (existing) {
        if (!existing.isOwnedBy(data.ownerDefinition)) {
          throw new OwnershipValidationError(
            data.name,
            existing.ownerDefinition,
            data.ownerDefinition,
          );
        }
      }

      // Atomically allocate a new version directory
      const { version: newVersion, priorVersions } = await this
        .atomicAllocateVersionDir(
          type,
          modelId,
          data.name,
        );

      // A deferred write is registered as pending before its content is
      // streamed in; finalizeVersionDeferred completes the row.
      if (options?.deferred) {
        try {
          this.upsertPendingRow(
            type,
            modelId,
            data.withNewVersion({ version: newVersion, size: 0 }),
          );
        } catch (error) {
          // The writer never gets the allocation, so nothing else would roll
          // the empty version directory back.
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

      return { version: newVersion, contentPath, priorVersions };
    });
  }

  async finalizeVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
    priorVersions?: number[],
  ): Promise<{ size: number; checksum: string }> {
    // Version is known here (allocateVersion has already run); pass the
    // version directory as the per-call signal.
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

      // Read content to compute size and checksum
      const content = await Deno.readFile(contentPath);
      const size = content.length;
      const checksum = await this.computeChecksum(content);

      // Create the data with updated version, size, and checksum
      const dataToSave = data.withNewVersion({
        version,
        size,
        checksum,
      });

      // Save metadata
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
      await atomicWriteTextFile(metadataPath, metadataContent);

      // Update latest marker
      await this.advanceLatestMarker(type, modelId, data.name, version);

      // The content was streamed in by the writer; it stages from the file.
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
      await atomicWriteTextFile(metadataPath, metadataContent);

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
        // Settle the pending row before the marker moves, so a failure or
        // crash between the two never leaves a version the marker names
        // looking like an orphan GC may reclaim. A version without metadata
        // (a writer that never finalized) had no row before deferred writes
        // were registered early, and gets none.
        this.catalogStore.settlePending(
          this.namespace,
          receipt.type.normalized,
          receipt.modelId,
          receipt.dataName,
          receipt.version,
          data !== null,
        );
        this.catalogStore.recordLocalWrite();
        await this.advanceLatestMarker(
          receipt.type,
          receipt.modelId,
          receipt.dataName,
          receipt.version,
        );
        // Promoted once the marker moved, whatever fails after it.
        promoted = { hasMetadata: data !== null };
        if (data) {
          this.catalogUpsert(receipt.type, receipt.modelId, data);
        }
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
      // A deferred version reaches v3 when it is promoted. Outside the catch
      // above, so a v3 staging error is never only logged; collected, so
      // the receipts after it are still promoted.
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
   * Enforces a version cap once a deferred write is promoted, as `save`
   * does for a direct write. A deferred write is not pruned when it is
   * written, since it may yet be rolled back (swamp-club#3251).
   *
   * The promoted version need not be the newest — newer writes may have
   * been promoted first — so it is counted with the rest and the newest
   * `cap` are kept, which may drop the promoted version itself.
   * `pruneExcessVersions` leaves room for one more version, hence `cap + 1`.
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
      // An unpromoted version was never staged, so its tombstones are
      // harmless; they keep v3 right should a rollback follow a promotion.
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
   * Rolls back a failed write's version on the way to rethrowing the
   * write's error. On v3 an error of the rollback (its typed staging) is
   * logged, so it never replaces the error that caused it. On v2 the
   * rollback runs exactly as it always has, and its error reaches the
   * caller as before.
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

  // --- Sync read methods ---

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
      // Try reading as text file first (new format)
      const content = Deno.readTextFileSync(latestPath);
      const version = parseInt(content.trim(), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a text file or not found
    }
    try {
      // Backward compat: try reading as symlink (old format)
      const linkTarget = Deno.readLinkSync(latestPath);
      const version = parseInt(linkTarget.replace(/\/$/, ""), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a symlink either
    }
    // Final fallback: scan version directories
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

      // Follow forward references for latest lookups (not explicit version requests)
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
      return Deno.readFileSync(contentPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  findAllForModelSync(type: ModelType, modelId: string): Data[] {
    return this.collectModelDataSync(type, modelId);
  }

  /** Sync twin of {@link collectModelData}. */
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

  /** Sync twin of {@link findAllGlobal}, in the same name order. */
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
          // Model-id directory — probe for the target dataName only.
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
          // Type directory — recurse.
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
            // See collectAllData — a silent drop here becomes a catalog delete.
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
        // Keep N most recent versions
        const toKeep = gc;
        if (versions.length > toKeep) {
          versionsToRemove = versions.slice(0, versions.length - toKeep);
        }
      } else {
        // Keep versions within duration
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
            // Don't remove if it's the only/latest version
            if (version !== latestVersion) {
              versionsToRemove.push(version);
            }
          }
        }
      }

      // Build removal tasks upfront
      const removalTasks = versionsToRemove.map((version) => ({
        version,
        contentPath: this.getContentPath(type, modelId, data.name, version),
        versionDir: this.getPath(type, modelId, data.name, version),
      }));
      const removed: number[] = [];

      // Execute in parallel batches. For dry-run we still stat each path to
      // accumulate bytesReclaimed but skip the actual remove.
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
      // Staged after the parallel removals, outside allSettled, so a v3
      // staging error surfaces; one batch per version.
      for (const version of removed) {
        await this.stageRemovedVersion(
          "data.gc",
          type,
          modelId,
          data.name,
          version,
        );
      }

      // Re-scan actual versions after parallel deletions to avoid stale marker.
      // Skip for dry-run — nothing was actually removed.
      if (!dryRun && versionsToRemove.length > 0) {
        // Drop catalog rows for all removed versions in one transaction.
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
          // Update catalog with the surviving latest version
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
          // Only in-flight deferred writes are left: as delete does.
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
   * Record reads used for resource claims must stay in the requested model.
   * Resolve the configured datastore root, then append the model identity
   * lexically: resolving the model boundary itself would trust a symlink
   * that redirects the entire model directory into another model.
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
   * A data name's version floor (swamp-club#3473): the highest version it
   * had when its newest versions were deleted, so a later write never reuses
   * a number another clone may still hold for different content. One small
   * file per name beside the name's directory, named with `..` (which no
   * data name contains) so it can never be a data name, and holding only
   * the number, so two clones raising different names' floors never
   * overwrite each other.
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
      // Absent or unreadable: no floor, as before the record existed.
      return 0;
    }
  }

  /**
   * Raises a name's version floor to `version`, before retention deletes
   * its newest versions, so later writes continue above it. v2 only: a v3
   * partition keeps its own high-water mark, and a plain file is not one of
   * the changes a v3 unit commits.
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
   * Atomically allocates a new version directory using mkdir as a claim mechanism.
   * On collision (AlreadyExists), increments the version and retries.
   */
  private async atomicAllocateVersionDir(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<{ version: number; versionDir: string; priorVersions: number[] }> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    await assertSafePath(dataNameDir, this.baseDir);
    await Deno.mkdir(dataNameDir, { recursive: true });

    const versions = await this.listVersions(type, modelId, dataName);
    // Never below the version floor: a number deleted versions used is not
    // given to new content. v2 keeps it in a file (swamp-club#3473); on v3 it
    // is the partition's high-water mark, with the versions this process
    // staged but has not committed yet (swamp-club#3532). The partition key
    // is built only on v3: it needs a UUID model id, and v2 does not.
    // v3 still reads the version directories: the mkdir below is what keeps
    // two units of this process apart before either commits. A dropped
    // version's directory does not outlive its command (swamp-club#3553),
    // except in a running serve, where it can skip a number until serve
    // stops; a number is skipped, never reused.
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
    // An in-flight deferred write is neither counted nor pruned, as in GC.
    const pending = this.catalogStore.pendingVersions(
      this.namespace,
      type.normalized,
      modelId,
      dataName,
    );
    const promoted = priorVersions.filter((v) => !pending.has(v));
    if (promoted.length < cap) return;
    const sorted = [...promoted].sort((a, b) => a - b);
    const toRemove = sorted.slice(0, sorted.length - cap + 1);
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
      // Try reading as a text file first (new format)
      const content = await Deno.readTextFile(latestPath);
      const version = parseInt(content.trim(), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a text file or not found
    }
    try {
      // Backward compat: try reading as a symlink (old format)
      const linkTarget = await Deno.readLink(latestPath);
      const version = parseInt(linkTarget.replace(/\/$/, ""), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a symlink either
    }
    // Final fallback: scan version directories
    const versions = await this.listVersions(type, modelId, dataName);
    return maxOf(versions) ?? null;
  }

  /**
   * Moves the latest marker to `version` unless it already names a higher
   * version, so the marker follows version order like the catalog's
   * `is_latest` (`CatalogStore.upsertNewVersion`) when parallel writers of
   * one name finish out of order (swamp-club#2520). The read, compare and
   * write run synchronously so writers in this process cannot interleave
   * between them; writers in other processes are serialized by the model
   * lock. A marker naming a version that is gone from disk (a delete or GC
   * that stopped before rewriting it) is replaced. Paths that lower the
   * marker on purpose — delete, rename, GC — use {@link updateLatestMarker}.
   */
  private async advanceLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<void> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    await assertSafePath(dataNameDir, this.baseDir);
    const latestPath = join(dataNameDir, "latest");

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
      return;
    }

    try {
      if (Deno.lstatSync(latestPath).isSymlink) Deno.removeSync(latestPath);
    } catch {
      // Ignore if not found
    }
    const tmpPath = join(dataNameDir, `.${crypto.randomUUID()}.tmp`);
    try {
      Deno.writeTextFileSync(tmpPath, version.toString());
      Deno.renameSync(tmpPath, latestPath);
    } catch (error) {
      try {
        Deno.removeSync(tmpPath);
      } catch {
        // Temp file may not exist if the write failed before creating it
      }
      throw error;
    }
  }

  /**
   * Moves the latest marker of `dataName` forward to `version` again when a
   * datastore pull replaced it with an older marker before this process
   * pushed it (swamp-club#3146). For the lock flush, about a version this
   * process wrote under the model's lock.
   *
   * Changes nothing and returns undefined when the version's metadata is
   * gone: a delete, garbage collection or rollback removed it on purpose.
   * Otherwise stages the version directory and the latest marker again,
   * after the write, so a push that cleared the marks made before the write
   * cannot have dropped them, and returns both paths. Never lowers the
   * marker.
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
   * The version the latest marker names, or null when there is no marker.
   * Unlike {@link getLatestVersion} it never falls back to scanning the
   * version directories.
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
   * Removes a data name that has no versions left but still has a latest
   * marker. Deleting the last promoted version while a deferred write is in
   * flight leaves the marker at NO_PROMOTED_VERSION; once that write is
   * rolled back too, nothing is left to read. A name without a marker (a
   * first deferred write rolled back) is left as it is.
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
   * Writes the catalog row of a deferred write that is not promoted yet: both
   * latest flags 0, so latest-based queries do not see it, and marked pending
   * with this process's pid and host identity, so delete and GC leave it alone
   * while it is in flight and GC can reclaim it if this process dies.
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
   * The versions on disk, and those of them that are promoted. An in-flight
   * deferred write (a pending catalog row) is on disk before it is promoted,
   * so delete and GC must not make it latest, count it as the latest to keep,
   * or prune it until it is promoted or rolled back. A backfill keeps the
   * pending rows it finds; only a catalog rebuilt from an empty table (a
   * schema change) treats every version on disk as promoted.
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
   * Rolls back deferred writes whose process died before promoting or
   * rolling them back. Their pending rows would otherwise keep the versions
   * out of GC and the version cap until a catalog rebuild. A row counts as
   * orphaned only when it was written under this process's host identity
   * (hostname, plus pid namespace on Linux) and its pid is dead; a row from
   * another host or container, this process, or a live pid is left in
   * flight. A data name left with no versions is removed, as GC removes an
   * emptied name.
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
      // Promotion settles the pending row before moving the marker, so a
      // marker naming this version means it was promoted all the same:
      // finish settling it instead of reclaiming it.
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
        // Promoted by a process that died before it could commit: stage it
        // now, or v3 never gets it.
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

    // Remove old symlink or file if it exists
    try {
      await Deno.remove(latestPath);
    } catch {
      // Ignore if not found
    }

    // Write version number as plain text
    await atomicWriteTextFile(latestPath, version.toString());
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

/**
 * Throws the v3 staging errors a loop over receipts collected, after every
 * receipt was handled: the one error, or all of them.
 */
function throwStagingErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Staging typed changes failed");
  }
}

/**
 * Creates an OwnerDefinition for a model method.
 */
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

/**
 * Creates an OwnerDefinition for a workflow step.
 */
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

/**
 * Creates an OwnerDefinition for manual data creation.
 */
export function createManualOwner(
  description: string,
): OwnerDefinition {
  return {
    ownerType: "manual",
    ownerRef: description,
  };
}
