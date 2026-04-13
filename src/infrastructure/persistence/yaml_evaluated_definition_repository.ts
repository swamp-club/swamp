// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
} from "../../domain/definitions/definition.ts";
import { modelRegistry } from "../../domain/models/model.ts";

/**
 * YAML-based repository for evaluated definitions.
 *
 * Stores definitions with CEL expressions already evaluated in the directory structure:
 * {repoDir}/.swamp/definitions-evaluated/{normalized-type}/{id}.yaml
 *
 * This directory is gitignored as evaluated definitions are derived data
 * that can be regenerated from the source definitions.
 */
export class YamlEvaluatedDefinitionRepository {
  private readonly baseDir: string;

  constructor(
    private readonly repoDir: string,
    baseDir?: string,
  ) {
    this.baseDir = baseDir ??
      swampPath(repoDir, SWAMP_SUBDIRS.definitionsEvaluated);
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
    const path = this.getPath(type, id);
    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as DefinitionData;
      return Definition.fromData(data);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
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
          definitions.push(Definition.fromData(data));
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
    const dir = this.getTypeDir(type);
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const path = this.getPath(type, definition.id);

    const data = definition.toData();
    // Ensure type metadata is always present in persisted YAML
    data.type = type.normalized;
    await modelRegistry.ensureTypeLoaded(type);
    const modelDef = modelRegistry.get(type);
    data.typeVersion = modelDef?.version ?? data.typeVersion;
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(path, content);
  }

  /**
   * Deletes an evaluated definition.
   *
   * @param type - The model type
   * @param id - The definition ID
   */
  async delete(type: ModelType, id: DefinitionId): Promise<void> {
    const path = this.getPath(type, id);

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
    const definitionsDir = this.baseDir;
    try {
      await Deno.remove(definitionsDir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}
