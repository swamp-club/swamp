import { z } from "zod";
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";
import type { Definition } from "../../definitions/definition.ts";
import { VaultService } from "../../vaults/vault_service.ts";
import { YamlVaultConfigRepository } from "../../../infrastructure/persistence/yaml_vault_config_repository.ts";

/**
 * Schema for vault model input attributes.
 */
export const VaultInputAttributesSchema = z.object({
  vaultName: z.string().min(1).describe("Name of the vault to use"),
  secretKey: z.string().min(1).describe("Key identifier for the secret"),
  secretValue: z.string().optional().meta({
    description: "Value to store in vault (for put operations)",
    sensitive: true,
  }),
  operation: z.enum(["get", "put"]).describe("Operation to perform"),
});

/**
 * Type for vault model input attributes.
 */
export type VaultInputAttributes = z.infer<typeof VaultInputAttributesSchema>;

/**
 * Schema for vault model data attributes.
 */
export const VaultDataAttributesSchema = z.object({
  vaultName: z.string(),
  secretKey: z.string(),
  operation: z.string(),
  secretLength: z.number().optional().describe(
    "Length of retrieved secret (for get operations, without exposing the value)",
  ),
  storedKey: z.string().optional().describe(
    "Key where value was stored (for put operations)",
  ),
  timestamp: z.string().datetime(),
  success: z.boolean(),
  error: z.string().optional(),
});

/**
 * Type for vault model data attributes.
 */
export type VaultDataAttributes = z.infer<typeof VaultDataAttributesSchema>;

/**
 * The vault model type identifier.
 */
export const VAULT_MODEL_TYPE = ModelType.create("swamp/lets-get-sensitive");

/**
 * Creates and configures the vault service with the current repository context.
 * Loads vault configurations from .swamp/vault/{type}/{id}.yaml files.
 */
async function createVaultService(
  context: MethodContext,
): Promise<VaultService> {
  const vaultService = new VaultService();

  // Load vault configurations from the repository
  try {
    const vaultRepo = new YamlVaultConfigRepository(context.repoDir);
    const vaultConfigs = await vaultRepo.findAll();

    for (const vaultConfig of vaultConfigs) {
      vaultService.registerVault({
        name: vaultConfig.name,
        type: vaultConfig.type,
        config: vaultConfig.config,
      });
    }
  } catch (error) {
    // Log at debug level for troubleshooting, but don't fail
    // Vault service will provide helpful error messages when vaults are accessed
    console.debug(
      `[vault] Could not load vault configuration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Ensure default vaults are set up if needed
  vaultService.ensureDefaultVaults();

  return vaultService;
}

/**
 * Executes the "get" method for the vault model.
 *
 * Retrieves a secret value from the specified vault.
 */
async function executeGet(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = VaultInputAttributesSchema.parse(definition.attributes);

  if (attrs.operation !== "get") {
    throw new Error("Get method requires operation to be 'get'");
  }

  // Build log content
  const logLines: string[] = [];
  logLines.push(
    `[vault] Starting secret retrieval from vault '${attrs.vaultName}'`,
  );
  logLines.push(`[vault] Secret key: ${attrs.secretKey}`);

  try {
    const vaultService = await createVaultService(context);
    logLines.push(
      `[vault] Created VaultService for repository: ${context.repoDir}`,
    );

    logLines.push(`[vault] Retrieving secret from vault '${attrs.vaultName}'`);
    const retrievedValue = await vaultService.get(
      attrs.vaultName,
      attrs.secretKey,
    );

    logLines.push(
      `[vault] ✅ Secret retrieved successfully (length: ${retrievedValue.length} characters)`,
    );

    const dataAttributes = {
      vaultName: attrs.vaultName,
      secretKey: attrs.secretKey,
      operation: attrs.operation,
      // retrievedValue is NOT stored in data attributes for security
      // Secret values should only be accessed through vault expressions
      secretLength: retrievedValue.length,
      timestamp: new Date().toISOString(),
      success: true,
    };

    const definitionHash = await definition.computeHash();

    return {
      dataOutputs: [
        {
          name: `${definition.name}-result`,
          content: new TextEncoder().encode(JSON.stringify(dataAttributes)),
          metadata: {
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 10,
            streaming: false,
            tags: { type: "data" },
            ownerDefinition: {
              definitionHash,
              ownerType: "model-method",
              ownerRef: "get",
            },
          },
        },
        {
          name: `${definition.name}-audit-log`,
          content: new TextEncoder().encode(logLines.join("\n")),
          metadata: {
            contentType: "text/plain",
            lifetime: "infinite",
            garbageCollection: 10,
            streaming: true,
            tags: { type: "log" },
            ownerDefinition: {
              definitionHash,
              ownerType: "model-method",
              ownerRef: "get",
            },
          },
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logLines.push(`[vault] ❌ Failed to retrieve secret: ${errorMessage}`);

    // Throw exception instead of returning failed data - this will fail the workflow
    throw new Error(
      `Failed to retrieve secret '${attrs.secretKey}' from vault '${attrs.vaultName}': ${errorMessage}`,
    );
  }
}

/**
 * Executes the "put" method for the vault model.
 *
 * Stores a secret value in the specified vault.
 */
async function executePut(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = VaultInputAttributesSchema.parse(definition.attributes);

  if (attrs.operation !== "put") {
    throw new Error("Put method requires operation to be 'put'");
  }

  if (!attrs.secretValue) {
    throw new Error("Put method requires secretValue to be provided");
  }

  // Build log content
  const logLines: string[] = [];
  logLines.push(
    `[vault] Starting secret storage in vault '${attrs.vaultName}'`,
  );
  logLines.push(`[vault] Secret key: ${attrs.secretKey}`);
  logLines.push(
    `[vault] Secret value length: ${attrs.secretValue.length} characters`,
  );

  try {
    const vaultService = await createVaultService(context);
    logLines.push(
      `[vault] Created VaultService for repository: ${context.repoDir}`,
    );

    logLines.push(`[vault] Storing secret in vault '${attrs.vaultName}'`);
    await vaultService.put(attrs.vaultName, attrs.secretKey, attrs.secretValue);
    logLines.push(`[vault] ✅ Secret stored successfully`);

    const dataAttributes = {
      vaultName: attrs.vaultName,
      secretKey: attrs.secretKey,
      operation: attrs.operation,
      storedKey: attrs.secretKey,
      timestamp: new Date().toISOString(),
      success: true,
    };

    const definitionHash = await definition.computeHash();

    return {
      dataOutputs: [
        {
          name: `${definition.name}-result`,
          content: new TextEncoder().encode(JSON.stringify(dataAttributes)),
          metadata: {
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 10,
            streaming: false,
            tags: { type: "data" },
            ownerDefinition: {
              definitionHash,
              ownerType: "model-method",
              ownerRef: "put",
            },
          },
        },
        {
          name: `${definition.name}-audit-log`,
          content: new TextEncoder().encode(logLines.join("\n")),
          metadata: {
            contentType: "text/plain",
            lifetime: "infinite",
            garbageCollection: 10,
            streaming: true,
            tags: { type: "log" },
            ownerDefinition: {
              definitionHash,
              ownerType: "model-method",
              ownerRef: "put",
            },
          },
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logLines.push(`[vault] ❌ Failed to store secret: ${errorMessage}`);

    // Throw exception instead of returning failed data - this will fail the workflow
    throw new Error(
      `Failed to store secret '${attrs.secretKey}' in vault '${attrs.vaultName}': ${errorMessage}`,
    );
  }
}

/**
 * The lets-get-sensitive model definition.
 *
 * A model for interacting with secure vaults to store and retrieve sensitive data.
 * Supports both get and put operations across multiple named vault configurations.
 *
 * Methods:
 * - get: Retrieve a secret value from a vault
 * - put: Store a secret value in a vault
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const vaultModel: ModelDefinition<
  typeof VaultInputAttributesSchema
> = defineModel({
  type: VAULT_MODEL_TYPE,
  version: 1,
  inputAttributesSchema: VaultInputAttributesSchema,
  methods: {
    get: {
      description: "Retrieve a secret value from the specified vault",
      inputAttributesSchema: z.object({
        vaultName: z.string().min(1),
        secretKey: z.string().min(1),
        operation: z.literal("get"),
      }),
      execute: executeGet,
    },
    put: {
      description: "Store a secret value in the specified vault",
      inputAttributesSchema: z.object({
        vaultName: z.string().min(1),
        secretKey: z.string().min(1),
        secretValue: z.string().min(1).meta({
          description: "Secret value to store",
          sensitive: true,
        }),
        operation: z.literal("put"),
      }),
      execute: executePut,
    },
  },
});
