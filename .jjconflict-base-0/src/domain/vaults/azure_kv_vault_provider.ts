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

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import type { VaultProvider } from "./vault_provider.ts";

/**
 * Configuration for the Azure Key Vault provider.
 */
export interface AzureKvVaultConfig {
  /** Azure Key Vault URL (e.g., https://myvault.vault.azure.net/) */
  vault_url: string;
  /** Optional prefix for all secret names */
  secret_prefix?: string;
}

/**
 * Azure Key Vault vault provider.
 *
 * Uses DefaultAzureCredential for authentication, which automatically tries
 * environment variables, managed identity, Azure CLI, and other credential sources.
 */
export class AzureKvVaultProvider implements VaultProvider {
  private readonly client: SecretClient;
  private readonly name: string;
  private readonly secretPrefix: string;

  constructor(name: string, config: AzureKvVaultConfig) {
    if (!config.vault_url) {
      throw new Error(
        "Azure Key Vault URL is required. Ensure vault_url is set in the vault configuration.",
      );
    }

    this.name = name;
    this.secretPrefix = config.secret_prefix ?? "";

    const credential = new DefaultAzureCredential();
    this.client = new SecretClient(config.vault_url, credential);
  }

  async get(secretKey: string): Promise<string> {
    const azureSecretName = this.toAzureSecretName(
      this.secretPrefix + secretKey,
    );
    const secret = await this.client.getSecret(azureSecretName);

    if (!secret.value) {
      throw new Error(
        `Secret '${secretKey}' in vault '${this.name}' has no value`,
      );
    }

    return secret.value;
  }

  async put(secretKey: string, secretValue: string): Promise<void> {
    const azureSecretName = this.toAzureSecretName(
      this.secretPrefix + secretKey,
    );
    await this.client.setSecret(azureSecretName, secretValue);
  }

  getName(): string {
    return this.name;
  }

  async list(): Promise<string[]> {
    const secretNames: string[] = [];

    for await (
      const secretProperties of this.client.listPropertiesOfSecrets()
    ) {
      if (secretProperties.name) {
        const name = this.fromAzureSecretName(secretProperties.name);
        if (this.secretPrefix && name.startsWith(this.secretPrefix)) {
          secretNames.push(name.slice(this.secretPrefix.length));
        } else if (!this.secretPrefix) {
          secretNames.push(name);
        }
      }
    }

    return secretNames.sort();
  }

  /**
   * Converts a swamp secret name to an Azure Key Vault compatible name.
   * Azure Key Vault secret names only allow alphanumeric characters and hyphens.
   * Forward slashes and underscores are converted to hyphens.
   */
  private toAzureSecretName(name: string): string {
    return name.replace(/[/_]/g, "-");
  }

  /**
   * Converts an Azure Key Vault secret name back to a swamp secret name.
   * This is a best-effort reverse of toAzureSecretName — names that were
   * originally created with hyphens will remain unchanged.
   */
  private fromAzureSecretName(name: string): string {
    return name;
  }
}
