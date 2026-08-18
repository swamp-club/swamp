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
import { basename, join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import { isIoError } from "./io_errors.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { assertSafePath } from "./safe_path.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  createDefinitionId,
  Definition,
  type DefinitionData,
  type DefinitionId,
  isFilenameSafeDefinitionName,
} from "../../domain/definitions/definition.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  findLiteralSensitiveGlobalArgs,
  LITERAL_SENSITIVE_GLOBAL_ARG_CODE,
  literalSensitiveGlobalArgsMessage,
} from "../../domain/models/sensitive_field_extractor.ts";
import { UserError } from "../../domain/errors.ts";
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
 * {repoDir}/models/{normalized-type}/{name}.yaml   (new default for filename-safe names)
 * {repoDir}/models/{normalized-type}/{uuid}.yaml   (legacy, still discoverable)
 *
 * CEL expressions in attributes are preserved as-is (not evaluated on save).
 */
export class YamlDefinitionRepository implements DefinitionRepository {
  private readonly baseDir: string;
  private readonly secondaryBaseDir: string | undefined;
  private readonly idToActualPath = new Map<DefinitionId, string>();

  constructor(
    private readonly repoDir: string,
    private readonly eventBus?: EventBus,
    baseDir?: string,
    /** Pass `false` to disable secondary search. Omit to auto-compute from repoDir. */
    secondaryBaseDir?: string | false,
  ) {
    this.baseDir = baseDir ?? join(repoDir, "models");
    this.secondaryBaseDir = secondaryBaseDir === false
      ? undefined
      : (secondaryBaseDir ??
        swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions));
  }

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

    // Try name-based filename from cache
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

    // Slow path: scan all definition files for this type
    const definitions = await this.findAll(type);
    const found = definitions.find((d) => d.id === id);
    if (found) return found;

    // Fall back to secondary dir
    if (this.secondaryBaseDir) {
      return this.findByIdInDir(this.secondaryBaseDir, type, id);
    }
    return null;
  }

  private async findByIdInDir(
    dir: string,
    type: ModelType,
    id: DefinitionId,
  ): Promise<Definition | null> {
    // Fast path: try UUID-based filename
    const path = join(dir, type.toDirectoryPath(), `${id}.yaml`);
    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as DefinitionData;
      return Definition.fromData(data);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Slow path: scan all files in the type directory for a matching ID
    const typeDir = join(dir, type.toDirectoryPath());
    try {
      for await (const entry of Deno.readDir(typeDir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          try {
            const content = await Deno.readTextFile(join(typeDir, entry.name));
            const data = parseYaml(content) as DefinitionData;
            const definition = Definition.fromData(data);
            if (definition.id === id) {
              return definition;
            }
          } catch {
            // Skip broken files
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
            const definition = Definition.fromData(data);
            this.idToActualPath.set(
              definition.id as DefinitionId,
              path,
            );
            definitions.push(definition);
          } catch (error) {
            if (isIoError(error)) {
              throw new UserError(
                `Failed to read definition file ${path}: ${
                  error instanceof Error ? error.message : error
                }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
              );
            }
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn`Skipping broken definition file ${path}: ${msg}`;
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
    // Fast path: try name-based filename directly
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

    // Slow path: scan all definition files
    const definitions = await this.findAll(type);
    const found = definitions.find((def) => def.name === name);
    if (found) return found;
    if (this.secondaryBaseDir) {
      const secondaryDir = join(this.secondaryBaseDir, type.toDirectoryPath());
      const secondaryDefs = await this.findAllInDir(secondaryDir);
      return secondaryDefs.find((def) => def.name === name) ?? null;
    }
    return null;
  }

  private async findAllInDir(dir: string): Promise<Definition[]> {
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
          } catch (error) {
            if (isIoError(error)) {
              throw new UserError(
                `Failed to read definition file ${path}: ${
                  error instanceof Error ? error.message : error
                }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
              );
            }
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn`Skipping broken definition file ${path}: ${msg}`;
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

  async findByNameGlobal(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    const result = await this.searchDefinitionByName(this.baseDir, [], name);
    if (result) return result;
    if (this.secondaryBaseDir) {
      return await this.searchDefinitionByName(
        this.secondaryBaseDir,
        [],
        name,
      );
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
              this.idToActualPath.set(
                definition.id as DefinitionId,
                fullPath,
              );
              // Prefer the type from the YAML, fall back to path-based type
              const typeStr = definition.type ?? pathSegments.join("/");
              return { definition, type: ModelType.create(typeStr) };
            }
          } catch (error) {
            if (isIoError(error)) {
              throw new UserError(
                `Failed to read definition file ${fullPath}: ${
                  error instanceof Error ? error.message : error
                }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
              );
            }
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn`Skipping broken definition file ${fullPath}: ${msg}`;
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

            this.idToActualPath.set(
              definition.id as DefinitionId,
              fullPath,
            );
            // Prefer the type from the YAML, fall back to path-based type
            const typeStr = definition.type ?? pathSegments.join("/");
            results.push({ definition, type: ModelType.create(typeStr) });
          } catch (error) {
            if (isIoError(error)) {
              throw new UserError(
                `Failed to read definition file ${fullPath}: ${
                  error instanceof Error ? error.message : error
                }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
              );
            }
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn`Skipping broken definition file ${fullPath}: ${msg}`;
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

    const targetPath = this.resolveWritePath(type, definition);
    const previousPath = this.idToActualPath.get(definition.id);

    // Check if this is a new definition or an update
    const legacyPath = this.getLegacyPath(type, definition.id);
    const isNew = !(await this.exists(targetPath)) &&
      !(previousPath && await this.exists(previousPath)) &&
      !(await this.exists(legacyPath));

    const data = definition.toData();
    // Ensure type metadata is always present in persisted YAML
    data.type = type.normalized;
    await modelRegistry.ensureTypeLoaded(type);
    let modelDef = modelRegistry.get(type);
    // ensureTypeLoaded only imports types already registered as lazy. A command
    // that never populated the registry (e.g. `model edit`, which resolves the
    // type only from the YAML on disk) leaves an extension type unresolved here,
    // which would silently bypass the sensitive-arg guard below. Fall back to a
    // full extension load so the schema is available. ensureLoaded is memoized,
    // so commands that already loaded the registry (create/run/serve) pay
    // nothing, and this only does real work the first time an unloaded type is
    // written.
    if (!modelDef) {
      await modelRegistry.ensureLoaded();
      await modelRegistry.ensureTypeLoaded(type);
      modelDef = modelRegistry.get(type);
    }
    data.typeVersion = modelDef?.version ?? data.typeVersion;

    // Fail closed before writing: a global argument marked `{ sensitive: true }`
    // must never be persisted as a literal value — it would sit in cleartext in
    // the definition YAML, readable by anyone with repo/filesystem access. This
    // is the single chokepoint every source-definition writer funnels through
    // (model create/edit/run/workflow auto-definitions and the serve API), so
    // enforcing it here covers them all. Literal values must instead be supplied
    // as a `vault.get(...)` expression, which is resolved at runtime and stored
    // unevaluated. Throwing before the write leaves no partial file behind.
    const leakedArgs = findLiteralSensitiveGlobalArgs(
      modelDef?.globalArguments,
      data.globalArguments,
    );
    if (leakedArgs.length > 0) {
      throw new UserError(
        literalSensitiveGlobalArgsMessage(leakedArgs),
        LITERAL_SENSITIVE_GLOBAL_ARG_CODE,
      );
    }

    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(targetPath, content);

    // Clean up old file if we wrote to a different path
    if (previousPath && previousPath !== targetPath) {
      try {
        await Deno.remove(previousPath);
        logger.debug`Migrated definition file from ${
          basename(previousPath)
        } to ${basename(targetPath)}`;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          logger.warn`Failed to remove old definition file ${previousPath}: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }

    // Also check the legacy UUID path if it wasn't the previousPath
    if (
      targetPath !== legacyPath && previousPath !== legacyPath &&
      await this.exists(legacyPath)
    ) {
      try {
        await Deno.remove(legacyPath);
        logger.debug`Migrated definition file from ${basename(legacyPath)} to ${
          basename(targetPath)
        }`;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          logger.warn`Failed to remove legacy definition file ${legacyPath}: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }

    this.idToActualPath.set(definition.id, targetPath);

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
    // Populate cache so we discover name-based files on a cold instance
    const definition = await this.findById(type, id);
    const definitionName = definition?.name;

    // Try removing all possible file paths
    const pathsToTry = new Set([this.getLegacyPath(type, id)]);
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath) pathsToTry.add(cachedPath);
    if (definitionName && isFilenameSafeDefinitionName(definitionName)) {
      pathsToTry.add(this.getNamePath(type, definitionName));
    }

    let deleted = false;
    for (const path of pathsToTry) {
      try {
        await Deno.remove(path);
        deleted = true;

        // Clean up empty parent directories
        await cleanupEmptyParentDirs(path, this.baseDir);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    if (deleted) {
      this.idToActualPath.delete(id);

      if (this.eventBus && definitionName) {
        const event = createDefinitionDeleted(
          type.normalized,
          id,
          definitionName,
        );
        await this.eventBus.publish(event);
      }
    }
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
}
