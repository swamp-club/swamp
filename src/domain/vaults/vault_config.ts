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

import { z } from "zod";

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
 * Zod schema for validating vault configuration data loaded from YAML files.
 */
export const VaultConfigDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  auditReads: z.boolean().optional(),
});

/**
 * Data structure for vault configuration stored in YAML files.
 */
export interface VaultConfigData {
  id: VaultConfigId;
  name: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string;
  auditReads?: boolean;
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
    public readonly auditReads: boolean,
  ) {}

  /**
   * Creates a new VaultConfig instance.
   */
  static create(
    id: VaultConfigId,
    name: string,
    type: string,
    config: Record<string, unknown>,
    auditReads?: boolean,
  ): VaultConfig {
    return new VaultConfig(
      id,
      name,
      type,
      config,
      new Date(),
      auditReads ?? false,
    );
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
      data.auditReads ?? false,
    );
  }

  /**
   * Converts the VaultConfig to a data object for persistence.
   */
  toData(): VaultConfigData {
    const data: VaultConfigData = {
      id: this.id,
      name: this.name,
      type: this.type,
      config: this.config,
      createdAt: this.createdAt.toISOString(),
    };
    if (this.auditReads) {
      data.auditReads = true;
    }
    return data;
  }
}
