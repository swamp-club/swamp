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

import {
  type VaultTypeInfo,
  vaultTypeRegistry,
} from "./vault_type_registry.ts";

export type { VaultTypeInfo } from "./vault_type_registry.ts";

/**
 * Known renamed vault types and their current names.
 * Used by VaultService (for auto-remapping on load), the provider factory
 * (for helpful error messages), and libswamp operations (for early rejection).
 */
export const RENAMED_VAULT_TYPES: Record<string, string> = {
  "aws": "@swamp/aws-sm",
  "aws-sm": "@swamp/aws-sm",
  "azure": "@swamp/azure-kv",
  "azure-kv": "@swamp/azure-kv",
  "1password": "@swamp/1password",
};

/**
 * Built-in vault type definitions.
 * Note: mock vault is intentionally excluded as it's for internal testing only.
 */
const BUILT_IN_VAULT_TYPES: VaultTypeInfo[] = [
  {
    type: "local_encryption",
    name: "Local Encryption",
    description:
      "Store encrypted secrets in local files using AES-GCM encryption. Uses SSH private key or auto-generated key for encryption.",
    isBuiltIn: true,
  },
];

// Register built-in types on module load
for (const vaultType of BUILT_IN_VAULT_TYPES) {
  if (!vaultTypeRegistry.has(vaultType.type)) {
    vaultTypeRegistry.register(vaultType);
  }
}

/**
 * Gets all available vault types (both loaded and lazy).
 * Lazy types are synthesized from catalog metadata.
 */
export function getVaultTypes(): VaultTypeInfo[] {
  const loaded = vaultTypeRegistry.getAll();
  const loadedKeys = new Set(loaded.map((t) => t.type.toLowerCase()));

  const lazy = vaultTypeRegistry.getAllLazy()
    .filter((entry) => !loadedKeys.has(entry.type.toLowerCase()))
    .map((entry) => ({
      type: entry.type,
      name: entry.type,
      description: entry.description ?? "",
      isBuiltIn: false,
    }));

  return [...loaded, ...lazy];
}

/**
 * Gets a vault type by its identifier.
 */
export function getVaultType(type: string): VaultTypeInfo | undefined {
  return vaultTypeRegistry.get(type);
}
