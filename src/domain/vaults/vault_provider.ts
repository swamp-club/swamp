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

/**
 * Options for the VaultProvider.put() method.
 */
export interface VaultPutOptions {
  /** Provider-native tags to attach to the secret at creation time. */
  tags?: Record<string, string>;
}

/**
 * Interface for vault providers that can securely store and retrieve secrets.
 */
export interface VaultProvider {
  /**
   * Retrieves a secret value from the vault.
   *
   * @param secretKey - The key identifier for the secret
   * @returns The secret value
   * @throws Error if the secret cannot be retrieved
   */
  get(secretKey: string): Promise<string>;

  /**
   * Stores a secret value in the vault.
   *
   * @param secretKey - The key identifier for the secret
   * @param secretValue - The secret value to store
   * @param options - Optional settings including provider-native tags
   * @throws Error if the secret cannot be stored
   */
  put(
    secretKey: string,
    secretValue: string,
    options?: VaultPutOptions,
  ): Promise<void>;

  /**
   * Lists all secret keys in the vault.
   * Returns only the key names, not the secret values.
   *
   * @returns Array of secret key names
   */
  list(): Promise<string[]>;

  /**
   * Gets the name/type of this vault provider.
   */
  getName(): string;
}

/**
 * Optional interface for vault providers that support deleting secrets.
 * Separate from VaultProvider — providers opt in by implementing both.
 */
export interface VaultDeleteProvider {
  delete(secretKey: string): Promise<void>;
}

/**
 * Type guard to check if a vault provider supports secret deletion.
 */
export function isVaultDeleteProvider(
  provider: unknown,
): provider is VaultDeleteProvider {
  if (typeof provider !== "object" || provider === null) return false;
  const obj = provider as Record<string, unknown>;
  return typeof obj.delete === "function";
}

/**
 * Optional interface for vault providers that can answer whether a secret
 * exists without reading its value. Separate from VaultProvider — providers
 * opt in by implementing both.
 *
 * The contract of `has(secretKey)` is that `get(secretKey)` would succeed
 * under the same provider credentials:
 *
 * - It resolves `true` exactly when `get` would resolve, and `false` for a
 *   key that does not exist. Presence in a listing or a describe call is not
 *   enough: a key the credentials can list but not read is not `true`.
 * - When the caller is not authorized for the key, it rejects with the same
 *   error `get` raises, so a caller learns nothing from `has` that `get`
 *   would not tell it.
 * - It never reads the value. A provider whose API cannot answer without
 *   reading the value must not implement it; the typed-secrets existence
 *   check then falls back to one probe read per reference per run
 *   (design/enablers/typed-secrets.md Section 3.4).
 *
 * `assertVaultExistenceConformance` in `@swamp-club/swamp-testing` holds a
 * provider to this contract. Detection is by method name, as for the other
 * optional interfaces: any provider with a `has` method opts in, so one whose
 * `has` means something else (answering from a listing, say) must honor this
 * contract or rename the method.
 */
export interface VaultExistenceProvider {
  has(secretKey: string): Promise<boolean>;
}

/**
 * Type guard to check if a vault provider can answer existence checks.
 */
export function isVaultExistenceProvider(
  provider: unknown,
): provider is VaultExistenceProvider {
  if (typeof provider !== "object" || provider === null) return false;
  const obj = provider as Record<string, unknown>;
  return typeof obj.has === "function";
}

/**
 * Configuration for vault providers.
 */
export interface VaultConfiguration {
  /** Vault provider name */
  name: string;
  /** Vault provider type (e.g., 'aws', 'hashicorp', 'azure') */
  type: string;
  /** Provider-specific configuration */
  config: Record<string, unknown>;
  /** When true, secret reads are logged to the vault audit trail */
  auditReads?: boolean;
}
