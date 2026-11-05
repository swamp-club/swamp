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

import { SecretNotFoundError } from "./secret_not_found_error.ts";
import type {
  VaultDeleteProvider,
  VaultExistenceProvider,
  VaultProvider,
  VaultPutOptions,
} from "./vault_provider.ts";

export class MockVaultProvider
  implements VaultProvider, VaultDeleteProvider, VaultExistenceProvider {
  private readonly secrets = new Map<string, string>();
  private readonly name: string;

  constructor(name: string, secrets: Record<string, string> = {}) {
    this.name = name;

    this.secrets.set("demo-api-key", "super-secret-api-key-12345");
    this.secrets.set("demo-api-key-2", "another-secret-value-67890");
    this.secrets.set("derived-api-key", "derived-secret-value");

    for (const [key, value] of Object.entries(secrets)) {
      this.secrets.set(key, value);
    }
  }

  get(secretKey: string): Promise<string> {
    const secret = this.secrets.get(secretKey);
    if (secret === undefined) {
      return Promise.reject(
        new SecretNotFoundError(this.name, secretKey, {
          message:
            `Secret '${secretKey}' not found in mock vault '${this.name}'`,
        }),
      );
    }
    return Promise.resolve(secret);
  }

  put(
    secretKey: string,
    secretValue: string,
    _options?: VaultPutOptions,
  ): Promise<void> {
    this.secrets.set(secretKey, secretValue);
    return Promise.resolve();
  }

  getName(): string {
    return this.name;
  }

  list(): Promise<string[]> {
    return Promise.resolve(Array.from(this.secrets.keys()).sort());
  }

  delete(secretKey: string): Promise<void> {
    if (!this.secrets.has(secretKey)) {
      return Promise.reject(
        new SecretNotFoundError(this.name, secretKey, {
          message:
            `Secret '${secretKey}' not found in mock vault '${this.name}'`,
        }),
      );
    }
    this.secrets.delete(secretKey);
    return Promise.resolve();
  }

  has(secretKey: string): Promise<boolean> {
    return Promise.resolve(this.secrets.has(secretKey));
  }

  addSecret(key: string, value: string): void {
    this.secrets.set(key, value);
  }

  listSecrets(): string[] {
    return Array.from(this.secrets.keys());
  }
}
