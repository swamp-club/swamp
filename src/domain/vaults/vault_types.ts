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

/**
 * Represents a vault type with metadata for display.
 */
export interface VaultTypeInfo {
  /** The type identifier used in configuration */
  type: string;
  /** Human-readable name */
  name: string;
  /** Description of the vault type */
  description: string;
}

/**
 * Registry of available vault types.
 * Note: mock vault is intentionally excluded as it's for internal testing only.
 */
export const VAULT_TYPES: VaultTypeInfo[] = [
  {
    type: "aws",
    name: "AWS Secrets Manager",
    description:
      "Store and retrieve secrets using AWS Secrets Manager. Requires AWS credentials via IAM roles, environment variables, or AWS profiles.",
  },
  {
    type: "local_encryption",
    name: "Local Encryption",
    description:
      "Store encrypted secrets in local files using AES-GCM encryption. Uses SSH private key or auto-generated key for encryption.",
  },
];

/**
 * Gets all available vault types.
 */
export function getVaultTypes(): VaultTypeInfo[] {
  return VAULT_TYPES;
}

/**
 * Gets a vault type by its identifier.
 */
export function getVaultType(type: string): VaultTypeInfo | undefined {
  return VAULT_TYPES.find((v) => v.type === type.toLowerCase());
}
