// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { z } from "zod";
import type { VaultProvider } from "./vault_provider.ts";

/**
 * Information about a registered vault type.
 */
export interface VaultTypeInfo {
  /** The type identifier (e.g., "aws-sm" or "@myorg/custom-vault") */
  type: string;
  /** Human-readable name */
  name: string;
  /** Description of the vault type */
  description: string;
  /** Zod schema for validating provider config (user-defined types only) */
  configSchema?: z.ZodTypeAny;
  /** Factory function to create a provider instance (user-defined types only) */
  createProvider?: (
    name: string,
    config: Record<string, unknown>,
  ) => VaultProvider;
  /** Whether this is a built-in vault type */
  isBuiltIn: boolean;
}

/**
 * Registry of available vault types (built-in and user-defined).
 * Map-backed singleton that allows registration and lookup by type identifier.
 */
export class VaultTypeRegistry {
  private readonly types = new Map<string, VaultTypeInfo>();

  /**
   * Registers a vault type. Throws if the type is already registered.
   */
  register(info: VaultTypeInfo): void {
    const key = info.type.toLowerCase();
    if (this.types.has(key)) {
      throw new Error(`Vault type '${info.type}' is already registered.`);
    }
    this.types.set(key, info);
  }

  /**
   * Gets a vault type by its identifier.
   */
  get(type: string): VaultTypeInfo | undefined {
    return this.types.get(type.toLowerCase());
  }

  /**
   * Returns all registered vault types.
   */
  getAll(): VaultTypeInfo[] {
    return Array.from(this.types.values());
  }

  /**
   * Checks if a vault type is registered.
   */
  has(type: string): boolean {
    return this.types.has(type.toLowerCase());
  }
}

/** Global vault type registry singleton. */
export const vaultTypeRegistry = new VaultTypeRegistry();
