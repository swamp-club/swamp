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

import { ensureDir, walk } from "@std/fs";
import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";
import { resolveEffectiveVaultsDir } from "./paths.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { assertSafePath } from "./safe_path.ts";
import {
  stageTyped,
  typedStagingActive,
  withChangeSignalled,
} from "./unit_of_work_scope.ts";
import {
  definitionDeleteBatches,
  definitionSaveBatches,
  type PriorFile,
  readPriorFile,
  sha256Hex,
  stagingTierOf,
} from "./config_staging.ts";
import { comparePathsBySegment } from "./sorted_dir_entries.ts";
import {
  VaultConfig,
  type VaultConfigData,
  VaultConfigDataSchema,
  type VaultConfigId,
} from "../../domain/vaults/vault_config.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  createVaultCreated,
  createVaultDeleted,
  createVaultUpdated,
} from "../../domain/events/types.ts";

export class VaultConfigParseError extends UserError {
  constructor(
    readonly path: string,
    readonly vaultType: string,
    readonly vaultId: string,
    reason: string,
  ) {
    super(
      `Invalid vault config in ${path}: ${reason}\n` +
        `Repair it with 'swamp vault edit ${vaultId} --type ${vaultType}'.`,
    );
    this.name = "VaultConfigParseError";
    markErrorPaths(this, [path]);
  }
}

export class YamlVaultConfigRepository {
  private readonly eventBus: EventBus | null;
  private readonly baseDir: string;

  constructor(
    private readonly repoDir: string,
    eventBus?: EventBus,
    baseDir?: string,
    private readonly markDirty?: MarkDirtyHook,
  ) {
    this.eventBus = eventBus ?? null;
    this.baseDir = baseDir ?? resolveEffectiveVaultsDir(repoDir);
  }

  async findById(
    vaultType: string,
    id: VaultConfigId,
  ): Promise<VaultConfig | null> {
    const path = this.getPath(vaultType, id);
    try {
      const content = await Deno.readTextFile(path);
      const data = this.parseVaultConfig(content, path);
      return VaultConfig.fromData(data);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /**
   * unparseable files are skipped while a match may still come; with no match
   * the first is reported, unless skipUnparseable, which treats an unreadable
   * file as not holding the name
   */
  async findByName(
    name: string,
    skipUnparseable = false,
  ): Promise<VaultConfig | null> {
    const vaultDir = this.getVaultDir();
    let parseError: VaultConfigParseError | null = null;
    try {
      for (const path of await this.yamlFilesSorted(vaultDir)) {
        const content = await Deno.readTextFile(path);
        let data: VaultConfigData;
        try {
          data = this.parseVaultConfig(content, path);
        } catch (error) {
          if (!(error instanceof VaultConfigParseError)) throw error;
          if (!skipUnparseable) parseError ??= error;
          continue;
        }
        if (data.name === name) {
          return VaultConfig.fromData(data);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
    if (parseError) throw parseError;
    return null;
  }

  /**
   * lets a name check that skips unparseable files avoid a rename taking a name
   * such a file declares, which would leave two vaults with it once fixed
   */
  async findUnparseableDeclaring(name: string): Promise<string[]> {
    const found: string[] = [];
    try {
      for (const path of await this.yamlFilesSorted(this.getVaultDir())) {
        const content = await Deno.readTextFile(path);
        try {
          this.parseVaultConfig(content, path);
          continue;
        } catch (error) {
          if (!(error instanceof VaultConfigParseError)) throw error;
        }
        let raw: unknown;
        try {
          raw = parseYaml(content);
        } catch {
          continue;
        }
        if (
          typeof raw === "object" && raw !== null &&
          (raw as { name?: unknown }).name === name
        ) {
          found.push(path);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    return found;
  }

  async findAllByType(vaultType: string): Promise<VaultConfig[]> {
    const dir = this.getTypeDir(vaultType);
    const configs: VaultConfig[] = [];

    try {
      for (const path of await this.yamlFilesSorted(dir)) {
        const content = await Deno.readTextFile(path);
        const data = this.parseVaultConfig(content, path);
        configs.push(VaultConfig.fromData(data));
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return configs;
  }

  async findAll(): Promise<VaultConfig[]> {
    const vaultDir = this.getVaultDir();
    const configs: VaultConfig[] = [];

    try {
      for (const path of await this.yamlFilesSorted(vaultDir)) {
        const content = await Deno.readTextFile(path);
        const data = this.parseVaultConfig(content, path);
        configs.push(VaultConfig.fromData(data));
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return configs;
  }

  async save(config: VaultConfig): Promise<void> {
    const dir = this.getTypeDir(config.type);
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const path = this.getPath(config.type, config.id);

    const isNew = !(await this.exists(path));

    const data = config.toData();
    const content = stringifyYaml(data as unknown as Record<string, unknown>);
    return await withChangeSignalled(this.markDirty, { kind: "write", path }, {
      typed: true,
    }, async () => {
      // On v3, the file the save replaces: an edit's precondition, and the
      // name that tells a rename apart (the path is by id, not name).
      const prior = typedStagingActive(this.markDirty)
        ? await readPriorFile(path)
        : undefined;
      await atomicWriteTextFile(path, content);
      await this.stageSave(config, path, content, prior);

      if (this.eventBus) {
        const event = isNew
          ? createVaultCreated(config.id, config.type, config.name)
          : createVaultUpdated(config.id, config.type, config.name);
        await this.eventBus.publish(event);
      }
    });
  }

  async delete(config: VaultConfig): Promise<void> {
    const path = this.getPath(config.type, config.id);
    return await withChangeSignalled(this.markDirty, { kind: "remove", path }, {
      typed: true,
    }, async () => {
      const prior = typedStagingActive(this.markDirty)
        ? await readPriorFile(path)
        : undefined;
      let removed = false;
      try {
        await Deno.remove(path);
        removed = true;

        if (this.eventBus) {
          const event = createVaultDeleted(config.id, config.type, config.name);
          await this.eventBus.publish(event);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
      if (!typedStagingActive(this.markDirty)) return;
      for (
        const batch of definitionDeleteBatches({
          kind: "vault",
          id: config.id,
          name: config.name,
          removed: removed ? [path] : [],
          priors: prior === undefined ? new Map() : new Map([[path, prior]]),
          tierOf: (p) => this.stagingTierOf(p),
        })
      ) {
        await stageTyped(this.markDirty, () => batch);
      }
    });
  }

  /**
   * on v3 a save stages a create expecting the key absent, an edit expecting
   * the replaced digest, or a rename as two partitions; identical bytes stage
   * nothing; secrets never reach a typed change
   */
  private async stageSave(
    config: VaultConfig,
    path: string,
    content: string,
    prior: PriorFile | undefined,
  ): Promise<void> {
    if (!typedStagingActive(this.markDirty)) return;
    const bytes = new TextEncoder().encode(content);
    if (prior !== undefined && prior.sha256 === await sha256Hex(bytes)) return;
    for (
      const batch of definitionSaveBatches({
        kind: "vault",
        id: config.id,
        name: config.name,
        targetPath: path,
        content: bytes,
        removed: [],
        priors: prior === undefined ? new Map() : new Map([[path, prior]]),
        tierOf: (p) => this.stagingTierOf(p),
      })
    ) {
      await stageTyped(this.markDirty, () => batch);
    }
  }

  /** undefined for a repo-local vault config, which stages nothing */
  private stagingTierOf(path: string) {
    const tier = stagingTierOf(this.repoDir, [], path);
    return tier?.tier === "config" ? tier : undefined;
  }

  async existsByName(name: string): Promise<boolean> {
    const config = await this.findByName(name);
    return config !== null;
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
   * visits files sorted by name at each level so the same vault directory reads
   * identically on every filesystem; NotFound propagates
   */
  private async yamlFilesSorted(dir: string): Promise<string[]> {
    const paths: string[] = [];
    for await (
      const entry of walk(dir, {
        exts: [".yaml"],
        includeDirs: false,
      })
    ) {
      paths.push(entry.path);
    }
    return paths.sort(comparePathsBySegment);
  }

  private getVaultDir(): string {
    return this.baseDir;
  }

  private getTypeDir(vaultType: string): string {
    const vaultDir = this.getVaultDir();
    const result = join(vaultDir, vaultType);
    this.assertPathContained(result, vaultDir, `vaultType "${vaultType}"`);
    return result;
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

  getPath(vaultType: string, id: VaultConfigId): string {
    const typeDir = this.getTypeDir(vaultType);
    const path = join(typeDir, `${id}.yaml`);
    // The id names one file in the type directory, never a path elsewhere.
    if (resolve(dirname(path)) !== resolve(typeDir)) {
      throw new UserError(`Invalid vault id: ${id}`);
    }
    return path;
  }

  private parseVaultConfig(content: string, path: string): VaultConfigData {
    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch (error) {
      throw this.parseError(
        path,
        error instanceof Error ? error.message : String(error),
      );
    }
    const result = VaultConfigDataSchema.safeParse(raw);
    if (!result.success) {
      const reason = result.error.issues
        .map((issue) =>
          `${
            issue.path.length > 0 ? issue.path.join(".") : "(root)"
          }: ${issue.message}`
        )
        .join("; ");
      throw this.parseError(path, reason);
    }
    return result.data;
  }

  private parseError(path: string, reason: string): VaultConfigParseError {
    const segments = relative(this.getVaultDir(), path).split(SEPARATOR);
    const file = segments.pop() ?? "";
    const id = file.endsWith(".yaml") ? file.slice(0, -".yaml".length) : file;
    return new VaultConfigParseError(path, segments.join("/"), id, reason);
  }
}
