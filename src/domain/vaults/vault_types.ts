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

export const RENAMED_VAULT_TYPES: Record<string, string> = {
  "aws": "@swamp/aws-sm",
  "aws-sm": "@swamp/aws-sm",
  "azure": "@swamp/azure-kv",
  "azure-kv": "@swamp/azure-kv",
  "1password": "@swamp/1password",
};

/** the mock vault is intentionally excluded; it is for internal testing only */
const BUILT_IN_VAULT_TYPES: VaultTypeInfo[] = [
  {
    type: "local_encryption",
    name: "Local Encryption",
    description:
      "Store encrypted secrets in local files using AES-GCM encryption. Uses SSH private key or auto-generated key for encryption.",
    isBuiltIn: true,
  },
];

for (const vaultType of BUILT_IN_VAULT_TYPES) {
  if (!vaultTypeRegistry.has(vaultType.type)) {
    vaultTypeRegistry.register(vaultType);
  }
}

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
 * reads name and description from the entry's source text instead of importing
 * its bundle, since a listing must not run extension code that can exit, hang
 * or print; unreadable or computed names keep the type id
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

export function getVaultType(type: string): VaultTypeInfo | undefined {
  return vaultTypeRegistry.get(type);
}
