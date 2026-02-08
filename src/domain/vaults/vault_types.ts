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
