import {
  GetSecretValueCommand,
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

  put(_secretKey: string, _secretValue: string): Promise<void> {
    // This is a read-only provider for expressions - put operations
    // are handled by the vault model itself
    throw new Error("Put operations not supported in expression context");
  }

  getName(): string {
    return this.name;
  }
}
