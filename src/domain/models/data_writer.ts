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
import { getLogger } from "@logtape/logtape";
import { Data, isReservedDataName } from "../data/mod.ts";
import type { DataId, OwnerDefinition } from "../data/mod.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { ModelType } from "./model_type.ts";
import type { MethodExecutionEvent } from "./method_events.ts";
import type {
  DataHandle,
  DataWriter,
  DataWriterCallbacks,
  FileOutputSpec,
  FileWriterOverrides,
  ResolvedDataWriterOptions,
  ResourceOutputSpec,
  ResourceWriteOverrides,
} from "./model.ts";
import type { GarbageCollectionPolicy, Lifetime } from "../data/mod.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import {
  extractSensitiveFields,
  getNestedValue,
  type SensitiveFieldInfo,
  setNestedValue,
} from "./sensitive_field_extractor.ts";

const logger = getLogger(["swamp", "data-writer"]);

/**
 * Default implementation of the DataWriter domain service.
 *
 * Writes data directly to disk during method execution, returning
 * lightweight DataHandle references instead of buffering full content.
 */
export class DefaultDataWriter implements DataWriter {
  readonly dataId: DataId;
  readonly name: string;

  private readonly repo: UnifiedDataRepository;
  private readonly modelType: ModelType;
  private readonly modelId: string;
  private readonly options: ResolvedDataWriterOptions;
  private readonly callbacks: DataWriterCallbacks;

  private allocated: { version: number; contentPath: string } | null = null;
  private data: Data | null = null;
  private lineBuffer: string[] | null = null;
  private finalized = false;

  constructor(
    repo: UnifiedDataRepository,
    modelType: ModelType,
    modelId: string,
    options: ResolvedDataWriterOptions,
    callbacks: DataWriterCallbacks = {},
  ) {
    this.repo = repo;
    this.modelType = modelType;
    this.modelId = modelId;
    this.options = options;
    this.callbacks = callbacks;
    this.dataId = repo.nextId();
    this.name = options.name;
  }

  async writeAll(content: Uint8Array): Promise<DataHandle> {
    this.ensureNotFinalized();
    const data = this.createDataEntity();

    const saveResult = await this.repo.save(
      this.modelType,
      this.modelId,
      data,
      content,
    );

    this.finalized = true;
    return this.buildHandle(saveResult.version, content.length);
  }

  writeText(text: string): Promise<DataHandle> {
    return this.writeAll(new TextEncoder().encode(text));
  }

  async writeLine(line: string): Promise<void> {
    this.ensureNotFinalized();

    if (!this.allocated) {
      // First call: allocate version and create initial empty file
      const data = this.createDataEntity();
      this.data = data;
      this.allocated = await this.repo.allocateVersion(
        this.modelType,
        this.modelId,
        data,
      );
      // Write empty file to create it
      await Deno.writeFile(this.allocated.contentPath, new Uint8Array());
      this.lineBuffer = [];
    }

    // Append line
    const lineContent = line + "\n";
    const file = await Deno.open(this.allocated.contentPath, { append: true });
    try {
      await file.write(new TextEncoder().encode(lineContent));
    } finally {
      file.close();
    }

    this.lineBuffer!.push(line);

    // Invoke callback
    if (this.callbacks.onLine) {
      this.callbacks.onLine(this.name, line);
    }
  }

  async writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: { onLine?: (line: string) => void },
  ): Promise<DataHandle> {
    this.ensureNotFinalized();

    const data = this.createDataEntity();
    this.data = data;
    this.allocated = await this.repo.allocateVersion(
      this.modelType,
      this.modelId,
      data,
    );

    // Open file for writing
    const file = await Deno.open(this.allocated.contentPath, {
      write: true,
      create: true,
      truncate: true,
    });

    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Write raw bytes to file
        await file.write(value);

        // Decode for line callbacks if needed
        if (options?.onLine || this.callbacks.onLine) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");

          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i];
            options?.onLine?.(line);
            this.callbacks.onLine?.(this.name, line);
          }

          buffer = lines[lines.length - 1];
        }
      }

      // Process remaining buffer
      if (buffer && (options?.onLine || this.callbacks.onLine)) {
        options?.onLine?.(buffer);
        this.callbacks.onLine?.(this.name, buffer);
      }
    } finally {
      file.close();
    }

    return this.finalize();
  }

  async getFilePath(): Promise<string> {
    this.ensureNotFinalized();

    if (!this.allocated) {
      const data = this.createDataEntity();
      this.data = data;
      this.allocated = await this.repo.allocateVersion(
        this.modelType,
        this.modelId,
        data,
      );
    }

    return this.allocated.contentPath;
  }

  async finalize(): Promise<DataHandle> {
    this.ensureNotFinalized();

    if (!this.allocated || !this.data) {
      throw new Error(
        `DataWriter "${this.name}" has not been used — nothing to finalize`,
      );
    }

    const { size, checksum: _checksum } = await this.repo.finalizeVersion(
      this.modelType,
      this.modelId,
      this.data,
      this.allocated.version,
    );

    this.finalized = true;
    return this.buildHandle(this.allocated.version, size);
  }

  private get ownerDefinition(): OwnerDefinition {
    return this.options.ownerDefinition ?? {
      ownerType: "model-method",
      ownerRef: this.modelId,
    };
  }

  private createDataEntity(): Data {
    return Data.create({
      id: this.dataId,
      name: this.options.name,
      version: 1, // Will be updated by repo operations
      contentType: this.options.contentType,
      lifetime: this.options.lifetime,
      garbageCollection: this.options.garbageCollection,
      streaming: this.options.streaming ?? false,
      tags: this.options.tags,
      ownerDefinition: this.ownerDefinition,
    });
  }

  private buildHandle(version: number, size: number): DataHandle {
    return {
      name: this.options.name,
      specName: this.options.specName,
      kind: this.options.kind,
      dataId: this.dataId,
      version,
      size,
      tags: { ...this.options.tags },
      metadata: {
        contentType: this.options.contentType,
        lifetime: this.options.lifetime,
        garbageCollection: this.options.garbageCollection,
        streaming: this.options.streaming ?? false,
        tags: { ...this.options.tags },
        ownerDefinition: { ...this.ownerDefinition },
      },
    };
  }

  private ensureNotFinalized(): void {
    if (this.finalized) {
      throw new Error(
        `DataWriter "${this.name}" has already been finalized`,
      );
    }
  }
}

/**
 * Sanitizes a vault key by replacing characters that are invalid in vault
 * secret keys (path separators, `@`, `..`). Vault providers like
 * local_encryption map keys to filenames, so `/`, `\`, `..`, and null bytes
 * are rejected.
 *
 * Replaces `@` with empty string and `/` or `\` with `-`.
 */
export function sanitizeVaultKey(key: string): string {
  return key
    .replace(/@/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\.\./g, ".")
    .replace(/\0/g, "");
}

/**
 * Processes sensitive fields in resource data before persistence.
 *
 * For each field marked with `{ sensitive: true }` metadata in the schema
 * (or all fields when `sensitiveOutput` is true on the spec):
 * 1. Snapshots original values before any mutation
 * 2. Stores the actual value in the vault
 * 3. Replaces the value with a vault reference expression
 *
 * @param data - The resource data to process (mutated in place)
 * @param spec - The resource output specification
 * @param vaultService - The vault service for storing values
 * @param modelType - The model type (for vault key generation)
 * @param modelId - The model ID (for vault key generation)
 * @param methodName - The method name (for vault key generation)
 */
export async function processSensitiveResourceData(
  data: Record<string, unknown>,
  spec: ResourceOutputSpec,
  vaultService: VaultService,
  modelType: ModelType,
  modelId: string,
  methodName: string,
  callbacks?: DataWriterCallbacks,
): Promise<void> {
  const sensitiveFields = extractSensitiveFields(spec.schema);

  // If sensitiveOutput is true, add all top-level data keys not already marked
  if (spec.sensitiveOutput) {
    const existingPaths = new Set(sensitiveFields.map((f) => f.path));
    for (const key of Object.keys(data)) {
      if (!existingPaths.has(key)) {
        sensitiveFields.push({ path: key });
      }
    }
  }

  // Snapshot values before mutation and filter out undefined/null
  const snapshot = structuredClone(data);
  const fieldsWithValues: {
    field: SensitiveFieldInfo;
    originalValue: unknown;
  }[] = [];
  for (const field of sensitiveFields) {
    const value = getNestedValue(snapshot, field.path);
    if (value !== undefined && value !== null) {
      fieldsWithValues.push({ field, originalValue: value });
    }
  }

  if (fieldsWithValues.length === 0) {
    return;
  }

  // Validate vault availability
  const vaultNames = vaultService.getVaultNames();
  if (vaultNames.length === 0) {
    const fieldList = fieldsWithValues.map((f) => `'${f.field.path}'`).join(
      ", ",
    );
    throw new Error(
      `Cannot persist data: fields ${fieldList} are marked as sensitive ` +
        `but no vault is configured. Create a vault using: swamp vault create <type> <name>`,
    );
  }

  for (const { field, originalValue } of fieldsWithValues) {
    const targetVault = field.vaultName ?? spec.vaultName ?? vaultNames[0];
    const vaultKey = field.vaultKey ??
      sanitizeVaultKey(
        `${modelType.normalized}/${modelId}/${methodName}/${field.path}`,
      );

    const stringValue = typeof originalValue === "string"
      ? originalValue
      : JSON.stringify(originalValue);
    await vaultService.put(targetVault, vaultKey, stringValue);
    logger.debug(
      "Stored sensitive field '{fieldPath}' in vault '{vaultName}' with key '{vaultKey}'",
      { fieldPath: field.path, vaultName: targetVault, vaultKey },
    );
    callbacks?.onEvent?.({
      type: "vault_secret_stored",
      fieldPath: field.path,
      vaultName: targetVault,
      vaultKey,
    });

    const vaultRef = `\${{ vault.get('${targetVault}', '${vaultKey}') }}`;

    // Apply vault reference to data
    if (field.path.includes(".")) {
      setNestedValue(data, field.path, vaultRef);
    } else {
      data[field.path] = vaultRef;
    }
  }
}

/**
 * Creates a writeResource function bound to a specific execution context.
 *
 * The returned function validates data against the resource's Zod schema (warn on failure),
 * processes sensitive fields (storing values in vault and replacing with references),
 * serializes to JSON, writes via DefaultDataWriter, and returns a DataHandle.
 *
 * @param repo - The unified data repository
 * @param modelType - The model type
 * @param modelId - The model ID (definition ID)
 * @param resources - The model's declared resource output specifications
 * @param tagOverrides - Tags merged into every writer (e.g., workflow step tags)
 * @param dataOutputOverrides - Overrides for specific spec names
 * @param vaultService - Optional vault service for sensitive field storage
 * @param methodName - Method name for vault key generation
 * @returns A tuple of [writeResource, getHandles]
 */
export function createResourceWriter(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  resources: Record<string, ResourceOutputSpec>,
  tagOverrides?: Record<string, string>,
  dataOutputOverrides?: Array<{
    specName: string;
    lifetime?: Lifetime;
    garbageCollection?: GarbageCollectionPolicy;
    tags?: Record<string, string>;
    resolvedVarySuffix?: string;
  }>,
  definitionTags?: Record<string, string>,
  runtimeTags?: Record<string, string>,
  definitionName?: string,
  vaultService?: VaultService,
  methodName?: string,
  onEvent?: (event: MethodExecutionEvent) => void,
): {
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: ResourceWriteOverrides,
  ) => Promise<DataHandle>;
  getHandles: () => DataHandle[];
} {
  const handles: DataHandle[] = [];
  const writerLogger = getLogger([
    "swamp",
    "data-writer",
    ...(definitionName ? [definitionName] : []),
  ]);

  const writeResource = async (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: ResourceWriteOverrides,
  ): Promise<DataHandle> => {
    const spec = resources[specName];
    if (!spec) {
      const declared = Object.keys(resources).join(", ");
      throw new Error(
        `Undeclared resource spec '${specName}' in model '${modelType.normalized}'. ` +
          `Declared resource specs: ${declared || "(none)"}`,
      );
    }

    // Validate data against schema (warn on failure, don't throw)
    const validationResult = spec.schema.safeParse(data);
    if (!validationResult.success) {
      const formattedError = validationResult.error instanceof z.ZodError
        ? validationResult.error.issues.map((i: z.ZodIssue) =>
          `${i.message} at "${i.path.join(".")}"`
        ).join("; ")
        : String(validationResult.error);
      writerLogger.debug(
        "Resource '{specName}' (instance '{name}') data does not match schema: {error}",
        { specName, name, error: formattedError },
      );
      onEvent?.({
        type: "schema_validation_warning",
        specName,
        instanceName: name,
        error: formattedError,
      });
    }

    // Validate name is non-empty
    if (name.trim() === "") {
      throw new Error(
        `Resource name must be a non-empty string for spec '${specName}' ` +
          `in model '${modelType.normalized}'`,
      );
    }

    // Validate name is not reserved for internal use
    if (isReservedDataName(name)) {
      throw new Error(
        `Data name '${name}' is reserved for internal use in model '${modelType.normalized}'. ` +
          `Use a different name.`,
      );
    }

    let instanceName = name;

    // Resolve tags with full resolution chain:
    // 1. type auto-tag → 2. definition tags → 3. spec defaults →
    // 4. method overrides → 5. specName auto-tag → 6. workflow/tag overrides →
    // 7. runtime tags → 8. data output overrides
    const resolvedTags: Record<string, string> = {
      type: "resource",
      ...(definitionTags ?? {}),
      ...(spec.tags ?? {}),
      ...(overrides?.tags ?? {}),
    };

    // Auto-inject specName tag for findBySpec discovery
    resolvedTags["specName"] = specName;

    // Auto-inject modelName tag for orphan data recovery (issue #370)
    if (definitionName) {
      resolvedTags["modelName"] = definitionName;
    }

    // Apply global tag overrides (workflow step tags)
    if (tagOverrides) {
      Object.assign(resolvedTags, tagOverrides);
    }

    // Apply runtime tags (--tag flags)
    if (runtimeTags) {
      Object.assign(resolvedTags, runtimeTags);
    }

    // Resolve lifetime and gc with overrides
    let lifetime = overrides?.lifetime ?? spec.lifetime;
    let garbageCollection = overrides?.garbageCollection ??
      spec.garbageCollection;

    // Apply data output overrides for this spec name
    if (dataOutputOverrides) {
      const override = dataOutputOverrides.find(
        (o) => o.specName === specName,
      );
      if (override) {
        lifetime = override.lifetime ?? lifetime;
        garbageCollection = override.garbageCollection ?? garbageCollection;
        if (override.tags) {
          Object.assign(resolvedTags, override.tags);
        }
        // Apply vary suffix to produce composite instance names
        if (override.resolvedVarySuffix) {
          instanceName = `${instanceName}-${override.resolvedVarySuffix}`;
        }
      }
    }

    // Process sensitive fields before serialization
    if (vaultService && methodName) {
      await processSensitiveResourceData(
        data,
        spec,
        vaultService,
        modelType,
        modelId,
        methodName,
        { onEvent },
      );
    }

    const resolvedOptions: ResolvedDataWriterOptions = {
      name: instanceName,
      specName,
      kind: "resource",
      contentType: "application/json",
      lifetime,
      garbageCollection,
      tags: resolvedTags,
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: modelId,
        ...(tagOverrides?.["workflowRunId"]
          ? { workflowRunId: tagOverrides["workflowRunId"] }
          : {}),
        ...(tagOverrides?.["workflow"]
          ? { workflowName: tagOverrides["workflow"] }
          : {}),
        ...(tagOverrides?.["step"] ? { stepName: tagOverrides["step"] } : {}),
        ...(tagOverrides?.["source"] ? { source: tagOverrides["source"] } : {}),
      },
    };

    const writer = new DefaultDataWriter(
      repo,
      modelType,
      modelId,
      resolvedOptions,
    );

    const handle = await writer.writeText(JSON.stringify(data));
    handles.push(handle);
    return handle;
  };

  return { writeResource, getHandles: () => [...handles] };
}

/**
 * Regex matching vault expression strings produced by `processSensitiveResourceData()`.
 * Captures the vault name (group 1) and key (group 2).
 */
const VAULT_REF_REGEX =
  /^\$\{\{\s*vault\.get\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)\s*\}\}$/;

/**
 * Recursively walks an object/array and resolves any string values that match
 * the vault expression pattern `${{ vault.get('name', 'key') }}`.
 *
 * Resolved secret values are registered with the optional `redactor` to prevent
 * log leakage (mirrors the pattern in `model_resolver.ts`).
 *
 * @param data - The object to walk (mutated in place)
 * @param vaultService - The vault service for retrieving secrets
 * @param redactor - Optional secret redactor to register resolved values
 */
export async function resolveVaultRefsInData(
  data: Record<string, unknown>,
  vaultService: VaultService,
  redactor?: SecretRedactor,
): Promise<void> {
  await walkAndResolve(data, vaultService, redactor);
}

async function walkAndResolve(
  obj: unknown,
  vaultService: VaultService,
  redactor?: SecretRedactor,
): Promise<unknown> {
  if (typeof obj === "string") {
    const match = VAULT_REF_REGEX.exec(obj);
    if (match) {
      const [, vaultName, key] = match;
      const value = await vaultService.get(vaultName, key);
      redactor?.addSecret(value);
      return value;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      obj[i] = await walkAndResolve(obj[i], vaultService, redactor);
    }
    return obj;
  }

  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = await walkAndResolve(record[key], vaultService, redactor);
    }
    return record;
  }

  return obj;
}

/**
 * Creates a readResource function bound to a specific execution context.
 *
 * The returned function reads previously stored resource data by instance name,
 * returning the parsed JSON object or null if no data exists.
 * When a VaultService is provided, vault reference expressions are automatically
 * resolved to their original secret values.
 *
 * @param repo - The unified data repository
 * @param modelType - The model type
 * @param modelId - The model ID (definition ID)
 * @param vaultService - Optional vault service for resolving vault references
 * @param redactor - Optional secret redactor to register resolved secrets
 * @returns A readResource function
 */
export function createResourceReader(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  vaultService?: VaultService,
  redactor?: SecretRedactor,
): (
  instanceName: string,
  version?: number,
) => Promise<Record<string, unknown> | null> {
  return async (
    instanceName: string,
    version?: number,
  ): Promise<Record<string, unknown> | null> => {
    const content = await repo.getContent(
      modelType,
      modelId,
      instanceName,
      version,
    );
    if (!content || content.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(content));
    } catch {
      throw new Error(
        `Failed to parse stored data for instance '${instanceName}': content is not valid JSON`,
      );
    }
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      throw new Error(
        `Stored data for instance '${instanceName}' is not a JSON object`,
      );
    }
    const data = parsed as Record<string, unknown>;
    if (vaultService) {
      await resolveVaultRefsInData(data, vaultService, redactor);
    }
    return data;
  };
}

/**
 * Creates a createFileWriter function bound to a specific execution context.
 *
 * The returned function creates DefaultDataWriter instances for writing
 * binary/streaming file content.
 *
 * @param repo - The unified data repository
 * @param modelType - The model type
 * @param modelId - The model ID (definition ID)
 * @param files - The model's declared file output specifications
 * @param tagOverrides - Tags merged into every writer (e.g., workflow step tags)
 * @param dataOutputOverrides - Overrides for specific spec names
 * @param callbacks - Optional callbacks for streaming events
 * @returns A tuple of [createFileWriter, getHandles]
 */
export function createFileWriterFactory(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  files: Record<string, FileOutputSpec>,
  tagOverrides?: Record<string, string>,
  dataOutputOverrides?: Array<{
    specName: string;
    lifetime?: Lifetime;
    garbageCollection?: GarbageCollectionPolicy;
    tags?: Record<string, string>;
    resolvedVarySuffix?: string;
  }>,
  callbacks?: DataWriterCallbacks,
  definitionTags?: Record<string, string>,
  runtimeTags?: Record<string, string>,
  definitionName?: string,
): {
  createFileWriter: (
    specName: string,
    name: string,
    overrides?: FileWriterOverrides,
  ) => DataWriter;
  getHandles: () => DataHandle[];
} {
  const handles: DataHandle[] = [];
  const writers: DefaultDataWriter[] = [];

  const createFileWriter = (
    specName: string,
    name: string,
    overrides?: FileWriterOverrides,
  ): DataWriter => {
    const spec = files[specName];
    if (!spec) {
      const declared = Object.keys(files).join(", ");
      throw new Error(
        `Undeclared file spec '${specName}' in model '${modelType.normalized}'. ` +
          `Declared file specs: ${declared || "(none)"}`,
      );
    }

    // Validate name is non-empty
    if (name.trim() === "") {
      throw new Error(
        `File name must be a non-empty string for spec '${specName}' ` +
          `in model '${modelType.normalized}'`,
      );
    }

    // Validate name is not reserved for internal use
    if (isReservedDataName(name)) {
      throw new Error(
        `Data name '${name}' is reserved for internal use in model '${modelType.normalized}'. ` +
          `Use a different name.`,
      );
    }

    let instanceName = name;

    // Resolve tags with full resolution chain:
    // 1. type auto-tag → 2. definition tags → 3. spec defaults →
    // 4. method overrides → 5. specName auto-tag → 6. workflow/tag overrides →
    // 7. runtime tags → 8. data output overrides
    const resolvedTags: Record<string, string> = {
      type: "file",
      ...(definitionTags ?? {}),
      ...(spec.tags ?? {}),
      ...(overrides?.tags ?? {}),
    };

    // Auto-inject specName tag for findBySpec discovery
    resolvedTags["specName"] = specName;

    // Auto-inject modelName tag for orphan data recovery (issue #370)
    if (definitionName) {
      resolvedTags["modelName"] = definitionName;
    }

    // Apply global tag overrides (workflow step tags)
    if (tagOverrides) {
      Object.assign(resolvedTags, tagOverrides);
    }

    // Apply runtime tags (--tag flags)
    if (runtimeTags) {
      Object.assign(resolvedTags, runtimeTags);
    }

    // Resolve options with overrides
    const contentType = overrides?.contentType ?? spec.contentType;
    let lifetime = overrides?.lifetime ?? spec.lifetime;
    let garbageCollection = overrides?.garbageCollection ??
      spec.garbageCollection;
    const streaming = overrides?.streaming ?? spec.streaming;

    // Apply data output overrides for this spec name
    if (dataOutputOverrides) {
      const override = dataOutputOverrides.find(
        (o) => o.specName === specName,
      );
      if (override) {
        lifetime = override.lifetime ?? lifetime;
        garbageCollection = override.garbageCollection ?? garbageCollection;
        if (override.tags) {
          Object.assign(resolvedTags, override.tags);
        }
        // Apply vary suffix to produce composite instance names
        if (override.resolvedVarySuffix) {
          instanceName = `${instanceName}-${override.resolvedVarySuffix}`;
        }
      }
    }

    const resolvedOptions: ResolvedDataWriterOptions = {
      name: instanceName,
      specName,
      kind: "file",
      contentType,
      lifetime,
      garbageCollection,
      streaming,
      tags: resolvedTags,
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: modelId,
        ...(tagOverrides?.["workflowRunId"]
          ? { workflowRunId: tagOverrides["workflowRunId"] }
          : {}),
        ...(tagOverrides?.["workflow"]
          ? { workflowName: tagOverrides["workflow"] }
          : {}),
        ...(tagOverrides?.["step"] ? { stepName: tagOverrides["step"] } : {}),
        ...(tagOverrides?.["source"] ? { source: tagOverrides["source"] } : {}),
      },
    };

    const writer = new DefaultDataWriter(
      repo,
      modelType,
      modelId,
      resolvedOptions,
      callbacks,
    );
    writers.push(writer);

    // Wrap write methods to track handles
    const originalWriteAll = writer.writeAll.bind(writer);
    const originalWriteText = writer.writeText.bind(writer);
    const originalWriteStream = writer.writeStream.bind(writer);
    const originalFinalize = writer.finalize.bind(writer);

    writer.writeAll = async (content: Uint8Array) => {
      const handle = await originalWriteAll(content);
      handles.push(handle);
      return handle;
    };

    writer.writeText = async (text: string) => {
      const handle = await originalWriteText(text);
      handles.push(handle);
      return handle;
    };

    writer.writeStream = async (
      stream: ReadableStream<Uint8Array>,
      opts?: { onLine?: (line: string) => void },
    ) => {
      const handle = await originalWriteStream(stream, opts);
      handles.push(handle);
      return handle;
    };

    writer.finalize = async () => {
      const handle = await originalFinalize();
      handles.push(handle);
      return handle;
    };

    return writer;
  };

  return { createFileWriter, getHandles: () => [...handles] };
}
