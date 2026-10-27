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
import {
  stageTyped,
  typedStagingActive,
  withChangeSignalled,
} from "./unit_of_work_scope.ts";
import {
  definitionDeleteBatches,
  definitionSaveBatches,
  type PriorFile,
  readPriors,
  stagingTierOf,
} from "./config_staging.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import { isIoError } from "./io_errors.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import {
  Composer,
  CST,
  type Document as YamlDocument,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node as YamlNode,
  parseDocument,
  Parser,
  Scalar,
  visit,
  type YAMLMap,
} from "yaml";
import { assertSafePath } from "./safe_path.ts";
import {
  resolveEffectiveDefinitionsDir,
  SWAMP_SUBDIRS,
  swampPath,
} from "./paths.ts";
import { readDirSorted } from "./sorted_dir_entries.ts";
import { AutoDefinitionNameIndex } from "./auto_definition_name_index.ts";
import {
  currentDiagnosticTally,
  startDiagnosticPhase,
  utf8ByteLength,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import {
  unreadableRecordsUnder,
  warnUnreadableLeftOut,
} from "./unreadable_records.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import type {
  MarkDirtyHook,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
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
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";
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
  /**
   * One name index per auto-definitions type directory a lookup by name has
   * missed in, so a later miss reads only what changed there. Like the hints
   * above it keeps paths and names only; a cache-reset hook must clear it.
   */
  private readonly autoDefinitionNameIndexes = new Map<
    string,
    AutoDefinitionNameIndex
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
    /**
     * Tells an auto-definition a v3 read model could not materialise from
     * an absent one (swamp-club#3617), so a lookup by name that finds no
     * definition fails loudly on it instead.
     */
    readonly unreadableContent?: UnreadableContentLookup,
  ) {
    this.baseDir = baseDir ?? resolveEffectiveDefinitionsDir(repoDir);
    this.secondaryBaseDir = secondaryBaseDir === false
      ? undefined
      : (secondaryBaseDir ??
        swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions));
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
      if (!located) {
        // An auto-definition stored under its id (a legacy or not
        // filename-safe name) the datastore could not materialise fails
        // loudly (swamp-club#3617). One stored under its name cannot be
        // told from its id, so the miss names them, as findByIdGlobal does.
        const typeDir = join(this.secondaryBaseDir, type.toDirectoryPath());
        await this.throwIfUnreadable(join(typeDir, `${id}.yaml`));
        await warnUnreadableLeftOut(this.unreadableContent, typeDir);
        return null;
      }
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
    const scan = startDiagnosticPhase("definition_scan", {
      "swamp.diagnostic.scan_root": "primary",
      "swamp.diagnostic.scan_strategy": "full_listing",
      "swamp.diagnostic.definition_type": type.normalized,
    });
    try {
      const definitions = await scan.run(() => this.scanTypeDir(type));
      scan.tally.add("definitions", definitions.length);
      scan.end();
      return definitions;
    } catch (error) {
      scan.fail(error);
      throw error;
    }
  }

  private async scanTypeDir(type: ModelType): Promise<Definition[]> {
    const dir = this.getTypeDir(type);
    const definitions: Definition[] = [];

    try {
      for (const entry of await readDirSorted(dir)) {
        if (
          (entry.isFile || entry.isSymlink) && entry.name.endsWith(".yaml")
        ) {
          const path = join(dir, entry.name);
          currentDiagnosticTally().add("files_examined");
          try {
            if (entry.isSymlink) {
              await assertSafePath(path, this.repoDir);
            }
            const data = await readDefinitionData(path);
            if (!data) continue;
            const definition = Definition.fromData(data);
            this.idToActualPath.set(
              definition.id as DefinitionId,
              path,
            );
            definitions.push(definition);
          } catch (error) {
            if (isIoError(error)) {
              throw markErrorPaths(
                new UserError(
                  `Failed to read definition file ${path}: ${
                    error instanceof Error ? error.message : error
                  }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
                ),
                [path, ...errorPaths(error)],
              );
            }
            currentDiagnosticTally().add("broken_files");
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
    const lookup = startDiagnosticPhase("definition_lookup", {
      "swamp.diagnostic.definition_type": type.normalized,
    });
    const probe: { method: LookupMethod } = { method: "none" };
    try {
      const found = await lookup.run(() =>
        this.lookupByName(type, name, probe)
      );
      lookup.attributes({
        "swamp.diagnostic.lookup_method": probe.method,
        "swamp.diagnostic.hit": found !== null,
        "swamp.diagnostic.source": found === null
          ? "none"
          : probe.method.startsWith("secondary")
          ? "auto"
          : "primary",
      });
      lookup.end();
      return found;
    } catch (error) {
      lookup.attributes({ "swamp.diagnostic.lookup_method": probe.method });
      lookup.fail(error);
      throw error;
    }
  }

  private async lookupByName(
    type: ModelType,
    name: string,
    probe: { method: LookupMethod },
  ): Promise<Definition | null> {
    // Fast path: try name-based filename directly
    if (isFilenameSafeDefinitionName(name)) {
      const namePath = this.getNamePath(type, name);
      try {
        const data = await readDefinitionData(namePath);
        if (data) {
          const definition = Definition.fromData(data);
          if (definition.name !== name) {
            // File content doesn't match filename — fall through to slow path
          } else {
            this.idToActualPath.set(definition.id as DefinitionId, namePath);
            probe.method = "name_file";
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
      if (hinted) {
        probe.method = "primary_hint";
        return hinted;
      }
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
      probe.method = "primary_scan";
      return found;
    }
    if (this.secondaryBaseDir) {
      // Only now, with the primary directory exhausted, may a secondary hint
      // answer: the primary definition of the same name always wins.
      if (hint && !hint.primary) {
        const hinted = await this.readDefinitionIfNamed(hint.path, name);
        if (hinted) {
          this.idToActualPath.set(hinted.id as DefinitionId, hint.path);
          probe.method = "secondary_hint";
          return hinted;
        }
        this.nameToActualPath.delete(hintKey);
      }
      // The name-derived file answers without parsing every definition of the
      // type: serve's control-plane lookups land here for each new worker.
      if (isFilenameSafeDefinitionName(name)) {
        const namePath = this.getNamePath(type, name, this.secondaryBaseDir);
        const named = await this.readDefinitionIfNamed(namePath, name);
        if (named) {
          this.idToActualPath.set(named.id as DefinitionId, namePath);
          this.nameToActualPath.set(hintKey, {
            path: namePath,
            primary: false,
          });
          probe.method = "secondary_name_file";
          return named;
        }
      }
      // Only a file at another path is left: the name index answers without
      // reading every file of the type each time (swamp-club#3984).
      const secondaryMatch = await this.findInNameIndex(
        type,
        this.secondaryBaseDir,
        name,
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
        probe.method = "secondary_index";
        return secondaryMatch.definition;
      }
      if (isFilenameSafeDefinitionName(name)) {
        await this.throwIfUnreadable(
          this.getNamePath(type, name, this.secondaryBaseDir),
        );
      }
    }
    return null;
  }

  /**
   * The name index's answer for `name`, as a `definition_scan` phase: the
   * index's own `swamp.definition.name_index.validate` span nests under it
   * when this lookup ran the check.
   */
  private async findInNameIndex(
    type: ModelType,
    secondaryBaseDir: string,
    name: string,
  ): Promise<{ definition: Definition; path: string } | null> {
    const scan = startDiagnosticPhase("definition_scan", {
      "swamp.diagnostic.scan_root": "auto",
      "swamp.diagnostic.scan_strategy": "name_index",
      "swamp.diagnostic.definition_type": type.normalized,
    });
    try {
      const found = await scan.run(() =>
        this.autoDefinitionNameIndex(type, secondaryBaseDir).find(name)
      );
      scan.end();
      return found;
    } catch (error) {
      scan.fail(error);
      throw error;
    }
  }

  private autoDefinitionNameIndex(
    type: ModelType,
    secondaryBaseDir: string,
  ): AutoDefinitionNameIndex {
    const dir = this.getTypeDir(type, secondaryBaseDir);
    let index = this.autoDefinitionNameIndexes.get(dir);
    if (!index) {
      index = new AutoDefinitionNameIndex(
        dir,
        type,
        (path, typeSegments, isSymlink) =>
          this.readDefinitionFile(path, typeSegments, isSymlink),
      );
      this.autoDefinitionNameIndexes.set(dir, index);
    }
    return index;
  }

  /**
   * Throws when the datastore recorded the auto-definition missing at
   * `path` as unreadable (swamp-club#3617), so a lookup fails loudly instead
   * of finding no definition. A file that is simply absent returns.
   */
  private async throwIfUnreadable(path: string): Promise<void> {
    const error = await this.unreadableContent?.(path);
    if (error !== undefined) throw error;
  }

  /**
   * {@link throwIfUnreadable} for the file `name` names in each type
   * directory of `base`: a lookup by name alone does not know the type its
   * file was under. Asks every directory this checkout has under `base`, and
   * every registered type's, since a type whose only definition could not be
   * materialised has no directory here.
   */
  private async throwIfUnreadableByName(
    base: string,
    name: string,
  ): Promise<void> {
    // One query over `base` when the lookup can list, which also finds a
    // definition of a type that is neither registered nor has a directory.
    if (this.unreadableContent?.under !== undefined) {
      for (
        const entry of await unreadableRecordsUnder(
          this.unreadableContent,
          base,
        )
      ) {
        if (basename(entry.path) === `${name}.yaml`) throw entry.error;
      }
      return;
    }
    const dirs = new Set<string>();
    const walkDirs = async (dir: string): Promise<void> => {
      dirs.add(dir);
      let entries;
      try {
        entries = await readDirSorted(dir);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isDirectory) await walkDirs(join(dir, entry.name));
      }
    };
    await walkDirs(base);
    for (const type of modelRegistry.types()) {
      dirs.add(this.getTypeDir(type, base));
    }
    for (const dir of dirs) {
      await this.throwIfUnreadable(join(dir, `${name}.yaml`));
    }
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
      const data = await readDefinitionData(path);
      if (!data) return null;
      const definition = Definition.fromData(data);
      return definition.name === name ? definition : null;
    } catch {
      return null;
    }
  }

  async findByNameGlobal(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    // This method has no name-derived fast path at all — without a hint every
    // call re-walks and re-parses every definition in the repository until it
    // hits a match. The running diagnostic phase, if any, counts which step
    // answered; the walks count their reads (files_read, read_work_ms).
    const tally = currentDiagnosticTally();
    const hint = this.globalNameToActualPath.get(name);
    if (hint?.primary) {
      const hinted = await this.readHintedWithType(hint, name);
      if (hinted) {
        tally.add("name_hint_hits");
        return hinted;
      }
      this.globalNameToActualPath.delete(name);
    }

    tally.add("primary_walks");
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
        if (hinted) {
          tally.add("name_hint_hits");
          return hinted;
        }
        this.globalNameToActualPath.delete(name);
      }
      tally.add("secondary_walks");
      const secondary = await this.searchDefinitionByName(
        this.secondaryBaseDir,
        [],
        name,
        false,
      );
      if (secondary) return secondary;
      if (this.unreadableContent && isFilenameSafeDefinitionName(name)) {
        await this.throwIfUnreadableByName(this.secondaryBaseDir, name);
      }
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
      for (const entry of await readDirSorted(currentDir)) {
        const fullPath = join(currentDir, entry.name);

        if (
          (entry.isFile || entry.isSymlink) && entry.name.endsWith(".yaml")
        ) {
          // Found a YAML file, check if it matches the name
          try {
            if (entry.isSymlink) {
              await assertSafePath(fullPath, this.repoDir);
            }
            const data = await readDefinitionData(fullPath);
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
              throw markErrorPaths(
                new UserError(
                  `Failed to read definition file ${fullPath}: ${
                    error instanceof Error ? error.message : error
                  }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
                ),
                [fullPath, ...errorPaths(error)],
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
    if (this.secondaryBaseDir && this.unreadableContent) {
      // An auto-definition stored under its id that the datastore could not
      // materialise fails loudly; one stored under its name cannot be told
      // from its id, so the miss names them (swamp-club#3617).
      for (
        const entry of await unreadableRecordsUnder(
          this.unreadableContent,
          this.secondaryBaseDir,
        )
      ) {
        if (basename(entry.path) === `${id}.yaml`) throw entry.error;
      }
      await warnUnreadableLeftOut(
        this.unreadableContent,
        this.secondaryBaseDir,
      );
    }
    return null;
  }

  async findAllByIdGlobal(
    id: DefinitionId,
  ): Promise<{ definition: Definition; type: ModelType }[]> {
    return (await this.findAllIncludingAutoGlobal()).filter((entry) =>
      entry.definition.id === id
    );
  }

  async findAllIncludingAutoGlobal(): Promise<
    { definition: Definition; type: ModelType }[]
  > {
    const found: { definition: Definition; type: ModelType }[] = [];
    for (const dir of [this.baseDir, this.secondaryBaseDir]) {
      if (!dir) continue;
      // Without recording paths: every definition declaring an id is read,
      // and the last one read must not become where findById looks next —
      // that would let an auto-definition shadow a primary one.
      await this.collectAllDefinitions(dir, [], found, false);
    }
    if (this.secondaryBaseDir) {
      await warnUnreadableLeftOut(
        this.unreadableContent,
        this.secondaryBaseDir,
      );
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
      for (const entry of await readDirSorted(currentDir)) {
        const fullPath = join(currentDir, entry.name);

        if (
          (entry.isFile || entry.isSymlink) && entry.name.endsWith(".yaml")
        ) {
          // Found a YAML file, add it to results
          const found = await this.readDefinitionEntry(
            fullPath,
            pathSegments,
            entry.isSymlink,
            recordPaths,
          );
          if (found) results.push(found);
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

  /**
   * The directories definitions are read from: the definitions directory,
   * then the auto-definitions directory when there is one. The order is the
   * one {@link findAllIncludingAutoGlobal} reads them in.
   */
  definitionRoots(): string[] {
    return this.secondaryBaseDir
      ? [this.baseDir, this.secondaryBaseDir]
      : [this.baseDir];
  }

  /**
   * Reads one definition file as a scan of every definition reads it:
   * `typeSegments` is the path of its directory below its root, the type a
   * file that declares none belongs to. Null for an empty or broken file,
   * which is warned about and skipped; an I/O error is raised.
   */
  readDefinitionFile(
    path: string,
    typeSegments: string[],
    isSymlink: boolean,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    return this.readDefinitionEntry(path, typeSegments, isSymlink, false);
  }

  private async readDefinitionEntry(
    fullPath: string,
    pathSegments: string[],
    isSymlink: boolean,
    recordPaths: boolean,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    try {
      if (isSymlink) {
        await assertSafePath(fullPath, this.repoDir);
      }
      const data = await readDefinitionData(fullPath);
      if (!data) return null;
      const definition = Definition.fromData(data);

      if (recordPaths) {
        this.idToActualPath.set(
          definition.id as DefinitionId,
          fullPath,
        );
      }
      // Prefer the type from the YAML, fall back to path-based type
      const typeStr = definition.type ?? pathSegments.join("/");
      return { definition, type: ModelType.create(typeStr) };
    } catch (error) {
      if (isIoError(error)) {
        throw markErrorPaths(
          new UserError(
            `Failed to read definition file ${fullPath}: ${
              error instanceof Error ? error.message : error
            }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
          ),
          [fullPath, ...errorPaths(error)],
        );
      }
      currentDiagnosticTally().add("broken_files");
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn`Skipping broken definition file ${fullPath}: ${msg}`;
      return null;
    }
  }

  async save(type: ModelType, definition: Definition): Promise<void> {
    const writeBaseDir = await this.resolveSaveBaseDir(type, definition);
    const dir = this.getTypeDir(type, writeBaseDir);
    await assertSafePath(dir, writeBaseDir);
    await ensureDir(dir);

    const targetPath = this.resolveWritePath(type, definition, writeBaseDir);
    return await withChangeSignalled(
      this.markDirtyHook,
      { kind: "write", path: targetPath },
      { typed: true },
      async () => {
        const previousPath = this.idToActualPath.get(definition.id);

        // Check if this is a new definition or an update
        const legacyPath = this.getLegacyPath(
          type,
          definition.id,
          writeBaseDir,
        );
        // On v3 (swamp-club#3256), what each file held before this save replaces
        // or removes it: its digest for an edit's precondition, and the name it
        // declared, which tells a rename apart. Read before readMergeSource,
        // which removes a corrupt target.
        const priors = typedStagingActive(this.markDirtyHook)
          ? await readPriors([targetPath, previousPath, legacyPath])
          : new Map<string, PriorFile>();
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

        // When the definition already has a file — at the target path, or at the
        // path it is moving from (a legacy uuid-named file, or its previous name)
        // — check whether the definition data has actually changed. If it hasn't,
        // skip the write entirely, or carry the text over verbatim when the file
        // is moving, to avoid destroying YAML comments and producing git noise.
        // When the data HAS changed, use npm:yaml's Document API to merge the
        // new values onto the existing AST so that comments on unchanged nodes
        // are preserved (swamp-club#1842, swamp-club#3012, swamp-club#3502).
        const source = isNew ? null : await this.readMergeSource(
          definition.id,
          targetPath,
          previousPath,
          legacyPath,
        );
        if (source) {
          const normalizedExisting = JSON.parse(
            JSON.stringify(source.parsed),
          ) as Record<string, unknown>;
          const unchanged =
            canonicalJson(cleanData) === canonicalJson(normalizedExisting);

          if (unchanged && source.path === targetPath) {
            this.idToActualPath.set(definition.id, targetPath);
            logger
              .debug`Definition ${definition.name} unchanged, skipping write`;
            return;
          }

          const content = unchanged
            ? source.raw
            : renderMerged(source.raw, cleanData, normalizedExisting);
          await atomicWriteTextFile(targetPath, content);

          const removed = await this.cleanupOldPaths(
            definition.id,
            targetPath,
            previousPath,
            legacyPath,
          );
          this.idToActualPath.set(definition.id, targetPath);
          await this.stageSave(
            definition,
            targetPath,
            content,
            removed,
            priors,
          );
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

        const content = stringifyYaml(cleanData);
        await atomicWriteTextFile(targetPath, content);

        const removed = await this.cleanupOldPaths(
          definition.id,
          targetPath,
          previousPath,
          legacyPath,
        );

        this.idToActualPath.set(definition.id, targetPath);
        await this.stageSave(definition, targetPath, content, removed, priors);

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
      },
    );
  }

  /**
   * Stages a save on v3 (swamp-club#3256), outside the cleanup's catch
   * blocks so a refusal surfaces. The batches, in commit order, are in
   * {@link definitionSaveBatches}.
   */
  private async stageSave(
    definition: Definition,
    targetPath: string,
    content: string,
    removed: readonly string[],
    priors: ReadonlyMap<string, PriorFile>,
  ): Promise<void> {
    const batches = typedStagingActive(this.markDirtyHook)
      ? definitionSaveBatches({
        kind: "model",
        id: definition.id,
        name: definition.name,
        targetPath,
        content: new TextEncoder().encode(content),
        removed,
        priors,
        tierOf: (path) => this.stagingTierOf(path),
      })
      : [[]];
    for (const batch of batches) {
      await stageTyped(this.markDirtyHook, () => batch);
    }
  }

  /**
   * A definition file's tier and record key for v3: managed config, or an
   * auto-definitions directory; undefined for a git-tracked definition.
   */
  private stagingTierOf(path: string) {
    return stagingTierOf(this.repoDir, [
      this.baseDir,
      this.secondaryBaseDir,
    ], path);
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
    // Lookups, file removal, the deleted event and change staging are
    // measured apart into the running diagnostic phase, if any.
    const tally = currentDiagnosticTally();
    // Populate cache so we discover name-based and secondary files on a cold
    // instance
    const definition = await tally.measure(
      "lookup",
      () => this.findById(type, id),
    );
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
      const secondaryBaseDir = this.secondaryBaseDir;
      const located = await tally.measure(
        "lookup",
        () => this.locateByIdInDir(secondaryBaseDir, type, id),
      );
      if (located) {
        pathsToTry.add(located.path);
        definitionName ??= located.definition.name;
      }
    }

    const resolvedPath = cachedPath ?? this.getLegacyPath(type, id);
    // A file here that declares another definition is kept, so the change is
    // a write of this path rather than its removal.
    const kept = await this.declaresOther(resolvedPath, id, name);
    return await tally.measure("change_stage", () =>
      withChangeSignalled(
        this.markDirtyHook,
        {
          kind: kept ? "write" : "remove",
          path: resolvedPath,
        },
        { typed: true },
        async () => {
          const priors = typedStagingActive(this.markDirtyHook)
            ? await readPriors([...pathsToTry])
            : new Map<string, PriorFile>();

          let deleted = false;
          const removed: string[] = [];
          for (const path of pathsToTry) {
            // The id-named path is also where a definition named with this UUID
            // lives, and a copied file can share the id; never remove another
            // definition's file.
            if (await this.declaresOther(path, id, name)) continue;
            try {
              const otherCandidate = path !== resolvedPath &&
                await this.exists(path);
              await withChangeSignalled(
                this.markDirtyHook,
                otherCandidate ? [{ kind: "remove", path }] : [],
                { typed: true },
                () => tally.measure("file_remove", () => Deno.remove(path)),
              );
              deleted = true;
              removed.push(path);

              // Clean up empty parent directories
              await tally.measure(
                "file_remove",
                () => cleanupEmptyParentDirs(path, this.ownerBaseDir(path)),
              );
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
              const eventBus = this.eventBus;
              await tally.measure(
                "event_publish",
                () => eventBus.publish(event),
              );
            }
          } else {
            logger.debug`No definition file found to delete for ${id}`;
          }
          const batches = typedStagingActive(this.markDirtyHook)
            ? definitionDeleteBatches({
              kind: "model",
              id,
              name: definitionName,
              removed,
              priors,
              tierOf: (path) => this.stagingTierOf(path),
            })
            : [[]];
          for (const batch of batches) {
            await stageTyped(this.markDirtyHook, () => batch);
          }
        },
      ));
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

  /**
   * Reads the file a save should merge onto: the target file when it exists,
   * otherwise the file the definition is moving from — its cached previous
   * path, or its legacy uuid-named path. A file other than the target is used
   * only when it declares `id`: the cached path is a hint that may be stale,
   * and the uuid-named path is also where a definition *named* with that UUID
   * lives. Null when there is nothing to merge onto.
   */
  private async readMergeSource(
    id: DefinitionId,
    targetPath: string,
    previousPath: string | undefined,
    legacyPath: string,
  ): Promise<
    { path: string; raw: string; parsed: Record<string, unknown> } | null
  > {
    try {
      const raw = await Deno.readTextFile(targetPath);
      const parsed = parseYaml(raw) as Record<string, unknown> | null;
      if (parsed) return { path: targetPath, raw, parsed };
      // Corrupt/empty file — remove it so the write replaces it with valid
      // content. The definition may still have a file to merge from below.
      try {
        await Deno.remove(targetPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }

    for (const path of new Set([previousPath, legacyPath])) {
      if (!path || path === targetPath) continue;
      try {
        const raw = await Deno.readTextFile(path);
        const parsed = parseYaml(raw) as Record<string, unknown> | null;
        if (parsed?.id === id) return { path, raw, parsed };
      } catch (error) {
        // An I/O error must propagate: reading the file as absent would write
        // a fresh one and then remove this one, dropping its comments unseen.
        if (isIoError(error)) throw error;
        // Missing or unparseable — not something to merge onto.
      }
    }
    return null;
  }

  /**
   * Removes the files a definition moved away from. A path that now holds a
   * different definition is left alone, as delete() leaves it. The check is on
   * id alone: a renamed definition's old file declares its old name, so the
   * name cannot tell a rename apart from another definition. Returns the
   * paths it removed, for their v3 tombstones (swamp-club#3256).
   */
  private async cleanupOldPaths(
    id: DefinitionId,
    targetPath: string,
    previousPath: string | undefined,
    legacyPath: string,
  ): Promise<string[]> {
    const removed: string[] = [];
    if (
      previousPath && previousPath !== targetPath &&
      !(await this.declaresOther(previousPath, id))
    ) {
      try {
        await Deno.remove(previousPath);
        removed.push(previousPath);
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
      await this.exists(legacyPath) &&
      !(await this.declaresOther(legacyPath, id))
    ) {
      try {
        await Deno.remove(legacyPath);
        removed.push(legacyPath);
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
    return removed;
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
 * Reads and parses one definition file, counting it into the running
 * diagnostic phase: `files_read` and `bytes_read` for a file read, and its
 * read and parse time as `read_work_ms` and `parse_work_ms`.
 */
async function readDefinitionData(
  path: string,
): Promise<DefinitionData | null> {
  const tally = currentDiagnosticTally();
  const content = await tally.measure("read", () => Deno.readTextFile(path));
  tally.add("files_read");
  if (tally.recording) tally.add("bytes_read", utf8ByteLength(content));
  return tally.measureSync(
    "parse",
    () => parseYaml(content),
  ) as DefinitionData | null;
}

/** Which step of {@link YamlDefinitionRepository.findByName} answered. */
type LookupMethod =
  | "name_file"
  | "primary_hint"
  | "primary_scan"
  | "secondary_hint"
  | "secondary_name_file"
  | "secondary_index"
  | "none";

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

function canonicalJson(data: unknown): string {
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

/**
 * Line width for re-serializing a merged document. The serializer re-wraps
 * every scalar, changed or not, so the width follows what the file already
 * does: a file with a line past 80 columns is never folded, which keeps a long
 * single-line expression on its line, and any other file is folded at 80 as
 * swamp wrote it. Comment lines are not scalars and do not count. Nor do the
 * lines of a block scalar: a fresh write folds into block scalars, and a token
 * with nowhere to break still runs past 80 columns inside one.
 */
function mergeLineWidth(raw: string, doc: YamlDocument): number {
  const blocks: [number, number][] = [];
  visit(doc, {
    Scalar(_key, node) {
      if (
        node.range &&
        (node.type === Scalar.BLOCK_FOLDED ||
          node.type === Scalar.BLOCK_LITERAL)
      ) {
        blocks.push([node.range[0], node.range[1]]);
      }
    },
  });

  let offset = 0;
  for (const line of raw.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.length <= 80 || text.trimStart().startsWith("#")) continue;
    // A block scalar's range starts at its header, on the line before its
    // first content line.
    if (blocks.some(([from, to]) => start > from && start < to)) continue;
    return 0;
  }
  return 80;
}

/**
 * Renders `newData` merged onto the YAML text `raw`, whose own parse is
 * `oldData`. The result always reads back as `newData`.
 *
 * When only scalar values changed — a `typeVersion` bump, an edited argument —
 * they are rewritten in place in the source and every other byte is kept.
 * Otherwise the new values are merged onto the parsed document, which keeps
 * comments, aliases and quoting of every unchanged subtree but re-renders the
 * layout. Merging onto an anchored node also changes every alias of it, and
 * replacing one leaves its aliases with nothing to refer to, so when the merged
 * text reads back as anything else, or cannot be rendered, the merge is redone
 * with the aliases expanded, which keeps the comments but not the aliases. A
 * fresh rendering is the last resort.
 */
function renderMerged(
  raw: string,
  newData: Record<string, unknown>,
  oldData: Record<string, unknown>,
): string {
  const expected = canonicalJson(newData);
  for (const restyle of [false, true]) {
    const edited = editScalarsInPlace(raw, newData, oldData, restyle);
    if (edited !== undefined && readsBackAs(edited, expected)) return edited;
  }
  for (const expand of [false, true]) {
    const doc = parseDocument(raw, { version: "1.1" });
    const lineWidth = mergeLineWidth(raw, doc);
    if (expand) expandAliases(doc);
    mergeIntoDocument(doc, newData, oldData);
    let content: string;
    try {
      content = doc.toString({ lineWidth });
    } catch {
      // A changed anchored node was replaced while an unchanged alias still
      // refers to it, so the document cannot be rendered with its aliases.
      continue;
    }
    if (readsBackAs(content, expected)) return content;
  }
  return stringifyYaml(newData);
}

/**
 * Rewrites, in the source text itself, each scalar whose value differs between
 * `oldData` and `newData`, keeping every other byte. Undefined when the change
 * is not only to existing scalars (a key added or removed, a list resized, a
 * value behind an alias), or the file is not a single document.
 *
 * Without `restyle` each value is written as the CST chooses from the token's
 * own style. With it, each value is written in the style `scalarTypeFor` picks
 * and block scalars are indented under their key — for edits that otherwise
 * read back as something else (swamp-club#3541).
 */
function editScalarsInPlace(
  raw: string,
  newData: Record<string, unknown>,
  oldData: Record<string, unknown>,
  restyle: boolean,
): string | undefined {
  const tokens = Array.from(new Parser().parse(raw));
  const docs = Array.from(
    new Composer({ version: "1.1", keepSourceTokens: true }).compose(tokens),
  );
  if (docs.length !== 1 || docs[0].errors.length > 0) return undefined;
  const edits: ScalarEdit[] = [];
  if (!collectScalarEdits(docs[0].contents, oldData, newData, edits)) {
    return undefined;
  }
  try {
    // Every edited scalar is a value, never a key: without afterKey a block
    // scalar's lines are written at its key's indent and no longer parse.
    for (const { token, value, type } of edits) {
      CST.setScalarValue(
        token,
        value,
        restyle ? { afterKey: true, type } : undefined,
      );
    }
  } catch {
    // A token the CST cannot rewrite leaves the change to the document merge.
    return undefined;
  }
  return tokens.map((token) => CST.stringify(token)).join("");
}

/** A new value for a scalar token, and the style to write it in. */
interface ScalarEdit {
  token: CST.Token;
  value: string;
  type?: Scalar.Type;
}

/**
 * Walks `node` alongside its old and new values, collecting a source edit for
 * each changed scalar. False when a change is anything other than a new
 * scalar value for an existing scalar node.
 */
function collectScalarEdits(
  node: YamlNode | null,
  oldValue: unknown,
  newValue: unknown,
  edits: ScalarEdit[],
): boolean {
  if (canonicalJson(oldValue) === canonicalJson(newValue)) return true;
  if (isPlainRecord(oldValue) && isPlainRecord(newValue) && isMap(node)) {
    const oldKeys = Object.keys(oldValue).sort();
    const newKeys = Object.keys(newValue).sort();
    if (canonicalJson(oldKeys) !== canonicalJson(newKeys)) return false;
    if (node.items.length !== newKeys.length) return false;
    return newKeys.every((key) =>
      collectScalarEdits(
        node.get(key, true) as YamlNode | null,
        oldValue[key],
        newValue[key],
        edits,
      )
    );
  }
  if (
    Array.isArray(oldValue) && Array.isArray(newValue) && isSeq(node) &&
    oldValue.length === newValue.length &&
    node.items.length === newValue.length
  ) {
    return newValue.every((item, i) =>
      collectScalarEdits(
        node.items[i] as YamlNode | null,
        oldValue[i],
        item,
        edits,
      )
    );
  }
  if (!isScalar(node) || !node.srcToken) return false;
  if (!isPrimitive(oldValue) || !isPrimitive(newValue)) return false;
  edits.push({
    token: node.srcToken,
    value: String(newValue),
    type: scalarTypeFor(newValue, node.type),
  });
  return true;
}

/**
 * The style to write `value` in, over a scalar currently written as `current`.
 * A string that spans lines is a block scalar, folded only if it already was.
 * Any other string keeps a quoted or block style, and a plain one is
 * double-quoted when written plain would read back as something else. Any
 * other value is written plain, since quoted it would read back as a string
 * (swamp-club#3541).
 */
function scalarTypeFor(
  value: string | number | boolean | null,
  current: Scalar.Type | undefined,
): Scalar.Type {
  if (typeof value !== "string") return Scalar.PLAIN;
  if (value.includes("\n")) {
    return current === Scalar.BLOCK_FOLDED ? current : Scalar.BLOCK_LITERAL;
  }
  if (current !== undefined && current !== Scalar.PLAIN) return current;
  return readsPlainAs(value) ? Scalar.PLAIN : Scalar.QUOTE_DOUBLE;
}

/** Whether `value`, written as a plain scalar, reads back as that string. */
function readsPlainAs(value: string): boolean {
  try {
    return parseYaml(value) === value;
  } catch {
    return false;
  }
}

function isPrimitive(
  value: unknown,
): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(
    typeof value,
  );
}

/** Whether `content` parses to the data whose canonical JSON is `expected`. */
function readsBackAs(content: string, expected: string): boolean {
  try {
    return canonicalJson(JSON.parse(JSON.stringify(parseYaml(content)))) ===
      expected;
  } catch {
    return false;
  }
}

/**
 * Replaces every alias in `doc` with a copy of the node it refers to, and
 * removes every anchor, so no anchor is duplicated or left unreferenced.
 */
function expandAliases(doc: YamlDocument): void {
  visit(doc, {
    Alias(_key, node) {
      const copy = node.resolve(doc)?.clone();
      return isNode(copy) ? copy : undefined;
    },
  });
  visit(doc, {
    Node(_key, node) {
      if ("anchor" in node) node.anchor = undefined;
    },
  });
}

function mergeIntoDocument(
  doc: YamlDocument,
  newData: Record<string, unknown>,
  oldData: Record<string, unknown>,
): void {
  const root = doc.contents;
  if (!isMap(root)) {
    doc.contents = doc.createNode(newData);
    return;
  }
  mergeMap(doc, root, newData, oldData);

  // Remove keys from the document that are no longer in the new data
  for (let i = root.items.length - 1; i >= 0; i--) {
    const key = String(root.items[i].key);
    if (!(key in newData)) {
      root.items.splice(i, 1);
    }
  }
}

/**
 * Merges `data` onto `map`, whose value as the file's own parse reads it is
 * `old`. A key whose value is unchanged keeps its node as written — comments
 * inside it, an alias, quoting — since that text already reads back as the
 * new value.
 */
function mergeMap(
  doc: YamlDocument,
  map: YAMLMap,
  data: Record<string, unknown>,
  old: unknown,
): void {
  const oldMap = isPlainRecord(old) ? old : undefined;
  for (const [key, newValue] of Object.entries(data)) {
    const existing = map.get(key, true);

    if (
      existing !== undefined && oldMap && Object.hasOwn(oldMap, key) &&
      canonicalJson(oldMap[key]) === canonicalJson(newValue)
    ) {
      continue;
    }

    if (
      existing !== undefined && isMap(existing) &&
      newValue !== null && typeof newValue === "object" &&
      !Array.isArray(newValue)
    ) {
      // Both sides are objects — recurse to preserve nested comments
      mergeMap(
        doc,
        existing,
        newValue as Record<string, unknown>,
        oldMap?.[key],
      );

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
