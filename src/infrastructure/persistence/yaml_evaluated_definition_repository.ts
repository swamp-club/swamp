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

import {
  type DeferredExpression,
  DeferredExpressionSchema,
} from "../../domain/expressions/deferred_expression.ts";
import { ensureDir, walk } from "@std/fs";
import { basename, join } from "@std/path";
import {
  stageTyped,
  typedStagingActive,
  withChangeSignalled,
} from "./unit_of_work_scope.ts";
import {
  keyUnder,
  readPriorFile,
  unlessUnpartitionable,
} from "./config_staging.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { ModelChanges } from "../../domain/datastore_v3/repository_changes.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { ModelType } from "../../domain/models/model_type.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { assertSafePath } from "./safe_path.ts";
import {
  unreadableRecordsUnder,
  warnUnreadableLeftOut,
} from "./unreadable_records.ts";
import {
  createDefinitionId,
  Definition,
  type DefinitionData,
  type DefinitionId,
  isFilenameSafeDefinitionName,
} from "../../domain/definitions/definition.ts";
import type {
  MarkDirtyHook,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
import { ProvenanceMap } from "../../domain/expressions/provenance_map.ts";
import {
  SENSITIVE_FORMAT_VERSION,
  type WrittenReference,
  WrittenReferenceSchema,
} from "../../domain/secrets/mod.ts";
import {
  findPlaintextSensitiveArguments,
  type MaskedPath,
  MaskedPathSchema,
  maskProvenance,
  PLAINTEXT_SENSITIVE_EVALUATED_ARG_CODE,
  plaintextSensitiveArgumentsMessage,
} from "../../domain/expressions/persisted_evaluation.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { UserError } from "../../domain/errors.ts";

export interface EvaluatedDefinitionCache {
  definition: Definition;
  /**
   * Where data sits in the definition, in the coordinates of the raw copy
   * rehydrate restores (swamp-club#3205). Absent in caches written before
   * provenance was recorded; `"unreadable"` when present but malformed, which
   * replay refuses rather than trusting the expressions it holds.
   */
  provenance?: ProvenanceMap | "unreadable";
  /** Data ranges in persisted text, before vault references are restored. */
  persistedProvenance?: ProvenanceMap | "unreadable";
  authoredExpressions: ReadonlySet<string>;
  deferredExpressions: readonly DeferredExpression[];
  /** Where the file holds vault references in place of sensitive values. */
  writtenReferences: readonly WrittenReference[];
  /**
   * Where the file holds the mask in place of a sensitive argument that did
   * not come from a vault (swamp-club#3681); a replay refuses these whatever
   * the type's schema marks at the time. Empty in caches written before.
   */
  maskedPaths: readonly MaskedPath[];
  /**
   * Set when the file was written with sensitive values kept as references;
   * absent in caches written before that, which may hold plaintext.
   */
  sensitiveFormat?: number;
}

// Cache metadata is deliberately separate from the source Definition schema.
const CacheMetadataSchema = z.object({
  authoredExpressions: z.array(z.string()).optional(),
  deferredExpressions: z.array(DeferredExpressionSchema).optional(),
  writtenReferences: z.array(WrittenReferenceSchema).optional(),
  maskedPaths: z.array(MaskedPathSchema).optional(),
  sensitiveFormat: z.number().int().positive().optional(),
  provenance: z.unknown().optional(),
  persistedProvenance: z.unknown().optional(),
});

export function parseEvaluatedDefinitionCache(
  content: string,
): EvaluatedDefinitionCache | null {
  const data = parseYaml(content) as DefinitionData | null;
  if (!data) return null;
  const metadata = CacheMetadataSchema.parse(data);
  let provenance: ProvenanceMap | "unreadable" | undefined;
  if (metadata.provenance !== undefined) {
    try {
      provenance = ProvenanceMap.fromData(metadata.provenance);
    } catch {
      provenance = "unreadable";
    }
  }
  let persistedProvenance: ProvenanceMap | "unreadable" | undefined;
  if (metadata.persistedProvenance !== undefined) {
    try {
      persistedProvenance = ProvenanceMap.fromData(
        metadata.persistedProvenance,
      );
    } catch {
      persistedProvenance = "unreadable";
    }
  }
  // `evaluatedInputs` and `resolvedExpressions` were written by unreleased
  // builds (swamp-club#3583) and are dropped on read: nothing reads them, and
  // the definition schema rejects unknown keys.
  const {
    provenance: _provenance,
    evaluatedInputs: _evaluatedInputs,
    resolvedExpressions: _resolvedExpressions,
    ...definitionData
  } = data as
    & DefinitionData
    & {
      provenance?: unknown;
      evaluatedInputs?: unknown;
      resolvedExpressions?: unknown;
    };
  return {
    definition: Definition.fromData(definitionData),
    provenance,
    persistedProvenance,
    authoredExpressions: new Set(metadata.authoredExpressions),
    deferredExpressions: metadata.deferredExpressions ?? [],
    writtenReferences: metadata.writtenReferences ?? [],
    maskedPaths: metadata.maskedPaths ?? [],
    sensitiveFormat: metadata.sensitiveFormat,
  };
}

/**
 * YAML-based repository for evaluated definitions.
 *
 * Stores definitions with CEL expressions already evaluated in the directory structure:
 * {repoDir}/.swamp/definitions-evaluated/{normalized-type}/{name}.yaml
 * (or {uuid}.yaml for legacy/non-filename-safe names).
 *
 * This directory is gitignored as evaluated definitions are derived data
 * that can be regenerated from the source definitions.
 */
export class YamlEvaluatedDefinitionRepository {
  private readonly baseDir: string;
  private readonly idToActualPath = new Map<DefinitionId, string>();

  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly markDirty?: MarkDirtyHook,
    /**
     * Tells an evaluated definition a v3 read model could not materialise
     * from an absent one (swamp-club#3617), so a lookup that finds no
     * evaluated definition fails loudly on it instead.
     */
    readonly unreadableContent?: UnreadableContentLookup,
  ) {
    this.baseDir = baseDir ??
      swampPath(repoDir, SWAMP_SUBDIRS.definitionsEvaluated);
  }

  /**
   * Throws when the datastore recorded the evaluated definition missing at
   * `path` as unreadable (swamp-club#3617). A file that is simply absent
   * returns.
   */
  private async throwIfUnreadable(path: string): Promise<void> {
    const error = await this.unreadableContent?.(path);
    if (error !== undefined) throw error;
  }

  /**
   * Finds an evaluated definition by its ID.
   *
   * @param type - The model type
   * @param id - The definition ID
   * @returns The evaluated definition if found, or null
   */
  async findById(
    type: ModelType,
    id: DefinitionId,
  ): Promise<Definition | null> {
    // Fast path: try UUID-based filename (legacy)
    const legacyPath = this.getLegacyPath(type, id);
    try {
      const content = await Deno.readTextFile(legacyPath);
      const cached = parseEvaluatedDefinitionCache(content);
      if (cached) {
        const { definition } = cached;
        this.idToActualPath.set(id, legacyPath);
        return definition;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Try cached path
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath && cachedPath !== legacyPath) {
      try {
        const content = await Deno.readTextFile(cachedPath);
        const cached = parseEvaluatedDefinitionCache(content);
        if (cached) return cached.definition;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    // Slow path: scan all files
    const definitions = (await this.findAllWithProvenance(type)).map((c) =>
      c.definition
    );
    const found = definitions.find((d) => d.id === id);
    if (found) return found;
    await this.throwIfUnreadable(legacyPath);
    return null;
  }

  /**
   * Finds all evaluated definitions of a given type.
   *
   * @param type - The model type
   * @returns Array of evaluated definitions
   */
  async findAll(type: ModelType): Promise<Definition[]> {
    const definitions = (await this.findAllWithProvenance(type)).map((c) =>
      c.definition
    );
    await warnUnreadableLeftOut(this.unreadableContent, this.getTypeDir(type));
    return definitions;
  }

  private async findAllWithProvenance(
    type: ModelType,
  ): Promise<EvaluatedDefinitionCache[]> {
    const dir = this.getTypeDir(type);
    const definitions: EvaluatedDefinitionCache[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const cached = parseEvaluatedDefinitionCache(content);
          if (!cached) continue;
          const { definition } = cached;
          this.idToActualPath.set(definition.id as DefinitionId, path);
          definitions.push(cached);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return definitions;
  }

  /**
   * Finds an evaluated definition by its name within a specific type.
   *
   * @param type - The model type
   * @param name - The definition name
   * @returns The evaluated definition if found, or null
   */
  async findByName(type: ModelType, name: string): Promise<Definition | null> {
    return (await this.findByNameWithProvenance(type, name))?.definition ??
      null;
  }

  /** Reads definition and provenance from the same cache snapshot. */
  async findByNameWithProvenance(
    type: ModelType,
    name: string,
  ): Promise<EvaluatedDefinitionCache | null> {
    if (isFilenameSafeDefinitionName(name)) {
      const namePath = this.getNamePath(type, name);
      try {
        const content = await Deno.readTextFile(namePath);
        const cached = parseEvaluatedDefinitionCache(content);
        if (cached) {
          const { definition } = cached;
          if (definition.name !== name) {
            // File content doesn't match filename — fall through to slow path
          } else {
            this.idToActualPath.set(definition.id as DefinitionId, namePath);
            return cached;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    const definitions = await this.findAllWithProvenance(type);
    const found = definitions.find((c) => c.definition.name === name);
    if (found) return found;
    if (isFilenameSafeDefinitionName(name)) {
      await this.throwIfUnreadable(this.getNamePath(type, name));
    }
    return null;
  }

  /**
   * Finds an evaluated definition by its name across all model types.
   *
   * @param name - The definition name
   * @returns The definition and its type if found, or null
   */
  async findByNameGlobal(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    const definitionsDir = this.baseDir;
    const found = await this.searchDefinitionByName(definitionsDir, [], name);
    if (found) return found;
    // The name, under whichever type's directory: one query over the base,
    // which also finds a type with no directory left (swamp-club#3617).
    for (
      const entry of await unreadableRecordsUnder(
        this.unreadableContent,
        this.baseDir,
      )
    ) {
      if (basename(entry.path) === `${name}.yaml`) throw entry.error;
    }
    return null;
  }

  /**
   * Recursively searches for a definition file by name in nested directory structures.
   */
  private async searchDefinitionByName(
    currentDir: string,
    pathSegments: string[],
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    try {
      for await (const entry of Deno.readDir(currentDir)) {
        const fullPath = join(currentDir, entry.name);

        if (entry.isFile && entry.name.endsWith(".yaml")) {
          // Found a YAML file, check if it matches the name
          const content = await Deno.readTextFile(fullPath);
          const cached = parseEvaluatedDefinitionCache(content);
          if (!cached) continue;
          const { definition } = cached;

          if (definition.name === name) {
            this.idToActualPath.set(definition.id as DefinitionId, fullPath);
            // Reconstruct the model type from the path segments
            const typeStr = pathSegments.join("/");
            return { definition, type: ModelType.create(typeStr) };
          }
        } else if (entry.isDirectory) {
          // Recursively search subdirectories
          const result = await this.searchDefinitionByName(
            fullPath,
            [...pathSegments, entry.name],
            name,
          );
          if (result) {
            return result;
          }
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

  /**
   * Finds all evaluated definitions across all model types in the repository.
   *
   * @returns Array of all evaluated definitions with their types
   */
  async findAllGlobal(): Promise<
    { definition: Definition; type: ModelType }[]
  > {
    const definitionsDir = this.baseDir;
    const results: { definition: Definition; type: ModelType }[] = [];
    await this.collectAllDefinitions(definitionsDir, [], results);
    await warnUnreadableLeftOut(this.unreadableContent, definitionsDir);
    return results;
  }

  /**
   * Recursively collects all definition files from nested directory structures.
   */
  private async collectAllDefinitions(
    currentDir: string,
    pathSegments: string[],
    results: { definition: Definition; type: ModelType }[],
  ): Promise<void> {
    try {
      for await (const entry of Deno.readDir(currentDir)) {
        const fullPath = join(currentDir, entry.name);

        if (entry.isFile && entry.name.endsWith(".yaml")) {
          // Found a YAML file, add it to results
          const content = await Deno.readTextFile(fullPath);
          const cached = parseEvaluatedDefinitionCache(content);
          if (!cached) continue;
          const { definition } = cached;

          this.idToActualPath.set(definition.id as DefinitionId, fullPath);
          // Reconstruct the model type from the path segments
          const typeStr = pathSegments.join("/");
          results.push({ definition, type: ModelType.create(typeStr) });
        } else if (entry.isDirectory) {
          // Recursively search subdirectories
          await this.collectAllDefinitions(
            fullPath,
            [...pathSegments, entry.name],
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

  /**
   * Throws when a sensitive argument of `definition` holds a literal other
   * than the mask with no written reference. As in
   * `YamlDefinitionRepository.save`, the type's schemas come from the
   * registry, loading extensions if it takes that, and a type no extension
   * registers has nothing to check against and is let through.
   */
  private async refusePlaintextSensitiveArguments(
    type: ModelType,
    definition: Definition,
    writtenReferences: readonly WrittenReference[],
    provenance: ProvenanceMap | undefined,
    persistedProvenance: ProvenanceMap | undefined,
  ): Promise<void> {
    const modelDef = await modelRegistry.getOrLoad(type);
    if (!modelDef) return;
    const paths = findPlaintextSensitiveArguments(
      modelDef,
      definition.toData(),
      writtenReferences,
      { allowMask: true, provenance, persistedProvenance },
    );
    if (paths.length > 0) {
      throw new UserError(
        plaintextSensitiveArgumentsMessage(definition.name, paths),
        PLAINTEXT_SENSITIVE_EVALUATED_ARG_CODE,
      );
    }
  }

  /**
   * Saves an evaluated definition.
   *
   * @param type - The model type
   * @param definition - The evaluated definition to save
   */
  async save(
    type: ModelType,
    definition: Definition,
    /**
     * Where data sits in the raw copy of `definition` (swamp-club#3205).
     * Required so every writer states it; `undefined` writes the legacy
     * format, which replays with the raw-text rule alone.
     */
    provenance: ProvenanceMap | undefined,
    authoredExpressions?: ReadonlySet<string>,
    deferredExpressions?: readonly DeferredExpression[],
    writtenReferences: readonly WrittenReference[] = [],
    /** The positions `definition` holds the mask at (swamp-club#3681). */
    maskedPaths: readonly MaskedPath[] = [],
    persistedProvenance?: ProvenanceMap,
  ): Promise<void> {
    // Fail closed before anything is staged or written: a sensitive argument
    // reaches the cache only as a vault reference or the mask.
    z.array(MaskedPathSchema).parse(maskedPaths);
    // persistEvaluatedDefinition builds that form, so this never fires for a
    // writer that goes through it; one that bypasses it fails here instead
    // of leaking (swamp-club#3681).
    await this.refusePlaintextSensitiveArguments(
      type,
      definition,
      writtenReferences,
      provenance,
      persistedProvenance,
    );
    const targetPath = this.resolveWritePath(type, definition);
    return await withChangeSignalled(this.markDirty, {
      kind: "write",
      path: targetPath,
    }, {
      typed: true,
    }, async () => {
      const dir = this.getTypeDir(type);
      await assertSafePath(dir, this.baseDir);
      await ensureDir(dir);

      const data = {
        ...definition.toData(),
        deferredExpressions: deferredExpressions?.length
          ? deferredExpressions
          : undefined,
        authoredExpressions: authoredExpressions === undefined
          ? undefined
          : [...authoredExpressions],
        writtenReferences: writtenReferences.length
          ? writtenReferences
          : undefined,
        maskedPaths: maskedPaths.length ? maskedPaths : undefined,
        sensitiveFormat: SENSITIVE_FORMAT_VERSION,
        provenance: provenance
          ? maskProvenance(provenance, maskedPaths).toData()
          : undefined,
        persistedProvenance: persistedProvenance
          ? maskProvenance(persistedProvenance, maskedPaths).toData()
          : undefined,
      };
      // Ensure type metadata is always present in persisted YAML
      data.type = type.normalized;
      // typeVersion is copied verbatim from the source definition by toData().
      // Evaluated definitions are derived data replayed under --last-evaluated,
      // so restamping here would reintroduce the staleness masking fixed in the
      // source repository (swamp-club#900).
      // Remove undefined values since YAML can't stringify them
      const cleanData = JSON.parse(JSON.stringify(data));
      const content = stringifyYaml(cleanData as Record<string, unknown>);
      await atomicWriteTextFile(targetPath, content);
      // The paths a removal below actually removed, for their v3 tombstones.
      const removed: string[] = [];

      // Clean up old file if it's at a different path
      const previousPath = this.idToActualPath.get(definition.id);
      if (previousPath && previousPath !== targetPath) {
        try {
          await Deno.remove(previousPath);
          removed.push(previousPath);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            throw error;
          }
        }
      }

      // Also check legacy UUID path
      const legacyPath = this.getLegacyPath(type, definition.id);
      if (targetPath !== legacyPath && previousPath !== legacyPath) {
        try {
          await Deno.remove(legacyPath);
          removed.push(legacyPath);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            throw error;
          }
        }
      }

      this.idToActualPath.set(definition.id, targetPath);
      // On v3 (swamp-club#3256): the evaluated definition is derived, so its
      // changes carry no precondition.
      await stageTyped(this.markDirty, () => {
        const changes = new ModelChanges(type, definition.id);
        return [
          changes.writeEvaluatedDefinition(
            this.keyOf(targetPath),
            new TextEncoder().encode(content),
          ),
          ...removed.map((path) =>
            changes.removeEvaluatedDefinition(this.keyOf(path))
          ),
        ];
      });
    });
  }

  /**
   * Deletes an evaluated definition.
   *
   * @param type - The model type
   * @param id - The definition ID
   */
  async delete(type: ModelType, id: DefinitionId): Promise<void> {
    // Populate cache so we discover name-based files on a cold instance
    const definition = await this.findById(type, id);

    const pathsToTry = new Set([this.getLegacyPath(type, id)]);
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath) pathsToTry.add(cachedPath);
    if (definition && isFilenameSafeDefinitionName(definition.name)) {
      pathsToTry.add(this.getNamePath(type, definition.name));
    }

    const resolvedPath = this.idToActualPath.get(id) ??
      this.getLegacyPath(type, id);
    return await withChangeSignalled(this.markDirty, {
      kind: "remove",
      path: resolvedPath,
    }, {
      typed: true,
    }, async () => {
      const removed: string[] = [];
      for (const path of pathsToTry) {
        try {
          await Deno.remove(path);
          removed.push(path);

          // Clean up empty parent directories
          const definitionsDir = swampPath(
            this.repoDir,
            SWAMP_SUBDIRS.definitionsEvaluated,
          );
          await cleanupEmptyParentDirs(path, definitionsDir);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            throw error;
          }
        }
      }

      this.idToActualPath.delete(id);
      await stageTyped(this.markDirty, () => {
        const changes = new ModelChanges(type, id);
        return removed.map((path) =>
          changes.removeEvaluatedDefinition(this.keyOf(path))
        );
      });
    });
  }

  /**
   * Generates a new unique ID.
   */
  nextId(): DefinitionId {
    return createDefinitionId(crypto.randomUUID());
  }

  /**
   * Returns the file path for an evaluated definition.
   *
   * @param type - The model type
   * @param id - The definition ID
   * @returns The file path
   */
  getPath(type: ModelType, id: DefinitionId): string {
    return this.idToActualPath.get(id) ?? this.getLegacyPath(type, id);
  }

  private resolveWritePath(
    type: ModelType,
    definition: Definition,
  ): string {
    if (isFilenameSafeDefinitionName(definition.name)) {
      return this.getNamePath(type, definition.name);
    }
    return this.getLegacyPath(type, definition.id);
  }

  private getNamePath(type: ModelType, name: string): string {
    return join(this.getTypeDir(type), `${name}.yaml`);
  }

  private getLegacyPath(type: ModelType, id: DefinitionId): string {
    return join(this.getTypeDir(type), `${id}.yaml`);
  }

  private getTypeDir(type: ModelType): string {
    return join(this.baseDir, type.toDirectoryPath());
  }

  /**
   * Clears all evaluated definitions.
   * Used when needing to regenerate all evaluations.
   */
  async clearAll(): Promise<void> {
    return await withChangeSignalled(this.markDirty, {
      kind: "remove",
      path: this.baseDir,
    }, {
      typed: true,
    }, async () => {
      // On v3, each file's model is read before the removal destroys it, so
      // the directory removal stages one tombstone per file.
      const tombstones = typedStagingActive(this.markDirty)
        ? await this.tombstonesOfAll()
        : [];

      const definitionsDir = this.baseDir;
      try {
        await Deno.remove(definitionsDir, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
      this.idToActualPath.clear();
      await stageTyped(this.markDirty, () => tombstones);
    });
  }

  /**
   * A tombstone for every evaluated definition file under the base, in its
   * model's partition: from the raw `type` and `id` the file declares (the
   * id of a legacy uuid-named file as a fallback), never a schema parse. A
   * file that names no valid model stages nothing; no repository put it.
   */
  private async tombstonesOfAll(): Promise<TypedChange[]> {
    const tombstones: TypedChange[] = [];
    try {
      for await (
        const entry of walk(this.baseDir, {
          includeDirs: false,
          exts: [".yaml"],
        })
      ) {
        const prior = await readPriorFile(entry.path);
        const id = prior?.id ?? basename(entry.path, ".yaml");
        const change = unlessUnpartitionable(() =>
          prior?.type === undefined ? undefined : new ModelChanges(
            ModelType.create(prior.type),
            id,
          ).removeEvaluatedDefinition(this.keyOf(entry.path))
        );
        if (change !== undefined) tombstones.push(change);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return tombstones;
  }

  /** The record key of a file under the base. */
  private keyOf(path: string) {
    return keyUnder(SWAMP_SUBDIRS.definitionsEvaluated, this.baseDir, path);
  }
}
