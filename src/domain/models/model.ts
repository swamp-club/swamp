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

import { z } from "zod";
import { isZodSchemaLike } from "../zod_compat.ts";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import type { Logger } from "@logtape/logtape";
import { ModelType } from "./model_type.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import type { MethodExecutionEvent } from "./method_events.ts";
import { CalVer } from "./calver.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { DataQueryService } from "../data/data_query_service.ts";
import {
  type DataId,
  type DataMetadata,
  type GarbageCollectionPolicy,
  GarbageCollectionSchema,
  type Lifetime,
  LifetimeSchema,
  type OwnerDefinition,
} from "../data/mod.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { OutputRepository } from "./repositories.ts";
import type { DataRecord } from "../data/data_record.ts";

/**
 * Specification for a resource data output (JSON with Zod schema).
 * Resources are structured data validated against a schema.
 */
export interface ResourceOutputSpec {
  /** Human-readable description */
  description?: string;

  /** Zod schema — validates data on write, powers CEL hints */
  schema: z.ZodTypeAny;

  /** Lifetime policy */
  lifetime: Lifetime;

  /** Garbage collection policy */
  garbageCollection: GarbageCollectionPolicy;

  /** Tags applied to this data output (auto-includes type: "resource") */
  tags?: Record<string, string>;

  /** When true, all fields in this resource output are treated as sensitive */
  sensitiveOutput?: boolean;

  /** Vault name to use for sensitive fields (overrides field-level metadata) */
  vaultName?: string;
}

/**
 * Specification for a file data output (binary/text, including logs).
 * Files are unstructured content identified by content type.
 */
export interface FileOutputSpec {
  /** Human-readable description */
  description?: string;

  /** MIME type */
  contentType: string;

  /** Lifetime policy */
  lifetime: Lifetime;

  /** Garbage collection policy */
  garbageCollection: GarbageCollectionPolicy;

  /** For line-oriented streaming (logs) */
  streaming?: boolean;

  /** Tags applied to this data output (auto-includes type: "file") */
  tags?: Record<string, string>;
}

/**
 * Zod schema for resource output specification (used by user model loader).
 * Note: `schema` is validated as a ZodType instance at runtime.
 */
export const ResourceOutputSpecSchema = z.object({
  description: z.string().optional(),
  // Duck-typed so schemas from user-bundled zod instances validate.
  schema: z.custom<z.ZodTypeAny>(isZodSchemaLike),
  lifetime: LifetimeSchema,
  garbageCollection: GarbageCollectionSchema,
  tags: z.record(z.string(), z.string()).optional(),
  sensitiveOutput: z.boolean().optional(),
  vaultName: z.string().optional(),
});

/**
 * Zod schema for file output specification (used by user model loader).
 */
export const FileOutputSpecSchema = z.object({
  description: z.string().optional(),
  contentType: z.string(),
  lifetime: LifetimeSchema,
  garbageCollection: GarbageCollectionSchema,
  streaming: z.boolean().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

/**
 * Override spec defaults when writing a resource.
 */
export interface ResourceWriteOverrides {
  lifetime?: Lifetime;
  garbageCollection?: GarbageCollectionPolicy;
  tags?: Record<string, string>;
}

/**
 * Override spec defaults when creating a file writer.
 */
export interface FileWriterOverrides {
  contentType?: string;
  lifetime?: Lifetime;
  garbageCollection?: GarbageCollectionPolicy;
  streaming?: boolean;
  tags?: Record<string, string>;
}

/**
 * Context provided to method execution.
 */
export interface MethodContext {
  /**
   * Cancellation signal. Always present — simply never-aborted if the
   * caller doesn't need cancellation.
   */
  signal: AbortSignal;

  /**
   * The base directory for the repository (where data is stored).
   */
  repoDir: string;

  /**
   * The model type for this execution.
   */
  modelType: ModelType;

  /**
   * The model ID (definition ID) for this execution.
   */
  modelId: string;

  /**
   * Pre-validated global arguments from the definition.
   */
  globalArgs: Record<string, unknown>;

  /**
   * Definition metadata for the current execution.
   */
  definition: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };

  /**
   * The name of the method being executed.
   */
  methodName: string;

  /**
   * Optional factory for CloudControl clients (for testing).
   */
  cloudControlClientFactory?: () => CloudControlClient;

  /**
   * Repository for unified data storage.
   */
  dataRepository: UnifiedDataRepository;

  /**
   * Repository for definitions.
   */
  definitionRepository: DefinitionRepository;

  /**
   * Repository for tracking execution history.
   */
  outputRepository?: OutputRepository;

  /**
   * Optional vault service for storing sensitive field values.
   */
  vaultService?: VaultService;

  /**
   * Logger for emitting log messages. Category is set automatically.
   */
  logger: Logger;

  /**
   * Write a resource — validates against schema, serializes JSON, returns handle.
   */
  writeResource?: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: ResourceWriteOverrides,
  ) => Promise<DataHandle>;

  /**
   * Read a previously stored resource by instance name.
   * Returns the parsed JSON object, or null if no data exists.
   * Vault reference expressions are automatically resolved when a vault service is available.
   */
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;

  /**
   * Read data from another model by name.
   * Resolves the model name, reads all data (optionally filtered by spec name),
   * parses JSON content, and resolves vault references.
   * Returns an empty array if the model doesn't exist or has no data.
   */
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<DataRecord[]>;

  /**
   * Query data artifacts across all models using a CEL predicate.
   * Returns matching DataRecords, or projected values if select is provided.
   */
  queryData?: (
    predicate: string,
    select?: string,
  ) => Promise<DataRecord[] | unknown[]>;

  /**
   * Create a file writer — returns DataWriter for binary/streaming content.
   */
  createFileWriter?: (
    specName: string,
    name: string,
    overrides?: FileWriterOverrides,
  ) => DataWriter;

  /**
   * Optional secret redactor for stripping vault secrets from output.
   */
  redactor?: SecretRedactor;

  /**
   * Optional data query service for catalog-backed data access.
   */
  dataQueryService?: DataQueryService;

  /**
   * The execution driver type for this execution.
   * Defaults to "raw" (in-process) when not specified.
   */
  driver?: string;

  /**
   * Configuration for the execution driver.
   */
  driverConfig?: Record<string, unknown>;

  /**
   * Optional callback for emitting domain events during method execution.
   * Used for process output streaming, vault storage, schema warnings, etc.
   * Output lines are emitted as `{ type: "output", line, stream }` events.
   */
  onEvent?: (event: MethodExecutionEvent) => void;

  /**
   * Tags merged into every writer created during execution.
   * Used by workflow steps to inject workflow-specific tags.
   */
  tagOverrides?: Record<string, string>;

  /**
   * Runtime tags from --tag CLI flags.
   * Applied after specName and tagOverrides, before data output overrides.
   */
  runtimeTags?: Record<string, string>;

  /**
   * Data output overrides merged into every writer's options.
   * Used by workflow steps to override lifetime, gc, and tags per spec name.
   */
  dataOutputOverrides?: Array<{
    specName: string;
    lifetime?: Lifetime;
    garbageCollection?: GarbageCollectionPolicy;
    tags?: Record<string, string>;
    resolvedVarySuffix?: string;
  }>;

  /** Check names to skip during pre-flight checks. */
  skipCheckNames?: string[];
  /** Skip checks that have any of these labels. */
  skipCheckLabels?: string[];
  /** Skip all pre-flight checks. */
  skipAllChecks?: boolean;

  /** Report names to skip during post-run reports. */
  skipReportNames?: string[];
  /** Skip reports that have any of these labels. */
  skipReportLabels?: string[];
  /** Skip all post-run reports. */
  skipAllReports?: boolean;
  /** Only run these specific reports (inclusion filter). */
  reportNames?: string[];
  /** Only run reports matching these labels (inclusion filter). */
  reportLabels?: string[];

  /**
   * Vault secret bag containing sentinel-to-value mappings from runtime
   * expression resolution. Used by the shell model to pass secrets via
   * environment variables instead of embedding them in command strings.
   */
  vaultSecrets?: VaultSecretBag;

  /**
   * Pre-resolution method arguments containing sentinel tokens.
   * Used by the shell model to resolve vault secrets for shell safety.
   */
  unresolvedMethodArgs?: Record<string, unknown>;

  /**
   * Resolve a path to an asset declared in the extension's
   * `additionalFiles` manifest field. Returns an absolute filesystem path.
   * Throws if the model is not shipped as an extension, if `relPath` is
   * unsafe, or if the file does not exist. Error messages are mode-aware
   * (pulled vs source) to give actionable guidance.
   */
  extensionFile: (relPath: string) => string;
}

/**
 * Lightweight reference to data already written during method execution.
 * Value object — the content has already been persisted by a DataWriter.
 */
export interface DataHandle {
  /** Human-readable name of this data artifact. */
  name: string;
  /** The declared spec name (key in resources or files). */
  specName: string;
  /** Whether this handle is for a resource or file. */
  kind: "resource" | "file";
  /** Unique data ID. */
  dataId: DataId;
  /** Version number on disk. */
  version: number;
  /** Size in bytes. */
  size: number;
  /** Tags applied to the data. */
  tags: Record<string, string>;
  /** Metadata excluding auto-generated fields. */
  metadata: Omit<
    DataMetadata,
    "id" | "name" | "version" | "createdAt" | "size" | "checksum"
  >;
}

/**
 * Fully resolved options used internally by DefaultDataWriter.
 * All fields are required (resolved from spec + overrides).
 */
export interface ResolvedDataWriterOptions {
  name: string;
  specName: string;
  kind: "resource" | "file";
  contentType: string;
  lifetime: Lifetime;
  garbageCollection: GarbageCollectionPolicy;
  streaming?: boolean;
  tags: Record<string, string>;
  ownerDefinition?: OwnerDefinition;
}

/**
 * Domain service interface for writing data directly to disk during method execution.
 */
export interface DataWriter {
  /** The data ID assigned to this writer. */
  readonly dataId: DataId;
  /** The data name. */
  readonly name: string;

  /** Write all content at once. */
  writeAll(content: Uint8Array): Promise<DataHandle>;
  /** Write text content (encodes to UTF-8). */
  writeText(text: string): Promise<DataHandle>;
  /** Append a single line (streaming). */
  writeLine(line: string): Promise<void>;
  /** Pipe a stream to disk with optional line-by-line callbacks. */
  writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: { onLine?: (line: string) => void },
  ): Promise<DataHandle>;
  /** Get the file path for direct I/O. */
  getFilePath(): Promise<string>;
  /** Finalize a writer that used writeLine/getFilePath and return the handle. */
  finalize(): Promise<DataHandle>;
}

/**
 * Callbacks for DataWriter events.
 */
export interface DataWriterCallbacks {
  /** Called for each line written by writeLine or writeStream. */
  onLine?: (dataName: string, line: string) => void;
  /** Called for domain events during data operations (vault storage, schema warnings). */
  onEvent?: (event: MethodExecutionEvent) => void;
}

/**
 * Follow-up action to be executed after a method completes.
 */
export interface FollowUpAction {
  /**
   * Name of the method to call next.
   */
  methodName: string;

  /**
   * Delay before executing the follow-up action (in milliseconds).
   */
  delayMs?: number;

  /**
   * Maximum number of retries for this action.
   */
  maxRetries?: number;

  /**
   * Condition that must be met to continue with follow-up actions.
   * If this returns false, the workflow stops.
   * Receives the data handles from the previous method execution.
   */
  continueCondition?: (dataHandles: DataHandle[]) => boolean;
}

/**
 * Result of a method execution.
 */
export interface MethodResult {
  /**
   * Data handles referencing artifacts already persisted by DataWriter.
   */
  dataHandles?: DataHandle[];

  /**
   * Optional follow-up actions to execute.
   */
  followUpActions?: FollowUpAction[];
}

/**
 * Semantic kind of a model method.
 * Used to drive lifecycle behavior (e.g., deletion markers, fast-fail on deleted resources).
 */
export type MethodKind =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "list"
  | "action";

/**
 * Infers the semantic kind of a method from its name or explicit definition.
 *
 * @param methodName - The method name to infer from
 * @param definition - Optional method definition with explicit kind
 * @returns The inferred MethodKind, or undefined for unrecognized names
 */
export function inferMethodKind(
  methodName: string,
  definition?: { kind?: MethodKind },
): MethodKind | undefined {
  if (definition?.kind) {
    return definition.kind;
  }

  const lower = methodName.toLowerCase();

  if (lower === "create") return "create";
  if (
    lower === "get" || lower === "read" || lower === "describe" ||
    lower === "show"
  ) {
    return "read";
  }
  if (lower === "update" || lower === "patch") return "update";
  if (lower === "delete" || lower === "destroy" || lower === "remove") {
    return "delete";
  }
  if (lower === "list" || lower === "search" || lower === "find") return "list";

  return undefined;
}

/**
 * Result of a pre-flight check execution.
 */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

/**
 * Definition of a pre-flight check on a model.
 * Checks run automatically before mutating method execution.
 */
export interface CheckDefinition {
  description: string;
  labels?: string[];
  appliesTo?: string[];
  execute(context: MethodContext): Promise<CheckResult>;
}

/**
 * Returns true if the method kind is mutating (create/update/delete/action/undefined).
 * Read and list methods are non-mutating.
 */
export function isMutatingKind(kind: MethodKind | undefined): boolean {
  return kind !== "read" && kind !== "list";
}

/**
 * Definition of a model method.
 */
export interface MethodDefinition<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /**
   * Human-readable description of what the method does.
   */
  description: string;

  /**
   * Semantic kind of this method (create, read, update, delete, list, action).
   * When omitted, inferred from the method name by `inferMethodKind()`.
   */
  kind?: MethodKind;

  /**
   * Zod schema for validating per-method arguments.
   * Arguments are validated before execute() is called.
   */
  arguments: TArgs;

  /**
   * Executes the method with pre-validated arguments and context.
   *
   * @param args - Pre-validated method arguments (matches the `arguments` schema)
   * @param context - Execution context (includes globalArgs, definition metadata)
   * @returns The method result
   */
  execute(
    args: z.infer<TArgs>,
    context: MethodContext,
  ): Promise<MethodResult>;
}

/**
 * A version upgrade step that transforms definition attributes from one
 * version to the next.
 */
export interface VersionUpgrade {
  /** The CalVer version this upgrade produces (e.g., "2025.06.01.1") */
  toVersion: string;
  /** Human-readable description of what changed */
  description: string;
  /** Transform old attributes into new attributes */
  upgradeAttributes: (
    oldAttributes: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/**
 * Definition of a model type (the aggregate root).
 *
 * A model defines:
 * - Its type identifier
 * - Current version (CalVer format: YYYY.MM.DD.MICRO)
 * - Schema for validating definition attributes
 * - Data output specifications
 * - Available methods
 * - Optional upgrade chain for migrating definitions between versions
 */
export interface ModelDefinition<
  TGlobalArgs extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /**
   * The model type.
   */
  type: ModelType;

  /**
   * Current version of this model definition.
   * CalVer format: YYYY.MM.DD.MICRO (e.g., "2025.01.15.1")
   */
  version: string;

  /**
   * Optional Zod schema for validating global arguments shared across all methods.
   */
  globalArguments?: TGlobalArgs;

  /**
   * Resource output specifications — structured JSON data validated against a Zod schema.
   * Keys are spec names, values are full specifications.
   */
  resources?: Record<string, ResourceOutputSpec>;

  /**
   * File output specifications — binary or text content identified by MIME type.
   * Keys are spec names, values are full specifications.
   */
  files?: Record<string, FileOutputSpec>;

  /**
   * Available methods on this model.
   */
  methods: Record<string, MethodDefinition>;

  /**
   * Pre-flight checks that run before mutating method execution.
   * Keys are check names, values are check definitions.
   */
  checks?: Record<string, CheckDefinition>;

  /**
   * Names of standalone reports that are defaults for this model type.
   * Reports are registered independently via UserReportLoader.
   */
  reports?: string[];

  /**
   * Ordered list of upgrade functions for migrating definitions between versions.
   * Each entry transforms attributes from the previous version to `toVersion`.
   * Must be ordered chronologically by `toVersion`.
   * The last entry's `toVersion` must equal `version`.
   */
  upgrades?: VersionUpgrade[];

  /**
   * Lazily builds the self-contained bundle for out-of-process execution (e.g. Docker).
   * Called by the execution service when a non-raw driver is used. Memoizes its
   * result so multiple executions of the same model in one process only bundle once.
   */
  bundleSourceFactory?: () => Promise<string>;

  /**
   * Absolute filesystem root from which `additionalFiles` entries resolve at
   * runtime. Pulled mode: `.swamp/pulled-extensions/<name>/files`. Source
   * mode: the manifest's directory. Undefined for built-in model types and
   * for source-loaded directories without a `manifest.yaml`. The method
   * context's `extensionFile()` helper closes over this value.
   */
  extensionFilesRoot?: string;
}

/**
 * Metadata for a lazily-indexed model type. The type is known to exist
 * (from the bundle catalog) but its bundle has not been imported yet.
 * Holds just enough information for {@link ModelRegistry.types} and
 * {@link ModelRegistry.has} to work without importing bundles.
 */
export interface LazyModelEntry {
  type: ModelType;
  bundlePath: string;
  sourcePath: string;
  version: string;
}

/**
 * Registry of all known model definitions.
 *
 * Supports lazy loading of user extensions via {@link setLoader} and
 * {@link ensureLoaded}. Built-in types registered via {@link defineModel}
 * at import time are always available without calling ensureLoaded().
 *
 * With per-bundle lazy loading, the registry also tracks "lazy entries" —
 * types that are known to exist (from the bundle catalog) but whose bundles
 * have not been imported yet. {@link types} returns both loaded and lazy
 * entries. {@link get} only returns fully loaded definitions.
 */
export class ModelRegistry {
  private models = new Map<string, ModelDefinition>();
  private lazyTypes = new Map<string, LazyModelEntry>();
  private extensionLoader: (() => Promise<void>) | null = null;
  private extensionLoadPromise: Promise<void> | null = null;
  private extensionsLoaded = false;
  private typeLoadPromises = new Map<string, Promise<void>>();
  private typeLoader:
    | ((type: string) => Promise<void>)
    | null = null;

  /**
   * Configures the lazy loader for user extensions.
   * The loader will be invoked on the first call to {@link ensureLoaded}.
   * Call this once during CLI startup — it does not trigger loading.
   */
  setLoader(loader: () => Promise<void>): void {
    this.extensionLoader = loader;
  }

  /**
   * Configures the per-type loader for on-demand bundle imports.
   * Called by {@link ensureTypeLoaded} to import a single bundle.
   */
  setTypeLoader(loader: (type: string) => Promise<void>): void {
    this.typeLoader = loader;
  }

  /**
   * Registers a lazy model entry — a type known to exist from the bundle
   * catalog but not yet imported. Does nothing if the type is already
   * registered (either fully loaded or lazy).
   */
  registerLazy(entry: LazyModelEntry): void {
    const key = entry.type.normalized;
    if (this.models.has(key) || this.lazyTypes.has(key)) return;
    this.lazyTypes.set(key, entry);
  }

  /**
   * Returns true if a type is registered as lazy (not yet imported).
   */
  isLazy(type: string | ModelType): boolean {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    return this.lazyTypes.has(modelType.normalized);
  }

  /**
   * Ensures user extensions have been loaded into the registry.
   * On first call, invokes the loader set via {@link setLoader}.
   * Subsequent calls (including concurrent ones) return the cached promise.
   * No-op if no loader was configured (e.g. not in a swamp repo).
   */
  async ensureLoaded(): Promise<void> {
    if (this.extensionsLoaded) return;
    if (!this.extensionLoader) return;
    if (!this.extensionLoadPromise) {
      const loader = this.extensionLoader;
      this.extensionLoadPromise = loader().then(() => {
        this.extensionsLoaded = true;
      });
    }
    await this.extensionLoadPromise;
  }

  /**
   * Clears the extension-loaded flag so the next call to
   * {@link ensureLoaded} re-runs the configured loader. Used by commands
   * that can re-scan extensions at runtime (e.g. `swamp open` after
   * installing a new extension or switching repositories). Does not
   * clear already-registered models.
   */
  resetLoadedFlag(): void {
    this.extensionsLoaded = false;
    this.extensionLoadPromise = null;
  }

  /**
   * Ensures a specific model type's bundle has been imported.
   * If the type is lazy, invokes the type loader to import just that bundle
   * (and any extensions targeting it). Concurrent callers for the same type
   * share the same promise. No-op if the type is already fully loaded.
   */
  async ensureTypeLoaded(type: string | ModelType): Promise<void> {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;

    // Already fully loaded
    if (this.models.has(key)) return;

    // Not known at all — nothing to load
    if (!this.lazyTypes.has(key)) return;

    // No type loader configured — fall back to full load
    if (!this.typeLoader) {
      await this.ensureLoaded();
      return;
    }

    // Deduplicate concurrent loads for the same type.
    // On rejection, remove the cached promise so subsequent calls retry
    // rather than permanently failing (e.g. transient I/O error).
    let promise = this.typeLoadPromises.get(key);
    if (!promise) {
      const loader = this.typeLoader;
      promise = loader(key).then(() => {
        // promoteFromLazy() already deleted the lazy entry during
        // the loader call, so no lazyTypes cleanup needed here.
        // Prune the resolved promise — it's no longer needed since
        // the type is now fully registered in this.models.
        this.typeLoadPromises.delete(key);
      }).catch((err) => {
        this.typeLoadPromises.delete(key);
        throw err;
      });
      this.typeLoadPromises.set(key, promise);
    }
    await promise;
  }

  /**
   * Promotes a lazy entry to a fully loaded definition.
   * Called by the type loader after importing a bundle.
   * The lazy entry is removed and the full definition is registered.
   */
  promoteFromLazy(model: ModelDefinition): void {
    const key = model.type.normalized;
    this.lazyTypes.delete(key);
    if (!this.models.has(key)) {
      this.register(model);
    }
  }

  /**
   * Registers a model definition.
   *
   * Validates CalVer version format and upgrade chain ordering.
   *
   * @param model - The model definition to register
   */
  register(model: ModelDefinition): void {
    const key = model.type.normalized;
    if (this.models.has(key)) {
      throw new Error(`Model type already registered: ${key}`);
    }

    // Validate CalVer version
    if (!CalVer.isValid(model.version)) {
      throw new Error(
        `Invalid CalVer version "${model.version}" for model type "${key}". ` +
          `Expected format YYYY.MM.DD.MICRO (e.g., "2025.01.15.1")`,
      );
    }

    // Validate upgrades if provided
    if (model.upgrades && model.upgrades.length > 0) {
      for (let i = 0; i < model.upgrades.length; i++) {
        const upgrade = model.upgrades[i];

        // Validate each toVersion is valid CalVer
        if (!CalVer.isValid(upgrade.toVersion)) {
          throw new Error(
            `Invalid CalVer version "${upgrade.toVersion}" in upgrade at index ${i} ` +
              `for model type "${key}"`,
          );
        }

        // Validate chronological ordering
        if (i > 0) {
          const prev = CalVer.create(model.upgrades[i - 1].toVersion);
          const curr = CalVer.create(upgrade.toVersion);
          if (CalVer.compare(prev, curr) >= 0) {
            throw new Error(
              `Upgrades for model type "${key}" are not in chronological order: ` +
                `"${prev.value}" must be before "${curr.value}"`,
            );
          }
        }
      }

      // Validate last upgrade's toVersion matches model version
      const lastUpgrade = model.upgrades[model.upgrades.length - 1];
      if (lastUpgrade.toVersion !== model.version) {
        throw new Error(
          `Last upgrade toVersion "${lastUpgrade.toVersion}" does not match model ` +
            `version "${model.version}" for model type "${key}"`,
        );
      }
    }

    this.models.set(key, model);
  }

  /**
   * Extends an existing model with additional methods and/or checks.
   * Creates a new merged ModelDefinition (immutable — doesn't mutate the existing object).
   *
   * @param type - The model type to extend (raw or normalized)
   * @param methods - Additional methods to add
   * @param checks - Optional additional checks to add
   * @throws If the target type is not registered
   * @throws If any method or check name conflicts with existing ones
   */
  extend(
    type: string | ModelType,
    methods: Record<string, MethodDefinition>,
    checks?: Record<string, CheckDefinition>,
    reports?: string[],
  ): void {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;
    const existing = this.models.get(key);

    if (!existing) {
      throw new Error(`Cannot extend unregistered model type: ${key}`);
    }

    // Check for method name conflicts
    for (const methodName of Object.keys(methods)) {
      if (existing.methods[methodName]) {
        throw new Error(
          `Method '${methodName}' already exists on model type '${key}'`,
        );
      }
    }

    // Check for check name conflicts
    if (checks) {
      for (const checkName of Object.keys(checks)) {
        if (existing.checks?.[checkName]) {
          throw new Error(
            `Check '${checkName}' already exists on model type '${key}'`,
          );
        }
      }
    }

    // Create a new merged ModelDefinition (immutable)
    const merged: ModelDefinition = {
      ...existing,
      methods: { ...existing.methods, ...methods },
      ...(checks || existing.checks
        ? { checks: { ...(existing.checks ?? {}), ...(checks ?? {}) } }
        : {}),
      ...(reports || existing.reports
        ? {
          reports: [
            ...(existing.reports ?? []),
            ...(reports ?? []),
          ],
        }
        : {}),
    };

    this.models.set(key, merged);
  }

  /**
   * Gets a model definition by type.
   *
   * @param type - The model type (raw or normalized)
   * @returns The model definition, or undefined if not found
   */
  get(type: string | ModelType): ModelDefinition | undefined {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    return this.models.get(modelType.normalized);
  }

  /**
   * Checks if a model type is registered (either fully loaded or lazy).
   *
   * @param type - The model type (raw or normalized)
   * @returns true if registered, false otherwise
   */
  has(type: string | ModelType): boolean {
    const modelType = typeof type === "string" ? ModelType.create(type) : type;
    const key = modelType.normalized;
    return this.models.has(key) || this.lazyTypes.has(key);
  }

  /**
   * Returns all registered model types (both fully loaded and lazy).
   *
   * Note: If user extensions have not been loaded or indexed via
   * {@link ensureLoaded}, this returns only built-in types.
   */
  types(): ModelType[] {
    const loaded = Array.from(this.models.values()).map((m) => m.type);
    const lazy = Array.from(this.lazyTypes.values())
      .filter((entry) => !this.models.has(entry.type.normalized))
      .map((entry) => entry.type);
    return [...loaded, ...lazy];
  }
}

/**
 * Global model registry instance.
 *
 * Uses globalThis so that the same registry is shared across module
 * boundaries (e.g., when a Vite bundle has its own copy of this module
 * but extension models were loaded outside the bundle).
 */
const MODEL_REGISTRY_KEY = "__swampModelRegistry";
// deno-lint-ignore no-explicit-any
export const modelRegistry: ModelRegistry = (globalThis as any)[
  MODEL_REGISTRY_KEY
] ??= new ModelRegistry();

/**
 * Defines and registers a model with the global registry.
 *
 * Use this function at module level to self-register models when the module is imported.
 * The barrel file (models.ts) imports all model files, triggering registration.
 *
 * @param definition - The model definition to register
 * @returns The same model definition (for re-export)
 */
export function defineModel<
  TGlobalArgs extends z.ZodTypeAny,
>(
  definition: ModelDefinition<TGlobalArgs>,
): ModelDefinition<TGlobalArgs> {
  if (!modelRegistry.has(definition.type)) {
    modelRegistry.register(definition);
  }
  return definition;
}
