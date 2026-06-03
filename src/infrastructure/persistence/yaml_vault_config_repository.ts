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
import { join, resolve, SEPARATOR } from "@std/path";
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
import {
  createVaultCreated,
  createVaultDeleted,
  createVaultUpdated,
} from "../../domain/events/types.ts";

/**
 * YAML-based repository for vault configurations.
 *
 * Stores vault configs as YAML files in the directory structure:
 * {repoDir}/vaults/{vault-type}/{id}.yaml
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
    this.baseDir = baseDir ?? join(repoDir, "vaults");
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
   * Finds a vault config by name across all vault types.
   */
  async findByName(name: string): Promise<VaultConfig | null> {
    const vaultDir = this.getVaultDir();
    try {
      for await (
        const entry of walk(vaultDir, {
          exts: [".yaml"],
          includeDirs: false,
        })
      ) {
        const content = await Deno.readTextFile(entry.path);
        const data = this.parseVaultConfig(content, entry.path);
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
  private getPath(vaultType: string, id: VaultConfigId): string {
    return join(this.getTypeDir(vaultType), `${id}.yaml`);
  }

  /**
   * Parses YAML content and validates it against the VaultConfigData schema.
   * Throws a descriptive error if the YAML is malformed or missing required fields.
   */
  private parseVaultConfig(content: string, path: string): VaultConfigData {
    const raw = parseYaml(content);
    const result = VaultConfigDataSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `Invalid vault config in ${path}: ${result.error.message}`,
      );
    }
    return result.data;
  }
}
