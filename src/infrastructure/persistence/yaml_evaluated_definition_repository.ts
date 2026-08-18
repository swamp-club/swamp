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

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { ModelType } from "../../domain/models/model_type.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { assertSafePath } from "./safe_path.ts";
import {
  createDefinitionId,
  Definition,
  type DefinitionData,
  type DefinitionId,
  isFilenameSafeDefinitionName,
} from "../../domain/definitions/definition.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import { modelRegistry } from "../../domain/models/model.ts";

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
  ) {
    this.baseDir = baseDir ??
      swampPath(repoDir, SWAMP_SUBDIRS.definitionsEvaluated);
  }

  private async notifyDirty(relPath?: string): Promise<void> {
    if (this.markDirty) await this.markDirty(relPath);
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
      const data = parseYaml(content) as DefinitionData;
      const definition = Definition.fromData(data);
      this.idToActualPath.set(id, legacyPath);
      return definition;
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
        const data = parseYaml(content) as DefinitionData;
        return Definition.fromData(data);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    // Slow path: scan all files
    const definitions = await this.findAll(type);
    return definitions.find((d) => d.id === id) ?? null;
  }

  /**
   * Finds all evaluated definitions of a given type.
   *
   * @param type - The model type
   * @returns Array of evaluated definitions
   */
  async findAll(type: ModelType): Promise<Definition[]> {
    const dir = this.getTypeDir(type);
    const definitions: Definition[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as DefinitionData;
          const definition = Definition.fromData(data);
          this.idToActualPath.set(definition.id as DefinitionId, path);
          definitions.push(definition);
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
    if (isFilenameSafeDefinitionName(name)) {
      const namePath = this.getNamePath(type, name);
      try {
        const content = await Deno.readTextFile(namePath);
        const data = parseYaml(content) as DefinitionData;
        const definition = Definition.fromData(data);
        if (definition.name !== name) {
          // File content doesn't match filename — fall through to slow path
        } else {
          this.idToActualPath.set(definition.id as DefinitionId, namePath);
          return definition;
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    const definitions = await this.findAll(type);
    return definitions.find((def) => def.name === name) ?? null;
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
    return await this.searchDefinitionByName(definitionsDir, [], name);
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
          const data = parseYaml(content) as DefinitionData;
          const definition = Definition.fromData(data);

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
          const data = parseYaml(content) as DefinitionData;
          const definition = Definition.fromData(data);

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
   * Saves an evaluated definition.
   *
   * @param type - The model type
   * @param definition - The evaluated definition to save
   */
  async save(type: ModelType, definition: Definition): Promise<void> {
    const targetPath = this.resolveWritePath(type, definition);
    await this.notifyDirty(targetPath);

    const dir = this.getTypeDir(type);
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const data = definition.toData();
    // Ensure type metadata is always present in persisted YAML
    data.type = type.normalized;
    await modelRegistry.ensureTypeLoaded(type);
    const modelDef = modelRegistry.get(type);
    data.typeVersion = modelDef?.version ?? data.typeVersion;
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(targetPath, content);

    // Clean up old file if it's at a different path
    const previousPath = this.idToActualPath.get(definition.id);
    if (previousPath && previousPath !== targetPath) {
      try {
        await Deno.remove(previousPath);
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
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    this.idToActualPath.set(definition.id, targetPath);
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
    await this.notifyDirty(resolvedPath);

    for (const path of pathsToTry) {
      try {
        await Deno.remove(path);

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
    await this.notifyDirty();

    const definitionsDir = this.baseDir;
    try {
      await Deno.remove(definitionsDir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    this.idToActualPath.clear();
  }
}
