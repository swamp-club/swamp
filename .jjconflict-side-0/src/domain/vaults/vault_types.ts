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

import {
  type VaultTypeInfo,
  vaultTypeRegistry,
} from "./vault_type_registry.ts";

export type { VaultTypeInfo } from "./vault_type_registry.ts";

/**
 * Built-in vault type definitions.
 * Note: mock vault is intentionally excluded as it's for internal testing only.
 */
const BUILT_IN_VAULT_TYPES: VaultTypeInfo[] = [
  {
    type: "aws-sm",
    name: "AWS Secrets Manager",
    description:
      "Store and retrieve secrets using AWS Secrets Manager. Requires AWS credentials via IAM roles, environment variables, or AWS profiles.",
    isBuiltIn: true,
  },
  {
    type: "azure-kv",
    name: "Azure Key Vault",
    description:
      "Store and retrieve secrets using Azure Key Vault. Requires vault URL and Azure credentials via environment variables, managed identity, or Azure CLI.",
    isBuiltIn: true,
  },
  {
    type: "1password",
    name: "1Password",
    description:
      "Store and retrieve secrets using 1Password. Requires the 1Password CLI (op) and authentication via service account token, desktop app, or Connect Server.",
    isBuiltIn: true,
  },
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
 * Gets all available vault types.
 */
export function getVaultTypes(): VaultTypeInfo[] {
  return vaultTypeRegistry.getAll();
}

/**
 * Gets a vault type by its identifier.
 */
export function getVaultType(type: string): VaultTypeInfo | undefined {
  return vaultTypeRegistry.get(type);
}
