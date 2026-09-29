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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  SEPARATOR,
} from "@std/path";
import { getLogger } from "@logtape/logtape";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import { isIoError } from "./io_errors.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import {
  type Document as YamlDocument,
  isMap,
  isSeq,
  parseDocument,
  type YAMLMap,
} from "yaml";
import { assertSafePath } from "./safe_path.ts";
import {
  resolveEffectiveDefinitionsDir,
  SWAMP_SUBDIRS,
  swampPath,
} from "./paths.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
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
  /**
   * Id → the file a definition was last read from or written to. Holds paths
   * in the secondary auto-definitions directory too, so getPath, save and
   * delete act on the real file whichever lookup found it.
   */
  private readonly idToActualPath = new Map<DefinitionId, string>();
  /**
   * Name → file path hints, so a repeated lookup for a definition whose file is
   * not at its name-derived path (a legacy `{uuid}.yaml`, or a name that is not
   * filename-safe) skips re-walking and re-parsing the repository every time.
   *
   * These store a PATH ONLY — never a parsed definition, never a negative
   * result. The file is re-read and its declared name re-checked on every hit,
   * so a stale hint is self-correcting and external edits, renames, additions
   * and deletions stay visible. That is why `save()` and `delete()` need no
   * invalidation bookkeeping.
   *
   * A hint also records whether its file lives in the primary definitions
   * directory or the secondary auto-definitions one, and is only consulted in
   * the stage of the search that owns that directory. Primary definitions must
   * keep winning over same-named secondary ones, so a secondary hint can never
   * short-circuit the primary walk that would find a newly added primary file.
   *
   * If a cache-reset hook is ever added to this class, it must clear these
   * alongside `idToActualPath`.
   */
  private readonly nameToActualPath = new Map<
    string,
    { path: string; primary: boolean }
  >();
  private readonly globalNameToActualPath = new Map<
    string,
    { path: string; pathSegments: string[]; primary: boolean }
  >();

  constructor(
    private readonly repoDir: string,
    private readonly eventBus?: EventBus,
    baseDir?: string,
    /** Pass `false` to disable secondary search. Omit to auto-compute from repoDir. */
    secondaryBaseDir?: string | false,
    private readonly markDirtyHook?: MarkDirtyHook,
  ) {
    this.baseDir = baseDir ?? resolveEffectiveDefinitionsDir(repoDir);
    this.secondaryBaseDir = secondaryBaseDir === false
      ? undefined
      : (secondaryBaseDir ??
        swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions));
  }

  private async notifyDirty(relPath?: string): Promise<void> {
    if (this.markDirtyHook) await this.markDirtyHook(relPath);
  }

  async findById(
    type: ModelType,
    id: DefinitionId,
  ): Promise<Definition | null> {
    // Fast path: try UUID-based filename (legacy). The file must declare this
    // id: a definition *named* with this UUID lives at the same path.
    const legacyPath = this.getLegacyPath(type, id);
    try {
      const content = await Deno.readTextFile(legacyPath);
      const data = parseYaml(content) as DefinitionData | null;
      if (data) {
        const definition = Definition.fromData(data);
        if (definition.id === id) {
          this.idToActualPath.set(id, legacyPath);
          return definition;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Try name-based filename from cache. The cache is keyed by id alone, so
    // only trust a path in this type's directory: otherwise a definition
    // loaded once is returned for every type it is asked about, and a lookup
    // by id across types reports the wrong type.
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath && cachedPath !== legacyPath) {
      const cached = await this.readDeclared(cachedPath);
      if (cached?.id === id) {
        // It is this type's when it sits in this type's directory or declares
        // this type, as a lookup by name reports it. Otherwise it belongs to
        // another type, and ids are unique, so answer without scanning every
        // file of this type.
        return this.isOfType(cachedPath, cached, type) ? cached : null;
      }
    }

    // Slow path: scan all definition files for this type
    const definitions = await this.findAll(type);
    const found = definitions.find((d) => d.id === id);
    if (found) return found;

    // Fall back to secondary dir. Record where the match lives so getPath,
    // delete and save act on the auto-definition file, as
    // searchDefinitionByName already does for findByNameGlobal.
    if (this.secondaryBaseDir) {
      const located = await this.locateByIdInDir(
        this.secondaryBaseDir,
        type,
        id,
      );
      if (!located) return null;
      this.idToActualPath.set(id, located.path);
      return located.definition;
    }
    return null;
  }

  private async locateByIdInDir(
    dir: string,
    type: ModelType,
    id: DefinitionId,
  ): Promise<{ definition: Definition; path: string } | null> {
    // Fast path: try UUID-based filename, which must declare this id
    const path = join(dir, type.toDirectoryPath(), `${id}.yaml`);
    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as DefinitionData | null;
      if (data) {
        const definition = Definition.fromData(data);
        if (definition.id === id) return { definition, path };
      }
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
          const entryPath = join(typeDir, entry.name);
          try {
            const content = await Deno.readTextFile(entryPath);
            const data = parseYaml(content) as DefinitionData | null;
            if (!data) continue;
            const definition = Definition.fromData(data);
            if (definition.id === id) {
              return { definition, path: entryPath };
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
            const data = parseYaml(content) as DefinitionData | null;
            if (!data) continue;
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
        const data = parseYaml(content) as DefinitionData | null;
        if (data) {
          const definition = Definition.fromData(data);
          if (definition.name !== name) {
            // File content doesn't match filename — fall through to slow path
          } else {
            this.idToActualPath.set(definition.id as DefinitionId, namePath);
            return definition;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    // Hinted path: deliberately OUTSIDE the isFilenameSafeDefinitionName guard
    // above. The definitions that reach the slow path are exactly the ones that
    // guard rejects, or whose name-derived file does not exist, so a hint check
    // nested inside it would never fire for the cases that need it.
    const hintKey = nameHintKey(type, name);
    const hint = this.nameToActualPath.get(hintKey);
    if (hint?.primary) {
      const hinted = await this.readDefinitionIfNamed(hint.path, name);
      if (hinted) return hinted;
      this.nameToActualPath.delete(hintKey);
    }

    // Slow path: scan all definition files
    const definitions = await this.findAll(type);
    const found = definitions.find((def) => def.name === name);
    if (found) {
      // findAll records every file it parsed, so the path is already known.
      const foundPath = this.idToActualPath.get(found.id as DefinitionId);
      if (foundPath) {
        this.nameToActualPath.set(hintKey, { path: foundPath, primary: true });
      }
      return found;
    }
    if (this.secondaryBaseDir) {
      // Only now, with the primary directory exhausted, may a secondary hint
      // answer: the primary definition of the same name always wins.
      if (hint && !hint.primary) {
        const hinted = await this.readDefinitionIfNamed(hint.path, name);
        if (hinted) {
          this.idToActualPath.set(hinted.id as DefinitionId, hint.path);
          return hinted;
        }
        this.nameToActualPath.delete(hintKey);
      }
      const secondaryDir = join(this.secondaryBaseDir, type.toDirectoryPath());
      const secondaryDefs = await this.findAllInDir(secondaryDir);
      const secondaryMatch = secondaryDefs.find((d) =>
        d.definition.name === name
      );
      if (secondaryMatch) {
        this.idToActualPath.set(
          secondaryMatch.definition.id as DefinitionId,
          secondaryMatch.path,
        );
        this.nameToActualPath.set(hintKey, {
          path: secondaryMatch.path,
          primary: false,
        });
        return secondaryMatch.definition;
      }
    }
    return null;
  }

  /**
   * Reads a hinted file and returns its definition only if the file still
   * declares the expected name.
   *
   * Returns null on any failure — missing, unreadable, unparseable or renamed —
   * so the caller falls back to its normal discovery walk and the outcome is
   * exactly what it would have been without a hint. In particular a corrupt
   * file must not throw from here, because discovery warns and skips it.
   *
   * A hinted path is re-checked for symlink escape before it is read. Discovery
   * validates every symlink it follows, so without this a file replaced by an
   * escaping symlink after discovery would be read unchecked. Falling back to
   * discovery on failure means the same containment error still surfaces, it
   * just comes from the walk instead of from here.
   */
  private async readDefinitionIfNamed(
    path: string,
    name: string,
  ): Promise<Definition | null> {
    try {
      if ((await Deno.lstat(path)).isSymlink) {
        await assertSafePath(path, this.repoDir);
      }
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as DefinitionData | null;
      if (!data) return null;
      const definition = Definition.fromData(data);
      return definition.name === name ? definition : null;
    } catch {
      return null;
    }
  }

  private async findAllInDir(
    dir: string,
  ): Promise<{ definition: Definition; path: string }[]> {
    const definitions: { definition: Definition; path: string }[] = [];
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
            const data = parseYaml(content) as DefinitionData | null;
            if (!data) continue;
            definitions.push({ definition: Definition.fromData(data), path });
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
    // This method has no name-derived fast path at all — without a hint every
    // call re-walks and re-parses every definition in the repository until it
    // hits a match.
    const hint = this.globalNameToActualPath.get(name);
    if (hint?.primary) {
      const hinted = await this.readHintedWithType(hint, name);
      if (hinted) return hinted;
      this.globalNameToActualPath.delete(name);
    }

    const result = await this.searchDefinitionByName(
      this.baseDir,
      [],
      name,
      true,
    );
    if (result) return result;
    if (this.secondaryBaseDir) {
      // Checked only after the primary walk comes up empty, so a secondary hint
      // cannot shadow a primary definition added since the hint was recorded.
      if (hint && !hint.primary) {
        const hinted = await this.readHintedWithType(hint, name);
        if (hinted) return hinted;
        this.globalNameToActualPath.delete(name);
      }
      return await this.searchDefinitionByName(
        this.secondaryBaseDir,
        [],
        name,
        false,
      );
    }
    return null;
  }

  async isAutoDefinition(
    definition: Definition,
    type: ModelType,
  ): Promise<boolean> {
    if (!this.secondaryBaseDir) return false;
    // The name lookup is usually answered from the hint the lookup that
    // loaded the definition recorded; only an auto-definition walks models/.
    const byName = await this.findByNamePrimary(definition.name);
    if (byName?.definition.id === definition.id) return false;
    if (byName === null) return true;
    // A definition of this name in models/ with another ID: confirm by ID
    // rather than trust the name.
    return !(await this.findAll(type)).some((d) => d.id === definition.id);
  }

  /**
   * Finds a definition by name in the primary definitions directory
   * (`models/`) only, never in the secondary one.
   */
  private async findByNamePrimary(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    const hint = this.globalNameToActualPath.get(name);
    if (hint?.primary) {
      const hinted = await this.readHintedWithType(hint, name);
      if (hinted) return hinted;
      this.globalNameToActualPath.delete(name);
    }
    return await this.searchDefinitionByName(this.baseDir, [], name, true);
  }

  /**
   * Reads a hinted file and resolves its model type, or returns null.
   *
   * The type conversion is guarded because discovery warns and skips a file
   * whose declared type is not a valid model type. Without the guard a hint
   * recorded for such a file — or a file edited to an invalid type after the
   * hint was recorded — would throw here instead of falling back to the walk
   * that skips it.
   */
  private async readHintedWithType(
    hint: { path: string; pathSegments: string[] },
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    const definition = await this.readDefinitionIfNamed(hint.path, name);
    if (!definition) return null;
    try {
      return {
        definition,
        type: ModelType.create(
          definition.type ?? hint.pathSegments.join("/"),
        ),
      };
    } catch {
      return null;
    }
  }

  /**
   * Recursively searches for a definition file by name in nested directory structures.
   */
  private async searchDefinitionByName(
    currentDir: string,
    pathSegments: string[],
    name: string,
    primary: boolean,
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
            const data = parseYaml(content) as DefinitionData | null;
            if (!data) continue;
            const definition = Definition.fromData(data);

            if (definition.name === name) {
              // Prefer the type from the YAML, fall back to path-based type.
              // Resolved before anything is recorded: an invalid type throws
              // into the catch below, which warns and skips the file, and a
              // skipped file must not leave a hint behind.
              const typeStr = definition.type ?? pathSegments.join("/");
              const modelType = ModelType.create(typeStr);
              this.idToActualPath.set(
                definition.id as DefinitionId,
                fullPath,
              );
              this.globalNameToActualPath.set(name, {
                path: fullPath,
                pathSegments: [...pathSegments],
                primary,
              });
              return { definition, type: modelType };
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
            primary,
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

  async findByIdGlobal(
    id: DefinitionId,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    // Primary definitions first, as findByNameGlobal searches them first.
    for (const dir of [this.baseDir, this.secondaryBaseDir]) {
      if (!dir) continue;
      const results: { definition: Definition; type: ModelType }[] = [];
      await this.collectAllDefinitions(dir, [], results);
      const found = results.find((entry) => entry.definition.id === id);
      if (found) return found;
    }
    return null;
  }

  async findAllByIdGlobal(
    id: DefinitionId,
  ): Promise<{ definition: Definition; type: ModelType }[]> {
    const found: { definition: Definition; type: ModelType }[] = [];
    for (const dir of [this.baseDir, this.secondaryBaseDir]) {
      if (!dir) continue;
      const results: { definition: Definition; type: ModelType }[] = [];
      // Without recording paths: every definition declaring the id is read,
      // and the last one read must not become where findById looks next —
      // that would let an auto-definition shadow a primary one.
      await this.collectAllDefinitions(dir, [], results, false);
      for (const entry of results) {
        if (entry.definition.id === id) found.push(entry);
      }
    }
    return found;
  }

  /**
   * Recursively collects all definition files from nested directory structures.
   * With `recordPaths`, remembers where each id was found for findById.
   */
  private async collectAllDefinitions(
    currentDir: string,
    pathSegments: string[],
    results: { definition: Definition; type: ModelType }[],
    recordPaths = true,
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
            const data = parseYaml(content) as DefinitionData | null;
            if (!data) continue;
            const definition = Definition.fromData(data);

            if (recordPaths) {
              this.idToActualPath.set(
                definition.id as DefinitionId,
                fullPath,
              );
            }
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
            recordPaths,
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
    const writeBaseDir = await this.resolveSaveBaseDir(type, definition);
    const dir = this.getTypeDir(type, writeBaseDir);
    await assertSafePath(dir, writeBaseDir);
    await ensureDir(dir);

    const targetPath = this.resolveWritePath(type, definition, writeBaseDir);
    await this.notifyDirty(targetPath);
    const previousPath = this.idToActualPath.get(definition.id);

    // Check if this is a new definition or an update
    const legacyPath = this.getLegacyPath(type, definition.id, writeBaseDir);
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
    // typeVersion is deliberately NOT stamped here. It records the model type
    // version a definition's globalArguments were authored or migrated for, so
    // only creation and DefinitionUpgradeService may set it. Stamping it on
    // every save marked a stale instance as current without migrating its
    // arguments, which stranded it permanently: DefinitionUpgradeService
    // short-circuits once typeVersion is at or above the model version, so no
    // upgrade chain shipped later could ever run (swamp-club#900). An absent
    // typeVersion is likewise left absent rather than backfilled: backfilling
    // would claim the arguments were authored for a version nobody verified
    // them against (swamp-club#2412).

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
    const cleanData = JSON.parse(JSON.stringify(data)) as Record<
      string,
      unknown
    >;

    // When the file already exists at the target path, check whether the
    // definition data has actually changed. If it hasn't, skip the write
    // entirely to avoid destroying YAML comments and producing git noise.
    // When the data HAS changed, use npm:yaml's Document API to merge the
    // new values onto the existing AST so that comments on unchanged nodes
    // are preserved.
    if (!isNew && await this.exists(targetPath)) {
      try {
        const existingRaw = await Deno.readTextFile(targetPath);
        const existingParsed = parseYaml(existingRaw) as
          | Record<
            string,
            unknown
          >
          | null;
        if (!existingParsed) {
          // Corrupt/empty file — remove it so the fresh-write path below
          // overwrites with valid content.
          try {
            await Deno.remove(targetPath);
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
        const normalizedExisting = existingParsed
          ? JSON.parse(
            JSON.stringify(existingParsed),
          ) as Record<string, unknown>
          : null;

        if (
          normalizedExisting &&
          canonicalJson(cleanData) === canonicalJson(normalizedExisting)
        ) {
          this.idToActualPath.set(definition.id, targetPath);
          logger.debug`Definition ${definition.name} unchanged, skipping write`;
          return;
        }

        // Data changed — merge onto existing document to preserve comments
        if (normalizedExisting) {
          const doc = parseDocument(existingRaw, { version: "1.1" });
          mergeIntoDocument(doc, cleanData);
          await atomicWriteTextFile(targetPath, doc.toString());
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          // File disappeared between exists() and read — fall through to
          // fresh write below.
        } else {
          throw error;
        }
      }

      if (await this.exists(targetPath)) {
        await this.cleanupOldPaths(
          targetPath,
          previousPath,
          legacyPath,
        );
        this.idToActualPath.set(definition.id, targetPath);
        if (this.eventBus) {
          await this.eventBus.publish(
            createDefinitionUpdated(
              type.normalized,
              definition.id,
              definition.name,
            ),
          );
        }
        return;
      }
    }

    const content = stringifyYaml(cleanData);
    await atomicWriteTextFile(targetPath, content);

    await this.cleanupOldPaths(targetPath, previousPath, legacyPath);

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

  /**
   * Deletes the definition with this id, from the definitions directory or
   * the auto-definitions directory. Ids are not guaranteed unique — a copied
   * file keeps its id — so with `name` only a file declaring both is removed,
   * never another definition that shares the id.
   */
  async delete(
    type: ModelType,
    id: DefinitionId,
    name?: string,
  ): Promise<void> {
    // Populate cache so we discover name-based and secondary files on a cold
    // instance
    const definition = await this.findById(type, id);
    let definitionName = name ?? definition?.name;

    // Try removing all possible file paths; declaresOther below skips any
    // that holds a different definition.
    const pathsToTry = new Set([this.getLegacyPath(type, id)]);
    // Never delete a same-id file that belongs to another type.
    const hintedPath = this.idToActualPath.get(id);
    const hinted = hintedPath ? await this.readDeclared(hintedPath) : null;
    const cachedPath = hintedPath &&
        (hinted?.id === id
          ? this.isOfType(hintedPath, hinted, type)
          : this.isPathOfType(hintedPath, type))
      ? hintedPath
      : undefined;
    if (cachedPath) pathsToTry.add(cachedPath);
    if (definitionName && isFilenameSafeDefinitionName(definitionName)) {
      pathsToTry.add(this.getNamePath(type, definitionName));
    }
    // The definition may also (or only) live in the auto-definitions dir.
    if (this.secondaryBaseDir) {
      const located = await this.locateByIdInDir(
        this.secondaryBaseDir,
        type,
        id,
      );
      if (located) {
        pathsToTry.add(located.path);
        definitionName ??= located.definition.name;
      }
    }

    const resolvedPath = cachedPath ?? this.getLegacyPath(type, id);
    await this.notifyDirty(resolvedPath);

    let deleted = false;
    for (const path of pathsToTry) {
      // The id-named path is also where a definition named with this UUID
      // lives, and a copied file can share the id; never remove another
      // definition's file.
      if (await this.declaresOther(path, id, name)) continue;
      try {
        if (path !== resolvedPath && await this.exists(path)) {
          await this.notifyDirty(path);
        }
        await Deno.remove(path);
        deleted = true;

        // Clean up empty parent directories
        await cleanupEmptyParentDirs(path, this.ownerBaseDir(path));
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
    } else {
      logger.debug`No definition file found to delete for ${id}`;
    }
  }

  /**
   * Returns the definition with this id from the file the repository last
   * saw it in, without scanning, when that file still declares the id. The
   * type is the one the file declares, else the directory it is in, as a
   * lookup by name reports it. Null when there is no such hint.
   */
  async findByIdCached(
    id: DefinitionId,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    const path = this.idToActualPath.get(id);
    if (!path) return null;
    const definition = await this.readDeclared(path);
    if (definition?.id !== id) return null;
    try {
      const typeStr = definition.type ?? this.typeDirOf(path);
      return typeStr ? { definition, type: ModelType.create(typeStr) } : null;
    } catch {
      return null;
    }
  }

  /** The type path of the definitions directory `path` sits in, if any. */
  private typeDirOf(path: string): string | undefined {
    for (const base of [this.baseDir, this.secondaryBaseDir]) {
      if (!base) continue;
      const rel = relative(base, dirname(path));
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        return rel.split(SEPARATOR).join("/");
      }
    }
    return undefined;
  }

  /** Whether `path` holds a readable definition declaring `id`. */
  private async declaresId(path: string, id: DefinitionId): Promise<boolean> {
    return (await this.readDeclared(path))?.id === id;
  }

  /** Parses the definition in `path`, or null if it is missing or invalid. */
  private async readDeclared(path: string): Promise<Definition | null> {
    try {
      const data = parseYaml(await Deno.readTextFile(path)) as
        | DefinitionData
        | null;
      return data ? Definition.fromData(data) : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether `path` holds a readable definition that declares an id not `id`,
   * or — when `name` is given — a name not `name`.
   */
  private async declaresOther(
    path: string,
    id: DefinitionId,
    name?: string,
  ): Promise<boolean> {
    try {
      const data = parseYaml(await Deno.readTextFile(path)) as
        | { id?: unknown; name?: unknown }
        | null;
      if (typeof data?.id === "string" && data.id !== id) return true;
      return name !== undefined && typeof data?.name === "string" &&
        data.name !== name;
    } catch {
      return false;
    }
  }

  nextId(): DefinitionId {
    return createDefinitionId(crypto.randomUUID());
  }

  getPath(type: ModelType, id: DefinitionId): string {
    return this.idToActualPath.get(id) ?? this.getLegacyPath(type, id);
  }

  private async cleanupOldPaths(
    targetPath: string,
    previousPath: string | undefined,
    legacyPath: string,
  ): Promise<void> {
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
  }

  private resolveWritePath(
    type: ModelType,
    definition: Definition,
    base: string = this.baseDir,
  ): string {
    if (isFilenameSafeDefinitionName(definition.name)) {
      return this.getNamePath(type, definition.name, base);
    }
    return this.getLegacyPath(type, definition.id, base);
  }

  private getNamePath(
    type: ModelType,
    name: string,
    base: string = this.baseDir,
  ): string {
    return join(this.getTypeDir(type, base), `${name}.yaml`);
  }

  private getLegacyPath(
    type: ModelType,
    id: DefinitionId,
    base: string = this.baseDir,
  ): string {
    return join(this.getTypeDir(type, base), `${id}.yaml`);
  }

  private getTypeDir(type: ModelType, base: string = this.baseDir): string {
    return join(base, type.toDirectoryPath());
  }

  /**
   * Picks the directory an existing definition is saved back into.
   *
   * A definition that lives only in the secondary auto-definitions directory
   * stays there. Otherwise a save through this repository would write it to the
   * primary directory, then remove the auto-definition as its previous path (or
   * leave it behind as a stale copy when no lookup cached that path).
   *
   * Only the cached path and the two filenames save() writes are checked, so
   * this never scans a directory.
   */
  private async resolveSaveBaseDir(
    type: ModelType,
    definition: Definition,
  ): Promise<string> {
    if (!this.secondaryBaseDir) return this.baseDir;
    const id = definition.id;
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath && isWithinDir(cachedPath, this.baseDir)) {
      return this.baseDir;
    }
    if (
      await this.exists(this.getLegacyPath(type, id)) ||
      await this.declaresId(this.getNamePath(type, definition.name), id)
    ) {
      return this.baseDir;
    }
    const secondary = this.secondaryBaseDir;
    if (
      (cachedPath && isWithinDir(cachedPath, secondary) &&
        await this.declaresId(cachedPath, id)) ||
      await this.exists(this.getLegacyPath(type, id, secondary)) ||
      await this.declaresId(
        this.getNamePath(type, definition.name, secondary),
        id,
      )
    ) {
      return secondary;
    }
    return this.baseDir;
  }

  /** The directory owning a definition file: primary, or secondary. */
  private ownerBaseDir(path: string): string {
    return this.secondaryBaseDir && isWithinDir(path, this.secondaryBaseDir)
      ? this.secondaryBaseDir
      : this.baseDir;
  }

  /**
   * Whether `definition`, read from `path`, is of `type`: in `type`'s
   * directory, or declaring `type` wherever it is filed.
   */
  private isOfType(
    path: string,
    definition: Definition,
    type: ModelType,
  ): boolean {
    if (definition.type) {
      try {
        return ModelType.create(definition.type).normalized === type.normalized;
      } catch {
        return false;
      }
    }
    return this.isPathOfType(path, type);
  }

  /** Whether `path` is a definition file directly in `type`'s directory. */
  private isPathOfType(path: string, type: ModelType): boolean {
    const dir = dirname(path);
    if (dir === this.getTypeDir(type)) return true;
    return this.secondaryBaseDir !== undefined &&
      dir === join(this.secondaryBaseDir, type.toDirectoryPath());
  }
}

/**
 * Key for the per-type name hint map.
 *
 * JSON-encodes the two parts rather than joining them with a separator
 * character: it is unambiguous for any input without relying on assumptions
 * about which characters a type or definition name can contain, and it keeps
 * the source plain ASCII.
 */
function nameHintKey(type: ModelType, name: string): string {
  return JSON.stringify([type.toDirectoryPath(), name]);
}

/** True when `path` is inside `dir` (or is `dir`). */
function isWithinDir(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${SEPARATOR}`) && !isAbsolute(rel));
}

function canonicalJson(data: Record<string, unknown>): string {
  return JSON.stringify(data, (_key, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

function mergeIntoDocument(
  doc: YamlDocument,
  newData: Record<string, unknown>,
): void {
  const root = doc.contents;
  if (!isMap(root)) {
    doc.contents = doc.createNode(newData);
    return;
  }
  mergeMap(doc, root, newData);

  // Remove keys from the document that are no longer in the new data
  for (let i = root.items.length - 1; i >= 0; i--) {
    const key = String(root.items[i].key);
    if (!(key in newData)) {
      root.items.splice(i, 1);
    }
  }
}

function mergeMap(
  doc: YamlDocument,
  map: YAMLMap,
  data: Record<string, unknown>,
): void {
  for (const [key, newValue] of Object.entries(data)) {
    const existing = map.get(key, true);

    if (
      existing !== undefined && isMap(existing) &&
      newValue !== null && typeof newValue === "object" &&
      !Array.isArray(newValue)
    ) {
      // Both sides are objects — recurse to preserve nested comments
      mergeMap(doc, existing, newValue as Record<string, unknown>);

      // Remove keys from the map that are no longer in the new data
      for (let i = existing.items.length - 1; i >= 0; i--) {
        const childKey = String(existing.items[i].key);
        if (!(childKey in (newValue as Record<string, unknown>))) {
          existing.items.splice(i, 1);
        }
      }
    } else if (
      existing !== undefined && isSeq(existing) && Array.isArray(newValue)
    ) {
      // Replace arrays wholesale — element-level merge would lose ordering semantics
      map.set(key, doc.createNode(newValue));
    } else {
      const existingScalar = map.get(key);
      if (existingScalar === undefined || existingScalar !== newValue) {
        map.set(key, doc.createNode(newValue));
      }
    }
  }
}
