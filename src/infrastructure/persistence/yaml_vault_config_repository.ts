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
  VaultConfig,
  type VaultConfigData,
  VaultConfigDataSchema,
  type VaultConfigId,
} from "../../domain/vaults/vault_config.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createVaultCreated,
  createVaultDeleted,
  createVaultUpdated,
} from "../../domain/events/types.ts";

/**
 * A vault config file that does not parse as YAML or does not match the vault
 * config schema. It names the file and how to repair it, and carries the vault
 * type and id derived from the file's location.
 */
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
  }
}

/**
 * YAML-based repository for vault configurations.
 *
 * Stores vault configs as YAML files in the directory structure:
 * {vaultsDir}/{vault-type}/{id}.yaml
 *
 * vaultsDir defaults to the effective vaults dir: {repoDir}/vaults, or the
 * datastore config tier's vaults/ when managedConfig is active.
 */
export class YamlVaultConfigRepository {
  private readonly eventBus: EventBus | null;
  private readonly baseDir: string;

  constructor(
    private readonly repoDir: string,
    eventBus?: EventBus,
    baseDir?: string,
  ) {
    this.eventBus = eventBus ?? null;
    this.baseDir = baseDir ?? resolveEffectiveVaultsDir(repoDir);
  }

  /**
   * Finds a vault config by its type and ID.
   */
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
   * Finds a vault config by name across all vault types. Files that do not
   * parse are skipped while a match may still come; vault names are unique,
   * so a parseable match is the vault. With no match, the first file that did
   * not parse is reported, since it may be the vault asked for.
   * `ignoreBrokenPath` names a file known not to parse (a vault being
   * repaired), which is then not reported.
   */
  async findByName(
    name: string,
    ignoreBrokenPath?: string,
  ): Promise<VaultConfig | null> {
    const vaultDir = this.getVaultDir();
    let parseError: VaultConfigParseError | null = null;
    try {
      for await (
        const entry of walk(vaultDir, {
          exts: [".yaml"],
          includeDirs: false,
        })
      ) {
        const content = await Deno.readTextFile(entry.path);
        let data: VaultConfigData;
        try {
          data = this.parseVaultConfig(content, entry.path);
        } catch (error) {
          if (!(error instanceof VaultConfigParseError)) throw error;
          if (
            ignoreBrokenPath === undefined ||
            resolve(error.path) !== resolve(ignoreBrokenPath)
          ) {
            parseError ??= error;
          }
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
   * Finds all vault configs of a specific type.
   */
  async findAllByType(vaultType: string): Promise<VaultConfig[]> {
    const dir = this.getTypeDir(vaultType);
    const configs: VaultConfig[] = [];

    try {
      for await (
        const entry of walk(dir, {
          exts: [".yaml"],
          includeDirs: false,
        })
      ) {
        const content = await Deno.readTextFile(entry.path);
        const data = this.parseVaultConfig(content, entry.path);
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

  /**
   * Finds all vault configs across all types.
   */
  async findAll(): Promise<VaultConfig[]> {
    const vaultDir = this.getVaultDir();
    const configs: VaultConfig[] = [];

    try {
      for await (
        const entry of walk(vaultDir, {
          exts: [".yaml"],
          includeDirs: false,
        })
      ) {
        const content = await Deno.readTextFile(entry.path);
        const data = this.parseVaultConfig(content, entry.path);
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

  /**
   * Saves a vault config to the repository.
   */
  async save(config: VaultConfig): Promise<void> {
    const dir = this.getTypeDir(config.type);
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const path = this.getPath(config.type, config.id);

    // Check if this is a new vault or an update
    const isNew = !(await this.exists(path));

    const data = config.toData();
    const content = stringifyYaml(data as unknown as Record<string, unknown>);
    await atomicWriteTextFile(path, content);

    // Emit event
    if (this.eventBus) {
      const event = isNew
        ? createVaultCreated(config.id, config.type, config.name)
        : createVaultUpdated(config.id, config.type, config.name);
      await this.eventBus.publish(event);
    }
  }

  /**
   * Deletes a vault config from the repository.
   */
  async delete(config: VaultConfig): Promise<void> {
    const path = this.getPath(config.type, config.id);
    try {
      await Deno.remove(path);

      // Emit event
      if (this.eventBus) {
        const event = createVaultDeleted(config.id, config.type, config.name);
        await this.eventBus.publish(event);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  /**
   * Checks if a vault config exists by name.
   */
  async existsByName(name: string): Promise<boolean> {
    const config = await this.findByName(name);
    return config !== null;
  }

  /**
   * Checks if a file exists at the given path.
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
   * Gets the base vault directory.
   */
  private getVaultDir(): string {
    return this.baseDir;
  }

  /**
   * Gets the directory for a specific vault type.
   */
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

  /**
   * Gets the file path for a specific vault config.
   */
  getPath(vaultType: string, id: VaultConfigId): string {
    const typeDir = this.getTypeDir(vaultType);
    const path = join(typeDir, `${id}.yaml`);
    // The id names one file in the type directory, never a path elsewhere.
    if (resolve(dirname(path)) !== resolve(typeDir)) {
      throw new UserError(`Invalid vault id: ${id}`);
    }
    return path;
  }

  /**
   * Parses YAML content and validates it against the VaultConfigData schema.
   * Throws a VaultConfigParseError if the YAML is malformed or missing
   * required fields.
   */
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

  /**
   * Builds the parse error for a vault file, deriving the vault type (which
   * spans two directories for namespaced types) and id from its location.
   */
  private parseError(path: string, reason: string): VaultConfigParseError {
    const segments = relative(this.getVaultDir(), path).split(SEPARATOR);
    const file = segments.pop() ?? "";
    const id = file.endsWith(".yaml") ? file.slice(0, -".yaml".length) : file;
    return new VaultConfigParseError(path, segments.join("/"), id, reason);
  }
}
