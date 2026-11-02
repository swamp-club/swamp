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
import type {
  DefinitionIdLookup,
  DefinitionNameIndex,
} from "./definition_id_index.ts";
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
import { isUuid } from "../../domain/models/model_lookup.ts";
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

/** a point-in-time view over one scan of every definition file */
export interface DefinitionByIdSnapshot {
  /** what findById returns on a fresh repository, its errors included */
  find(type: ModelType, id: DefinitionId): Definition | null;
  declaresType(id: DefinitionId, type: ModelType): boolean;
}

interface SnapshotFile {
  readonly dir: string;
  readonly isSymlink: boolean;
  readonly read:
    | { definition: Definition | null }
    | { error: unknown };
}

export class YamlDefinitionRepository implements DefinitionRepository {
  private readonly baseDir: string;
  private readonly secondaryBaseDir: string | undefined;
  private readonly idToActualPath = new Map<DefinitionId, string>();
  /**
   * hints hold a path only, never a parsed definition or a miss; the file is
   * re-read and its name re-checked on every hit, so stale hints self-correct
   * and save and delete need no invalidation
   */
  private readonly nameToActualPath = new Map<
    string,
    { path: string; primary: boolean }
  >();
  private readonly autoDefinitionNameIndexes = new Map<
    string,
    AutoDefinitionNameIndex
  >();
  private readonly globalNameToActualPath = new Map<
    string,
    { path: string; pathSegments: string[]; primary: boolean }
  >();
  private nameIndex: DefinitionNameIndex | undefined;
  private idIndex: DefinitionIdLookup | undefined;

  constructor(
    private readonly repoDir: string,
    private readonly eventBus?: EventBus,
    baseDir?: string,
    secondaryBaseDir?: string | false,
    private readonly markDirtyHook?: MarkDirtyHook,
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
    // the file must declare this id: a definition named with this UUID lives at
    // the same path
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

    // the cache is keyed by id alone, so trust a path only in this type's
    // directory or declaring this type; otherwise a definition loaded once is
    // returned for every type
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath && cachedPath !== legacyPath) {
      const cached = await this.readDeclared(cachedPath);
      if (cached?.id === id) {
        return this.isOfType(cachedPath, cached, type) ? cached : null;
      }
    }

    const definitions = await this.findAll(type);
    const found = definitions.find((d) => d.id === id);
    if (found) return found;

    // record where the match lives so getPath, delete and save act on the
    // auto-definition file
    if (this.secondaryBaseDir) {
      const located = await this.locateAutoDefinitionById(
        this.secondaryBaseDir,
        type,
        id,
      );
      if (!located) {
        // an auto-definition stored under its id that the datastore could not
        // materialise fails loudly; one under its name cannot be told from its
        // id, so the miss names them
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

  private async locateAutoDefinitionById(
    secondaryBaseDir: string,
    type: ModelType,
    id: DefinitionId,
  ): Promise<{ definition: Definition; path: string } | null> {
    if (!this.idIndex) {
      return await this.locateByIdInDir(secondaryBaseDir, type, id);
    }
    const typeDir = join(secondaryBaseDir, type.toDirectoryPath());
    const match = (await this.idIndex.findAllById(id)).find((found) =>
      !found.primary && dirname(found.path) === typeDir
    );
    return match ? { definition: match.definition, path: match.path } : null;
  }

  private async locateByIdInDir(
    dir: string,
    type: ModelType,
    id: DefinitionId,
  ): Promise<{ definition: Definition; path: string } | null> {
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

    const typeDir = join(dir, type.toDirectoryPath());
    try {
      for await (const entry of Deno.readDir(typeDir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const entryPath = join(typeDir, entry.name);
          try {
            const data = await readDefinitionData(entryPath, id);
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

    // deliberately outside the filename-safe guard: definitions reaching the
    // slow path are exactly those the guard rejects or whose name-derived file
    // does not exist
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

    const definitions = await this.findAll(type);
    const found = definitions.find((def) => def.name === name);
    if (found) {
      const foundPath = this.idToActualPath.get(found.id as DefinitionId);
      if (foundPath) {
        this.nameToActualPath.set(hintKey, { path: foundPath, primary: true });
      }
      probe.method = "primary_scan";
      return found;
    }
    if (this.secondaryBaseDir) {
      // only with the primary directory exhausted may a secondary hint answer:
      // the primary definition of the same name always wins
      if (hint && !hint.primary) {
        const hinted = await this.readDefinitionIfNamed(hint.path, name);
        if (hinted) {
          this.idToActualPath.set(hinted.id as DefinitionId, hint.path);
          probe.method = "secondary_hint";
          return hinted;
        }
        this.nameToActualPath.delete(hintKey);
      }
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

  private async throwIfUnreadable(path: string): Promise<void> {
    const error = await this.unreadableContent?.(path);
    if (error !== undefined) throw error;
  }

  /**
   * asks every directory this checkout has under base and every registered
   * type's, since a type whose only definition could not be materialised has no
   * directory here
   */
  private async throwIfUnreadableByName(
    base: string,
    name: string,
  ): Promise<void> {
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
   * returns null on any failure so the caller falls back to the discovery walk;
   * a corrupt file must not throw here. A hinted path is re-checked for symlink
   * escape before it is read.
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

  /**
   * serve attaches an index once; a CLI command attaches none, since building
   * one reads every definition where a walk stops at the first match.
   * findByNameGlobal never consults it.
   */
  useNameIndex(index: DefinitionNameIndex): void {
    if (this.nameIndex) {
      throw new Error("This definition repository already has a name index");
    }
    this.nameIndex = index;
  }

  /**
   * serve attaches an index once; a CLI command attaches none and scans a
   * type's auto-definitions for an id, since they are stored under their name
   */
  useIdIndex(index: DefinitionIdLookup): void {
    if (this.idIndex) {
      throw new Error("This definition repository already has an id index");
    }
    this.idIndex = index;
  }

  // undefined when no index is attached; the index holds every definition of
  // every type, so null is a final miss
  async findByIdFromIndex(
    id: DefinitionId,
  ): Promise<{ definition: Definition; type: ModelType } | null | undefined> {
    if (!this.idIndex) return undefined;
    const [first] = await this.idIndex.findAllById(id);
    if (!first) {
      await this.failIfUnreadableById(id);
      return null;
    }
    this.idToActualPath.set(id, first.path);
    return { definition: first.definition, type: first.type };
  }

  /**
   * the index sees a file rewritten in place to declare another name only once
   * its directory changes, so only a caller that accepts that uses this
   */
  async findByNameGlobalFromIndex(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    if (!this.nameIndex) return await this.findByNameGlobal(name);
    const hinted = await this.readPrimaryHint(name);
    if (hinted) return hinted;
    return await this.findByNameInIndex(this.nameIndex, name);
  }

  async findByNameGlobal(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    // no name-derived fast path: without a hint every call re-walks and
    // re-parses every definition until it hits a match
    const tally = currentDiagnosticTally();
    const hint = this.globalNameToActualPath.get(name);
    const hinted = await this.readPrimaryHint(name);
    if (hinted) return hinted;

    tally.add("primary_walks");
    const result = await this.searchDefinitionByName(
      this.baseDir,
      [],
      name,
      true,
    );
    if (result) return result;
    if (this.secondaryBaseDir) {
      // checked only after the primary walk comes up empty, so a secondary hint
      // cannot shadow a primary definition added since the hint was recorded
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

  private async readPrimaryHint(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    const hint = this.globalNameToActualPath.get(name);
    if (!hint?.primary) return null;
    const hinted = await this.readHintedWithType(hint, name);
    if (hinted) {
      currentDiagnosticTally().add("name_hint_hits");
      return hinted;
    }
    this.globalNameToActualPath.delete(name);
    return null;
  }

  private async findByNameInIndex(
    index: DefinitionNameIndex,
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    const lookup = startDiagnosticPhase("definition_lookup", {
      "swamp.diagnostic.lookup_method": "global_index",
    });
    try {
      const found = await lookup.run(async () => {
        const match = await index.findByName(name);
        if (match) {
          this.idToActualPath.set(
            match.definition.id as DefinitionId,
            match.path,
          );
          // only a primary hint is read while an index is attached: a
          // definition added since may shadow an auto-definition
          if (match.primary) {
            this.globalNameToActualPath.set(name, {
              path: match.path,
              pathSegments: match.segments,
              primary: true,
            });
          }
          return match;
        }
        if (
          this.secondaryBaseDir && this.unreadableContent &&
          isFilenameSafeDefinitionName(name)
        ) {
          await this.throwIfUnreadableByName(this.secondaryBaseDir, name);
        }
        return null;
      });
      lookup.attributes({
        "swamp.diagnostic.hit": found !== null,
        "swamp.diagnostic.source": found === null
          ? "none"
          : found.primary
          ? "primary"
          : "auto",
      });
      lookup.end();
      return found && { definition: found.definition, type: found.type };
    } catch (error) {
      lookup.fail(error);
      throw error;
    }
  }

  async isAutoDefinition(
    definition: Definition,
    type: ModelType,
  ): Promise<boolean> {
    if (!this.secondaryBaseDir) return false;
    const byName = await this.findByNamePrimary(definition.name);
    if (byName?.definition.id === definition.id) return false;
    if (byName === null) return true;
    // A definition of this name in models/ with another ID: confirm by ID
    // rather than trust the name.
    return !(await this.findAll(type)).some((d) => d.id === definition.id);
  }

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
   * the type conversion is guarded because discovery skips a file with an
   * invalid type; unguarded, a hint for such a file would throw instead of
   * falling back to the walk
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

  private async searchDefinitionByName(
    currentDir: string,
    pathSegments: string[],
    name: string,
    primary: boolean,
  ): Promise<{ definition: Definition; type: ModelType } | null> {
    // models/ is hand-written, so only auto-definitions are filtered
    const mustContain = !primary && isUuid(name) ? name : undefined;
    try {
      for (const entry of await readDirSorted(currentDir)) {
        const fullPath = join(currentDir, entry.name);

        if (
          (entry.isFile || entry.isSymlink) && entry.name.endsWith(".yaml")
        ) {
          try {
            if (entry.isSymlink) {
              await assertSafePath(fullPath, this.repoDir);
            }
            const data = await readDefinitionData(fullPath, mustContain);
            if (!data) continue;
            const definition = Definition.fromData(data);

            if (definition.name === name) {
              // resolved before anything is recorded: an invalid type throws
              // into the catch below, which warns and skips the file, and a
              // skipped file must not leave a hint
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
    for (const dir of [this.baseDir, this.secondaryBaseDir]) {
      if (!dir) continue;
      const results: { definition: Definition; type: ModelType }[] = [];
      await this.collectAllDefinitions(dir, [], results);
      const found = results.find((entry) => entry.definition.id === id);
      if (found) return found;
    }
    await this.failIfUnreadableById(id);
    return null;
  }

  private async failIfUnreadableById(id: DefinitionId): Promise<void> {
    if (this.secondaryBaseDir && this.unreadableContent) {
      // an auto-definition stored under its id that the datastore could not
      // materialise fails loudly; one under its name cannot be told from its
      // id, so the miss names them
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
      // without recording paths: the last definition read for an id must not
      // become where findById looks next, or an auto-definition would shadow a
      // primary one
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
   * the scan keeps a definition whose declared type is invalid, records no
   * paths or hints, and ignores unreadableContent; an id-named symlink leaving
   * the repository raises where findById would read it
   */
  async snapshotById(): Promise<DefinitionByIdSnapshot> {
    const roots = [this.baseDir, this.secondaryBaseDir].filter((dir) =>
      dir !== undefined
    );
    const byPath = new Map<string, SnapshotFile>();
    const byId = new Map<string, SnapshotFile[]>();
    for (const root of roots) {
      await this.collectSnapshotFiles(root, byPath, byId);
    }
    const definitionAt = (path: string, id: DefinitionId) => {
      const file = byPath.get(path);
      if (!file) return null;
      // as findById's read of an id-named file: errors are raised
      if ("error" in file.read) {
        if (file.read.error instanceof Deno.errors.NotFound) return null;
        throw file.read.error;
      }
      return file.read.definition?.id === id ? file.read.definition : null;
    };
    const firstIn = (
      dir: string,
      id: DefinitionId,
      allowSymlinks: boolean,
    ): Definition | null => {
      for (const file of byId.get(id) ?? []) {
        if (file.dir !== dir || (file.isSymlink && !allowSymlinks)) continue;
        if ("definition" in file.read) return file.read.definition;
      }
      return null;
    };
    return {
      find: (type, id) => {
        const primaryDir = this.getTypeDir(type);
        const found = definitionAt(join(primaryDir, `${id}.yaml`), id) ??
          firstIn(primaryDir, id, true);
        if (found || !this.secondaryBaseDir) return found;
        const autoDir = this.getTypeDir(type, this.secondaryBaseDir);
        return definitionAt(join(autoDir, `${id}.yaml`), id) ??
          firstIn(autoDir, id, false);
      },
      declaresType: (id, type) =>
        (byId.get(id) ?? []).some((file) =>
          "definition" in file.read && file.read.definition !== null &&
          declaresType(file.read.definition, type)
        ),
    };
  }

  /** through the id index when one is attached, otherwise a walk */
  async declaresTypeById(id: DefinitionId, type: ModelType): Promise<boolean> {
    const found = this.idIndex
      ? await this.idIndex.findAllById(id)
      : await this.findAllByIdGlobal(id);
    return found.some(({ definition }) => declaresType(definition, type));
  }

  private async collectSnapshotFiles(
    dir: string,
    byPath: Map<string, SnapshotFile>,
    byId: Map<string, SnapshotFile[]>,
  ): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = await readDirSorted(dir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await this.collectSnapshotFiles(path, byPath, byId);
        continue;
      }
      if (!(entry.isFile || entry.isSymlink) || !entry.name.endsWith(".yaml")) {
        continue;
      }
      let read: SnapshotFile["read"];
      try {
        if (entry.isSymlink) await assertSafePath(path, this.repoDir);
        const data = await readDefinitionData(path);
        read = { definition: data ? Definition.fromData(data) : null };
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
        read = { error };
        if (!(error instanceof Deno.errors.NotFound)) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.warn`Skipping broken definition file ${path}: ${msg}`;
        }
      }
      const file: SnapshotFile = {
        dir,
        isSymlink: entry.isSymlink,
        read,
      };
      byPath.set(path, file);
      if ("definition" in read && read.definition) {
        const owners = byId.get(read.definition.id) ?? [];
        owners.push(file);
        byId.set(read.definition.id, owners);
      }
    }
  }

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
          const found = await this.readDefinitionEntry(
            fullPath,
            pathSegments,
            entry.isSymlink,
            recordPaths,
          );
          if (found) results.push(found);
        } else if (entry.isDirectory) {
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

  definitionRoots(): string[] {
    return this.secondaryBaseDir
      ? [this.baseDir, this.secondaryBaseDir]
      : [this.baseDir];
  }

  /**
   * null for an empty or broken file, which is warned about and skipped; an I/O
   * error is raised
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

        const legacyPath = this.getLegacyPath(
          type,
          definition.id,
          writeBaseDir,
        );
        // on v3, what each file held before this save is read first: its digest
        // for an edit's precondition and the name it declared, which tells a
        // rename; before readMergeSource, which removes a corrupt target
        const priors = typedStagingActive(this.markDirtyHook)
          ? await readPriors([targetPath, previousPath, legacyPath])
          : new Map<string, PriorFile>();
        const isNew = !(await this.exists(targetPath)) &&
          !(previousPath && await this.exists(previousPath)) &&
          !(await this.exists(legacyPath));

        const data = definition.toData();
        data.type = type.normalized;
        await modelRegistry.ensureTypeLoaded(type);
        let modelDef = modelRegistry.get(type);
        // ensureTypeLoaded imports only lazy-registered types; a command that
        // never populated the registry would silently bypass the sensitive-arg
        // guard, so fall back to a full (memoized) extension load
        if (!modelDef) {
          await modelRegistry.ensureLoaded();
          await modelRegistry.ensureTypeLoaded(type);
          modelDef = modelRegistry.get(type);
        }
        // typeVersion is deliberately not stamped here: only creation and
        // DefinitionUpgradeService set it, since stamping a stale instance as
        // current would strand it, and an absent one stays absent

        // fail closed before writing: a literal sensitive global argument would
        // sit in cleartext in the YAML. Every writer funnels through here;
        // throwing leaves no partial file.
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

        const cleanData = JSON.parse(JSON.stringify(data)) as Record<
          string,
          unknown
        >;

        // if the data is unchanged skip the write, or carry the text over
        // verbatim on a move; otherwise merge onto the existing AST so comments
        // on unchanged nodes survive
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

  private stagingTierOf(path: string) {
    return stagingTierOf(this.repoDir, [
      this.baseDir,
      this.secondaryBaseDir,
    ], path);
  }

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
   * ids are not unique (a copied file keeps its id), so with name only a file
   * declaring both is removed, never another definition sharing the id
   */
  async delete(
    type: ModelType,
    id: DefinitionId,
    name?: string,
  ): Promise<void> {
    const tally = currentDiagnosticTally();
    const definition = await tally.measure(
      "lookup",
      () => this.findById(type, id),
    );
    let definitionName = name ?? definition?.name;

    const pathsToTry = new Set([this.getLegacyPath(type, id)]);
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
    if (this.secondaryBaseDir) {
      const secondaryBaseDir = this.secondaryBaseDir;
      const located = await tally.measure(
        "lookup",
        () => this.locateAutoDefinitionById(secondaryBaseDir, type, id),
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
            // the id-named path is also where a definition named with this UUID
            // lives, and a copied file can share the id; never remove another
            // definition's file
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

  private async declaresId(path: string, id: DefinitionId): Promise<boolean> {
    return (await this.readDeclared(path))?.id === id;
  }

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
   * a file other than the target is used only when it declares id: the cached
   * path may be stale, and the uuid path is also where a definition named with
   * that UUID lives
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
      // a corrupt or empty file is removed so the write replaces it with valid
      // content; the definition may still have a file to merge from below
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
        // an I/O error must propagate: reading the file as absent would write a
        // fresh one and then remove this one, dropping its comments unseen
        if (isIoError(error)) throw error;
      }
    }
    return null;
  }

  /**
   * the check is on id alone: a renamed definition's old file declares its old
   * name, so name cannot tell a rename apart from another definition
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
   * a definition only in the auto-definitions directory stays there; otherwise
   * a save would write it to the primary directory and remove the
   * auto-definition or leave a stale copy
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

  private ownerBaseDir(path: string): string {
    return this.secondaryBaseDir && isWithinDir(path, this.secondaryBaseDir)
      ? this.secondaryBaseDir
      : this.baseDir;
  }

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

  private isPathOfType(path: string, type: ModelType): boolean {
    const dir = dirname(path);
    if (dir === this.getTypeDir(type)) return true;
    return this.secondaryBaseDir !== undefined &&
      dir === join(this.secondaryBaseDir, type.toDirectoryPath());
  }
}

// an invalid declared type declares nothing
function declaresType(definition: Definition, type: ModelType): boolean {
  if (definition.type === undefined) return false;
  try {
    return ModelType.create(definition.type).normalized === type.normalized;
  } catch {
    return false;
  }
}

async function readDefinitionData(
  path: string,
  mustContain?: string,
): Promise<DefinitionData | null> {
  const tally = currentDiagnosticTally();
  const content = await tally.measure("read", () => Deno.readTextFile(path));
  tally.add("files_read");
  if (tally.recording) tally.add("bytes_read", utf8ByteLength(content));
  // can turn a YAML-escaped needle into a miss, never into a wrong match
  if (mustContain !== undefined && !content.includes(mustContain)) return null;
  return tally.measureSync(
    "parse",
    () => parseYaml(content),
  ) as DefinitionData | null;
}

type LookupMethod =
  | "name_file"
  | "primary_hint"
  | "primary_scan"
  | "secondary_hint"
  | "secondary_name_file"
  | "secondary_index"
  | "none";

/**
 * JSON-encoded so it is unambiguous for any input, without assuming which
 * characters a type or definition name can contain
 */
function nameHintKey(type: ModelType, name: string): string {
  return JSON.stringify([type.toDirectoryPath(), name]);
}

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
 * the serializer re-wraps every scalar, so a file with a line past 80 columns
 * is never folded and any other is folded at 80; comment lines and block scalar
 * lines do not count
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
 * scalar-only changes are edited in place; otherwise merge onto the parsed
 * document, and if aliases break the read-back redo it with aliases expanded; a
 * fresh rendering is the last resort
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

interface ScalarEdit {
  token: CST.Token;
  value: string;
  type?: Scalar.Type;
}

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

function readsBackAs(content: string, expected: string): boolean {
  try {
    return canonicalJson(JSON.parse(JSON.stringify(parseYaml(content)))) ===
      expected;
  } catch {
    return false;
  }
}

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
      mergeMap(
        doc,
        existing,
        newValue as Record<string, unknown>,
        oldMap?.[key],
      );

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
