import type { ModelOutput } from "../models/model_output.ts";
import type { ModelType } from "../models/model_type.ts";
import type { Definition, InputsSchema } from "../definitions/definition.ts";
import type { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { ModelNotFoundError } from "./errors.ts";
import { VaultService } from "../vaults/vault_service.ts";

/**
 * Builds env context from Deno environment variables.
 */
export function buildEnvContext(): Record<string, string> {
  return { ...Deno.env.toObject() };
}

/**
 * Data about a single model for CEL context.
 */
export interface ModelData {
  input: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
    attributes: Record<string, unknown>;
  };
  definition?: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
    attributes: Record<string, unknown>;
    inputs?: InputsSchema;
  };
  resource?: {
    id: string;
    version: number;
    createdAt: string;
    attributes: Record<string, unknown>;
  };
  data?: {
    id: string;
    version: number;
    createdAt: string;
    attributes: Record<string, unknown>;
  };
  file?: {
    id: string;
    version: number;
    createdAt: string;
    filename: string;
    contentType: string;
    size: number;
    checksum: string;
    path: string;
  };
  log?: {
    id: string;
    version: number;
    createdAt: string;
    entries: Array<{
      message: string;
    }>;
  };
  execution?: {
    id: string;
    methodName: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    error?: { message: string; stack?: string };
  };
}

/**
 * Context for evaluating CEL expressions.
 */
export interface ExpressionContext {
  /** Map of model name/UUID to model data */
  model: Record<string, ModelData>;
  /** Self-reference for the current input being evaluated */
  self?: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
    attributes: Record<string, unknown>;
  };
  /** Input values provided when instantiating a definition */
  inputs?: Record<string, unknown>;
  /** Workflow context (for workflow evaluation) */
  workflow?: Record<string, unknown>;
  /** Vault operations for secure secret access */
  vault?: {
    get(vaultName: string, secretKey: string): string;
  };
  /** Environment variables */
  env: Record<string, string>;
  /** Index signature for CEL evaluator compatibility */
  [key: string]: unknown;
}

/**
 * Configuration for optional repositories and services.
 */
export interface ModelResolverRepositories {
  outputRepo?: YamlOutputRepository;
  /** Optional vault service for dependency injection (useful for testing) */
  vaultService?: VaultService;
  /** Repository directory for lazy loading vault configurations */
  repoDir?: string;
}

/**
 * Resolves model references to build CEL evaluation context.
 */
export class ModelResolver {
  private readonly outputRepo?: YamlOutputRepository;
  private vaultService?: VaultService;
  private readonly repoDir?: string;
  private vaultServiceInitialized = false;

  constructor(
    private readonly definitionRepo: YamlDefinitionRepository,
    repos?: ModelResolverRepositories,
  ) {
    this.outputRepo = repos?.outputRepo;
    this.repoDir = repos?.repoDir;
    // If a vault service was provided, use it directly
    if (repos?.vaultService) {
      this.vaultService = repos.vaultService;
      this.vaultServiceInitialized = true;
    }
  }

  /**
   * Gets or lazily initializes the vault service.
   * If a VaultService was provided in the constructor, it's used directly.
   * Otherwise, vaults are loaded from the repository (if repoDir was provided).
   */
  private async getVaultService(): Promise<VaultService> {
    if (this.vaultServiceInitialized && this.vaultService) {
      return this.vaultService;
    }

    // Lazy initialization: load vaults from repository if repoDir is available
    if (this.repoDir) {
      this.vaultService = await VaultService.fromRepository(this.repoDir);
    } else {
      // No repoDir, create an empty vault service with defaults
      this.vaultService = new VaultService();
      this.vaultService.ensureDefaultVaults();
    }
    this.vaultServiceInitialized = true;
    return this.vaultService;
  }

  /**
   * Builds a complete expression context from all available models.
   *
   * @param selfDefinition - The definition currently being evaluated (for self reference)
   * @param selfType - The model type of the self definition
   * @returns The expression context
   */
  async buildContext(
    selfDefinition?: Definition,
    selfType?: ModelType,
  ): Promise<ExpressionContext> {
    const context: ExpressionContext = {
      model: {},
      env: buildEnvContext(),
    };

    // Load all definitions
    const allDefinitions = await this.definitionRepo.findAllGlobal();

    for (const { definition, type: _defType } of allDefinitions) {
      // Build model data from definition
      const modelData: ModelData = {
        input: {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          tags: definition.tags,
          attributes: definition.attributes,
        },
        definition: {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          tags: definition.tags,
          attributes: definition.attributes,
          inputs: definition.inputs,
        },
      };

      // Index by name
      context.model[definition.name] = modelData;
      // Also index by UUID for direct ID references
      context.model[definition.id] = modelData;
    }

    // Build self context if provided
    if (selfDefinition && selfType) {
      context.self = {
        id: selfDefinition.id,
        name: selfDefinition.name,
        version: selfDefinition.version,
        tags: selfDefinition.tags,
        attributes: selfDefinition.attributes,
      };
    }

    return context;
  }

  /**
   * Resolves a single model reference by name or ID.
   *
   * @param modelRef - The model name or UUID
   * @returns The definition and model type
   * @throws ModelNotFoundError if the model cannot be found
   */
  async resolveModel(modelRef: string): Promise<{
    definition: Definition;
    type: ModelType;
  }> {
    // Try by name first
    const byName = await this.definitionRepo.findByNameGlobal(modelRef);
    if (byName) {
      return {
        definition: byName.definition,
        type: byName.type,
      };
    }

    // Try by UUID - search across all types
    const allDefinitions = await this.definitionRepo.findAllGlobal();
    for (const { definition, type } of allDefinitions) {
      if (definition.id === modelRef) {
        return { definition, type };
      }
    }

    throw new ModelNotFoundError(modelRef);
  }

  /**
   * Updates the context with fresh output state for a specific model.
   *
   * @param context - The context to update
   * @param modelRef - The model name or UUID
   * @param output - The output state
   */
  updateOutputInContext(
    context: ExpressionContext,
    modelRef: string,
    output: ModelOutput,
  ): void {
    const modelData = context.model[modelRef];
    if (modelData) {
      modelData.execution = {
        id: output.id,
        methodName: output.methodName,
        status: output.status,
        startedAt: output.startedAt.toISOString(),
        completedAt: output.completedAt?.toISOString(),
        durationMs: output.durationMs,
        error: output.error,
      };
    }
  }

  /**
   * Updates the context with fresh definition data for a specific model.
   *
   * @param context - The context to update
   * @param modelRef - The model name or UUID
   * @param definition - The definition data
   */
  updateDefinitionInContext(
    context: ExpressionContext,
    modelRef: string,
    definition: Definition,
  ): void {
    const modelData = context.model[modelRef];
    if (modelData) {
      modelData.definition = {
        id: definition.id,
        name: definition.name,
        version: definition.version,
        tags: definition.tags,
        attributes: definition.attributes,
        inputs: definition.inputs,
      };
    }
  }

  /**
   * Resolves vault expressions in a string by evaluating vault.get() calls.
   *
   * @param value - The string that may contain vault expressions
   * @returns The string with vault expressions resolved to actual secret values
   */
  async resolveVaultExpressions(value: string): Promise<string> {
    // Pattern to match vault.get(vaultName, secretKey) expressions
    // Handles both quoted and unquoted arguments
    const vaultPattern =
      /vault\.get\(\s*(['"`]?)([^'"`\s,]+)\1\s*,\s*(['"`]?)([^'"`\s,]+)\3\s*\)/g;

    let resolvedValue = value;
    const matches = Array.from(value.matchAll(vaultPattern));

    if (matches.length === 0) {
      return resolvedValue;
    }

    // Get vault service (lazy initialization if needed)
    const vaultService = await this.getVaultService();

    for (const match of matches) {
      const [fullMatch, , vaultName, , secretKey] = match;
      try {
        const secretValue = await vaultService.get(vaultName, secretKey);
        // Escape special characters to prevent CEL parsing issues and injection attacks
        const escapedValue = secretValue
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r")
          .replace(/\t/g, "\\t");
        // Replace the entire vault.get(...) call with the escaped secret value wrapped in quotes for CEL
        resolvedValue = resolvedValue.replace(fullMatch, `"${escapedValue}"`);
      } catch (error) {
        throw new Error(
          `Failed to resolve vault expression ${fullMatch}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return resolvedValue;
  }
}
