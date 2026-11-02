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
import { currentDiagnosticTally } from "../../domain/diagnostics/diagnostic_phase.ts";
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
   * absent in caches written before provenance was recorded; unreadable when
   * present but malformed, which replay refuses rather than trusting the
   * expressions it holds
   */
  provenance?: ProvenanceMap | "unreadable";
  persistedProvenance?: ProvenanceMap | "unreadable";
  authoredExpressions: ReadonlySet<string>;
  deferredExpressions: readonly DeferredExpression[];
  writtenReferences: readonly WrittenReference[];
  /**
   * where the file holds the mask in place of a sensitive argument not from a
   * vault; a replay refuses these whatever the type's schema marks at the time.
   * Empty in older caches.
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
  // evaluatedInputs and resolvedExpressions were written by unreleased builds
  // and are dropped on read: nothing reads them, and the definition schema
  // rejects unknown keys
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

export class YamlEvaluatedDefinitionRepository {
  private readonly baseDir: string;
  private readonly idToActualPath = new Map<DefinitionId, string>();

  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly markDirty?: MarkDirtyHook,
    readonly unreadableContent?: UnreadableContentLookup,
  ) {
    this.baseDir = baseDir ??
      swampPath(repoDir, SWAMP_SUBDIRS.definitionsEvaluated);
  }

  private async throwIfUnreadable(path: string): Promise<void> {
    const error = await this.unreadableContent?.(path);
    if (error !== undefined) throw error;
  }

  async findById(
    type: ModelType,
    id: DefinitionId,
  ): Promise<Definition | null> {
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

    const definitions = (await this.findAllWithProvenance(type)).map((c) =>
      c.definition
    );
    const found = definitions.find((d) => d.id === id);
    if (found) return found;
    await this.throwIfUnreadable(legacyPath);
    return null;
  }

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

  async findByName(type: ModelType, name: string): Promise<Definition | null> {
    return (await this.findByNameWithProvenance(type, name))?.definition ??
      null;
  }

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

  async findByNameGlobal(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    const definitionsDir = this.baseDir;
    const found = await this.searchDefinitionByName(definitionsDir, [], name);
    if (found) return found;
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

  private async searchDefinitionByName(
    currentDir: string,
    pathSegments: string[],
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    try {
      for await (const entry of Deno.readDir(currentDir)) {
        const fullPath = join(currentDir, entry.name);

        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const content = await Deno.readTextFile(fullPath);
          const cached = parseEvaluatedDefinitionCache(content);
          if (!cached) continue;
          const { definition } = cached;

          if (definition.name === name) {
            this.idToActualPath.set(definition.id as DefinitionId, fullPath);
            const typeStr = pathSegments.join("/");
            return { definition, type: ModelType.create(typeStr) };
          }
        } else if (entry.isDirectory) {
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

  async findAllGlobal(): Promise<
    { definition: Definition; type: ModelType }[]
  > {
    const definitionsDir = this.baseDir;
    const results: { definition: Definition; type: ModelType }[] = [];
    await this.collectAllDefinitions(definitionsDir, [], results);
    await warnUnreadableLeftOut(this.unreadableContent, definitionsDir);
    return results;
  }

  private async collectAllDefinitions(
    currentDir: string,
    pathSegments: string[],
    results: { definition: Definition; type: ModelType }[],
  ): Promise<void> {
    try {
      for await (const entry of Deno.readDir(currentDir)) {
        const fullPath = join(currentDir, entry.name);

        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const content = await Deno.readTextFile(fullPath);
          const cached = parseEvaluatedDefinitionCache(content);
          if (!cached) continue;
          const { definition } = cached;

          this.idToActualPath.set(definition.id as DefinitionId, fullPath);
          const typeStr = pathSegments.join("/");
          results.push({ definition, type: ModelType.create(typeStr) });
        } else if (entry.isDirectory) {
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
   * throws when a sensitive argument holds a literal other than the mask with
   * no written reference; a type no extension registers has nothing to check
   * against and is let through
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

  async save(
    type: ModelType,
    definition: Definition,
    /**
     * required so every writer states it; undefined writes the legacy format,
     * which replays with the raw-text rule alone
     */
    provenance: ProvenanceMap | undefined,
    authoredExpressions?: ReadonlySet<string>,
    deferredExpressions?: readonly DeferredExpression[],
    writtenReferences: readonly WrittenReference[] = [],
    maskedPaths: readonly MaskedPath[] = [],
    persistedProvenance?: ProvenanceMap,
  ): Promise<void> {
    // fail closed before anything is staged or written: a sensitive argument
    // reaches the cache only as a vault reference or the mask
    z.array(MaskedPathSchema).parse(maskedPaths);
    // persistEvaluatedDefinition builds that form, so a writer going through it
    // never trips this; one that bypasses it fails here instead of leaking
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
      data.type = type.normalized;
      // typeVersion is copied verbatim from the source definition; evaluated
      // definitions are replayed under --last-evaluated, so restamping would
      // mask staleness as in the source repository
      const cleanData = JSON.parse(JSON.stringify(data));
      const content = stringifyYaml(cleanData as Record<string, unknown>);
      await atomicWriteTextFile(targetPath, content);
      const removed: string[] = [];

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
      // on v3 the evaluated definition is derived, so its changes carry no
      // precondition
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

  async delete(type: ModelType, id: DefinitionId): Promise<void> {
    const tally = currentDiagnosticTally();
    const definition = await tally.measure(
      "lookup",
      () => this.findById(type, id),
    );

    const pathsToTry = new Set([this.getLegacyPath(type, id)]);
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath) pathsToTry.add(cachedPath);
    if (definition && isFilenameSafeDefinitionName(definition.name)) {
      pathsToTry.add(this.getNamePath(type, definition.name));
    }

    const resolvedPath = this.idToActualPath.get(id) ??
      this.getLegacyPath(type, id);
    return await tally.measure(
      "change_stage",
      () =>
        withChangeSignalled(this.markDirty, {
          kind: "remove",
          path: resolvedPath,
        }, {
          typed: true,
        }, async () => {
          const removed: string[] = [];
          await tally.measure("file_remove", async () => {
            for (const path of pathsToTry) {
              try {
                await Deno.remove(path);
                removed.push(path);

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
          });

          this.idToActualPath.delete(id);
          await stageTyped(this.markDirty, () => {
            const changes = new ModelChanges(type, id);
            return removed.map((path) =>
              changes.removeEvaluatedDefinition(this.keyOf(path))
            );
          });
        }),
    );
  }

  nextId(): DefinitionId {
    return createDefinitionId(crypto.randomUUID());
  }

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

  async clearAll(): Promise<void> {
    return await withChangeSignalled(this.markDirty, {
      kind: "remove",
      path: this.baseDir,
    }, {
      typed: true,
    }, async () => {
      // on v3 each file's model is read before the removal destroys it, so the
      // directory removal stages one tombstone per file
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
   * built from the raw type and id the file declares (a legacy uuid-named
   * file's id as fallback), never a schema parse; a file that names no valid
   * model stages nothing
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

  private keyOf(path: string) {
    return keyUnder(SWAMP_SUBDIRS.definitionsEvaluated, this.baseDir, path);
  }
}
