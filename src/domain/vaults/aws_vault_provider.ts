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
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { VaultProvider } from "./vault_provider.ts";

/**
 * AWS Secrets Manager vault provider.
 */
export class AwsVaultProvider implements VaultProvider {
  private readonly client: SecretsManagerClient;
  private readonly name: string;

  constructor(name: string, config: { region?: string } = {}) {
    this.name = name;
    const region = config.region || Deno.env.get("AWS_REGION") || "us-east-1";

    this.client = new SecretsManagerClient({
      region,
      // Uses default AWS credential chain
    });
  }

  async get(secretKey: string): Promise<string> {
    const command = new GetSecretValueCommand({
      SecretId: secretKey,
    });

    const response = await this.client.send(command);

    // Get the secret value (could be SecretString or SecretBinary)
    const secretValue = response.SecretString ||
      (response.SecretBinary
        ? new TextDecoder().decode(response.SecretBinary)
        : "");

    if (!secretValue) {
      throw new Error(`Secret '${secretKey}' not found or has no value`);
    }

    return secretValue;
  }

  async put(secretKey: string, secretValue: string): Promise<void> {
    try {
      // Try to update existing secret first
      const putCommand = new PutSecretValueCommand({
        SecretId: secretKey,
        SecretString: secretValue,
      });
      await this.client.send(putCommand);
    } catch (error) {
      // If secret doesn't exist, create it
      if (error instanceof ResourceNotFoundException) {
        const createCommand = new CreateSecretCommand({
          Name: secretKey,
          SecretString: secretValue,
        });
        await this.client.send(createCommand);
      } else {
        throw error;
      }
    }
  }

  getName(): string {
    return this.name;
  }

  async list(): Promise<string[]> {
    const secretNames: string[] = [];
    let nextToken: string | undefined;

    do {
      const command = new ListSecretsCommand({
        NextToken: nextToken,
      });

      const response = await this.client.send(command);

      if (response.SecretList) {
        for (const secret of response.SecretList) {
          if (secret.Name) {
            secretNames.push(secret.Name);
          }
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return secretNames.sort();
  }
}
