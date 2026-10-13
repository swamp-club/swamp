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

import { extractVaultFromSource } from "../extensions/extension_content_extractor.ts";
import { readDeclaredTypeMetadata } from "../extensions/declared_type_metadata.ts";
import {
  type VaultTypeInfo,
  type VaultTypeRegistry,
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
 * Lists every vault type the way it declares itself, for type search.
 *
 * A lazy entry carries no declared name, so {@link getVaultTypes} can only
 * show its type id (swamp-club#3365). This reads the name and description
 * out of the entry's source text instead of importing its bundle: a listing
 * must not run extension code, which can exit, hang or print at import. A
 * source that cannot be read, or that computes its name, keeps the type id.
 */
export async function listVaultTypes(
  registry: VaultTypeRegistry = vaultTypeRegistry,
  readSource?: (path: string) => Promise<string>,
): Promise<VaultTypeInfo[]> {
  const loaded = registry.getAll();
  const loadedKeys = new Set(loaded.map((t) => t.type.toLowerCase()));

  const lazy = await Promise.all(
    registry.getAllLazy()
      .filter((entry) => !loadedKeys.has(entry.type.toLowerCase()))
      .map(async (entry) => {
        const declared = await readDeclaredTypeMetadata(
          entry,
          extractVaultFromSource,
          readSource,
        );
        return {
          type: entry.type,
          name: declared?.name || entry.type,
          description: declared?.description || (entry.description ?? ""),
          isBuiltIn: false,
        };
      }),
  );

  return [...loaded, ...lazy];
}

/**
 * Gets a vault type by its identifier.
 */
export function getVaultType(type: string): VaultTypeInfo | undefined {
  return vaultTypeRegistry.get(type);
}
