/**
 * Unique identifier for a vault configuration.
 */
export type VaultConfigId = string;

/**
 * Creates a vault config ID from a string.
 */
export function createVaultConfigId(id: string): VaultConfigId {
  return id;
}

/**
 * Data structure for vault configuration stored in YAML files.
 */
export interface VaultConfigData {
  id: VaultConfigId;
  name: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string;
}

/**
 * Domain model for a vault configuration.
 */
export class VaultConfig {
  private constructor(
    public readonly id: VaultConfigId,
    public readonly name: string,
    public readonly type: string,
    public readonly config: Record<string, unknown>,
    public readonly createdAt: Date,
  ) {}

  /**
   * Creates a new VaultConfig instance.
   */
  static create(
    id: VaultConfigId,
    name: string,
    type: string,
    config: Record<string, unknown>,
  ): VaultConfig {
    return new VaultConfig(id, name, type, config, new Date());
  }

  /**
   * Reconstructs a VaultConfig from persisted data.
   */
  static fromData(data: VaultConfigData): VaultConfig {
    return new VaultConfig(
      data.id,
      data.name,
      data.type,
      data.config,
      new Date(data.createdAt),
    );
  }

  /**
   * Converts the VaultConfig to a data object for persistence.
   */
  toData(): VaultConfigData {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      config: this.config,
      createdAt: this.createdAt.toISOString(),
    };
  }
}
