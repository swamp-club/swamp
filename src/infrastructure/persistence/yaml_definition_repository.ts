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
import { getLogger } from "@logtape/logtape";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { assertSafePath } from "./safe_path.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  createDefinitionId,
  Definition,
  type DefinitionData,
  type DefinitionId,
} from "../../domain/definitions/definition.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import {
  createDefinitionCreated,
  createDefinitionDeleted,
  createDefinitionUpdated,
} from "../../domain/events/types.ts";

const logger = getLogger(["definition-repo"]);

/**
 * YAML-based implementation of DefinitionRepository.
 *
 * Stores definitions as YAML files in the directory structure:
 * {repoDir}/models/{normalized-type}/{id}.yaml
 *
 * CEL expressions in attributes are preserved as-is (not evaluated on save).
 */
export class YamlDefinitionRepository implements DefinitionRepository {
  private readonly baseDir: string;

  constructor(
    private readonly repoDir: string,
    private readonly eventBus?: EventBus,
    baseDir?: string,
  ) {
    this.baseDir = baseDir ?? join(repoDir, "models");
  }

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

  async findAll(type: ModelType): Promise<Definition[]> {
    const dir = this.getTypeDir(type);
    const definitions: Definition[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          (entry.isFile || entry.isSymlink) && entry.name.endsWith(".yaml")
        ) {
          const path = join(dir, entry.name);
          try {
            if (entry.isSymlink) {
              await assertSafePath(path, this.repoDir);
            }
            const content = await Deno.readTextFile(path);
            const data = parseYaml(content) as DefinitionData;
            definitions.push(Definition.fromData(data));
          } catch (parseError) {
            logger.warn`Skipping broken definition file ${path}: ${parseError}`;
          }
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
    const definitions = await this.findAll(type);
    return definitions.find((def) => def.name === name) ?? null;
  }

  async findByNameGlobal(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    return await this.searchDefinitionByName(this.baseDir, [], name);
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

        if (
          (entry.isFile || entry.isSymlink) && entry.name.endsWith(".yaml")
        ) {
          // Found a YAML file, check if it matches the name
          try {
            if (entry.isSymlink) {
              await assertSafePath(fullPath, this.repoDir);
            }
            const content = await Deno.readTextFile(fullPath);
            const data = parseYaml(content) as DefinitionData;
            const definition = Definition.fromData(data);

            if (definition.name === name) {
              // Prefer the type from the YAML, fall back to path-based type
              const typeStr = definition.type ?? pathSegments.join("/");
              return { definition, type: ModelType.create(typeStr) };
            }
          } catch (parseError) {
            logger
              .warn`Skipping broken definition file ${fullPath}: ${parseError}`;
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
   * Finds all definitions across all model types in the repository.
   */
  async findAllGlobal(): Promise<
    { definition: Definition; type: ModelType }[]
  > {
    const results: { definition: Definition; type: ModelType }[] = [];
    await this.collectAllDefinitions(this.baseDir, [], results);
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

        if (
          (entry.isFile || entry.isSymlink) && entry.name.endsWith(".yaml")
        ) {
          // Found a YAML file, add it to results
          try {
            if (entry.isSymlink) {
              await assertSafePath(fullPath, this.repoDir);
            }
            const content = await Deno.readTextFile(fullPath);
            const data = parseYaml(content) as DefinitionData;
            const definition = Definition.fromData(data);

            // Prefer the type from the YAML, fall back to path-based type
            const typeStr = definition.type ?? pathSegments.join("/");
            results.push({ definition, type: ModelType.create(typeStr) });
          } catch (parseError) {
            logger
              .warn`Skipping broken definition file ${fullPath}: ${parseError}`;
          }
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

  async save(type: ModelType, definition: Definition): Promise<void> {
    const dir = this.getTypeDir(type);
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const path = this.getPath(type, definition.id);

    // Check if this is a new definition or an update
    const isNew = !(await this.exists(path));

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

    // Emit event
    if (this.eventBus) {
      const event = isNew
        ? createDefinitionCreated(
          type.normalized,
          definition.id,
          definition.name,
        )
        : createDefinitionUpdated(
          type.normalized,
          definition.id,
          definition.name,
        );
      await this.eventBus.publish(event);
    }
  }

  /**
   * Checks if a file exists.
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  }

  async delete(type: ModelType, id: DefinitionId): Promise<void> {
    const path = this.getPath(type, id);

    // Get the definition name before deleting for the event
    let definitionName: string | undefined;
    if (this.eventBus) {
      const definition = await this.findById(type, id);
      definitionName = definition?.name;
    }

    try {
      await Deno.remove(path);

      // Clean up empty parent directories
      await cleanupEmptyParentDirs(path, this.baseDir);

      // Emit event if we had a name
      if (this.eventBus && definitionName) {
        const event = createDefinitionDeleted(
          type.normalized,
          id,
          definitionName,
        );
        await this.eventBus.publish(event);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  nextId(): DefinitionId {
    return createDefinitionId(crypto.randomUUID());
  }

  getPath(type: ModelType, id: DefinitionId): string {
    return join(this.getTypeDir(type), `${id}.yaml`);
  }

  private getTypeDir(type: ModelType): string {
    return join(this.baseDir, type.toDirectoryPath());
  }
}
