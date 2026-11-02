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

export interface VaultPutOptions {
  tags?: Record<string, string>;
}

export interface VaultProvider {
  get(secretKey: string): Promise<string>;

  put(
    secretKey: string,
    secretValue: string,
    options?: VaultPutOptions,
  ): Promise<void>;

  list(): Promise<string[]>;

  getName(): string;
}

export interface VaultDeleteProvider {
  delete(secretKey: string): Promise<void>;
}

export function isVaultDeleteProvider(
  provider: unknown,
): provider is VaultDeleteProvider {
  if (typeof provider !== "object" || provider === null) return false;
  const obj = provider as Record<string, unknown>;
  return typeof obj.delete === "function";
}

/**
 * has() resolves true exactly when get would succeed, false for a missing key,
 * rejects with get's error when unauthorized, and never reads the value; a
 * provider that cannot do that must not implement it
 */
export interface VaultExistenceProvider {
  has(secretKey: string): Promise<boolean>;
}

export function isVaultExistenceProvider(
  provider: unknown,
): provider is VaultExistenceProvider {
  if (typeof provider !== "object" || provider === null) return false;
  const obj = provider as Record<string, unknown>;
  return typeof obj.has === "function";
}

export interface VaultConfiguration {
  name: string;
  type: string;
  config: Record<string, unknown>;
  auditReads?: boolean;
}
