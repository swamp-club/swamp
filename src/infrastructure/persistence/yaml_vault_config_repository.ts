import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import {
  VaultConfig,
  type VaultConfigData,
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
 * {repoDir}/.swamp/vault/{vault-type}/{id}.yaml
 */
export class YamlVaultConfigRepository {
  private readonly eventBus: EventBus | null;

  constructor(repoDir: string, eventBus?: EventBus);
  constructor(private readonly repoDir: string, eventBus?: EventBus) {
    this.eventBus = eventBus ?? null;
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
      const data = parseYaml(content) as VaultConfigData;
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
      for await (const typeEntry of Deno.readDir(vaultDir)) {
        if (!typeEntry.isDirectory) continue;

        const typeDir = join(vaultDir, typeEntry.name);
        for await (const entry of Deno.readDir(typeDir)) {
          if (entry.isFile && entry.name.endsWith(".yaml")) {
            const path = join(typeDir, entry.name);
            const content = await Deno.readTextFile(path);
            const data = parseYaml(content) as VaultConfigData;
            if (data.name === name) {
              return VaultConfig.fromData(data);
            }
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
   * Finds all vault configs of a specific type.
   */
  async findAllByType(vaultType: string): Promise<VaultConfig[]> {
    const dir = this.getTypeDir(vaultType);
    const configs: VaultConfig[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as VaultConfigData;
          configs.push(VaultConfig.fromData(data));
        }
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
      for await (const typeEntry of Deno.readDir(vaultDir)) {
        if (!typeEntry.isDirectory) continue;

        const typeDir = join(vaultDir, typeEntry.name);
        for await (const entry of Deno.readDir(typeDir)) {
          if (entry.isFile && entry.name.endsWith(".yaml")) {
            const path = join(typeDir, entry.name);
            const content = await Deno.readTextFile(path);
            const data = parseYaml(content) as VaultConfigData;
            configs.push(VaultConfig.fromData(data));
          }
        }
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
    await ensureDir(dir);

    const path = this.getPath(config.type, config.id);

    // Check if this is a new vault or an update
    const isNew = !(await this.exists(path));

    const data = config.toData();
    const content = stringifyYaml(data as unknown as Record<string, unknown>);
    await Deno.writeTextFile(path, content);

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
    return join(this.repoDir, ".swamp", "vault");
  }

  /**
   * Gets the directory for a specific vault type.
   */
  private getTypeDir(vaultType: string): string {
    return join(this.getVaultDir(), vaultType);
  }

  /**
   * Gets the file path for a specific vault config.
   */
  private getPath(vaultType: string, id: VaultConfigId): string {
    return join(this.getTypeDir(vaultType), `${id}.yaml`);
  }
}
