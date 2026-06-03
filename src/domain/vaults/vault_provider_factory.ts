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

import type { VaultProvider } from "./vault_provider.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";
import { MockVaultProvider } from "./mock_vault_provider.ts";
import {
  type LocalEncryptionConfig,
  LocalEncryptionVaultProvider,
} from "./local_encryption_vault_provider.ts";
import { getVaultTypes, RENAMED_VAULT_TYPES } from "./vault_types.ts";

/**
 * Creates a VaultProvider instance for the given type, name, and config.
 *
 * Handles both built-in types (local_encryption, mock) and extension types
 * registered in the vault type registry. This factory is the single source
 * of truth for provider instantiation — used by VaultService.registerVault()
 * and the vault migrate operation.
 *
 * @throws Error if the type is unsupported or config validation fails
 */
export function createVaultProvider(
  type: string,
  name: string,
  config: Record<string, unknown>,
): VaultProvider {
  // Check registry for user-defined types with a createProvider factory
  const registeredType = vaultTypeRegistry.get(type);
  if (registeredType?.createProvider && !registeredType.isBuiltIn) {
    if (registeredType.configSchema) {
      const result = registeredType.configSchema.safeParse(config);
      if (!result.success) {
        throw new Error(
          `Invalid config for vault type '${type}' (vault '${name}'): ${result.error.message}`,
        );
      }
    }
    const provider = registeredType.createProvider(name, config);
    assertVaultProvider(provider, type, name);
    return provider;
  }

  // Built-in types
  switch (type.toLowerCase()) {
    case "mock":
      return new MockVaultProvider(
        name,
        config as Record<string, string>,
      );
    case "local_encryption":
      return new LocalEncryptionVaultProvider(
        name,
        config as LocalEncryptionConfig,
      );
    default: {
      const allTypes = vaultTypeRegistry.getAll().map((v) => v.type);
      throw new Error(
        `Unsupported vault type: '${type}' (vault '${name}').` +
          suggestVaultType(type, allTypes),
      );
    }
  }
}

/**
 * Validates that an object returned by a user-defined createProvider implements
 * the VaultProvider interface.
 */
function assertVaultProvider(
  obj: unknown,
  vaultType: string,
  vaultName: string,
): asserts obj is VaultProvider {
  const required: (keyof VaultProvider)[] = ["get", "put", "list", "getName"];
  const missing: string[] = [];
  for (const method of required) {
    if (
      typeof obj !== "object" || obj === null ||
      typeof (obj as Record<string, unknown>)[method] !== "function"
    ) {
      missing.push(method);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `createProvider for vault type '${vaultType}' (vault '${vaultName}') returned an invalid provider: ` +
        `missing methods: ${missing.join(", ")}. ` +
        `A VaultProvider must implement get, put, list, and getName.`,
    );
  }
}

function suggestVaultType(type: string, allTypes?: string[]): string {
  const normalized = type.toLowerCase();
  const renamed = RENAMED_VAULT_TYPES[normalized];
  if (renamed) {
    return ` The type '${type}' has been renamed to '${renamed}'. Update your vault configuration to use type: ${renamed}`;
  }
  const available = allTypes?.join(", ") ??
    getVaultTypes().map((v) => v.type).join(", ");
  return ` Available vault types: ${available}`;
}
