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

import { z } from "zod";
import { getLogger } from "@logtape/logtape";
import {
  Data,
  dataNamePortability,
  findReservedTagKey,
  isReservedDataName,
  RESERVED_TAG_PREFIX,
} from "../data/mod.ts";
import type { DataId, OwnerDefinition } from "../data/mod.ts";
import type {
  DeferredWriteReceipt,
  UnifiedDataRepository,
} from "../data/repositories.ts";
import type { ModelType } from "./model_type.ts";
import type { MethodExecutionEvent } from "./method_events.ts";
import type {
  DataHandle,
  DataWriter,
  DataWriterCallbacks,
  FileOutputSpec,
  FileWriterOverrides,
  ModelDefinition,
  ResolvedDataWriterOptions,
  ResourceOutputSpec,
  ResourceWriteOverrides,
} from "./model.ts";
import type { GarbageCollectionPolicy, Lifetime } from "../data/mod.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretReference } from "../vaults/secret_bag_registry.ts";
import { isReservedVaultName } from "../vaults/vault_name.ts";
import {
  type BehaviorWords,
  wordedError,
  type WordedText,
  wordedText,
} from "../behavior_wording.ts";
import { currentVaultAccess } from "../vaults/run_vault_access.ts";
import { ResourceSensitiveFieldsInvalidError } from "../vaults/secret_reference_errors.ts";
import {
  overriddenSpecVaultName,
  resolveSensitiveOutputVault,
} from "./sensitive_output_vault.ts";
import type { SecretRedactor, SecretSink } from "../secrets/mod.ts";
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

  private allocated:
    | { version: number; contentPath: string; priorVersions: number[] }
    | null = null;
  private data: Data | null = null;
  private lineBuffer: string[] | null = null;
  private finalized = false;
  private readonly deferred: boolean;
  private deferredReceipt: DeferredWriteReceipt | null = null;

  constructor(
    repo: UnifiedDataRepository,
    modelType: ModelType,
    modelId: string,
    options: ResolvedDataWriterOptions,
    callbacks: DataWriterCallbacks = {},
    deferred = false,
  ) {
    this.repo = repo;
    this.modelType = modelType;
    this.modelId = modelId;
    this.options = options;
    this.callbacks = callbacks;
    this.deferred = deferred;
    this.dataId = repo.nextId();
    this.name = options.name;
  }

  getDeferredReceipt(): DeferredWriteReceipt | null {
    return this.deferredReceipt;
  }

  getPendingDeferredReceipt(): DeferredWriteReceipt | null {
    if (!this.deferred || this.finalized || !this.allocated) return null;
    return {
      type: this.modelType,
      modelId: this.modelId,
      dataName: this.name,
      version: this.allocated.version,
    };
  }

  async writeAll(content: Uint8Array): Promise<DataHandle> {
    this.ensureNotFinalized();
    const data = this.createDataEntity();

    if (this.deferred) {
      const receipt = await this.repo.saveDeferred(
        this.modelType,
        this.modelId,
        data,
        content,
      );
      this.deferredReceipt = receipt;
      this.finalized = true;
      return this.buildHandle(receipt.version, content.length);
    }

    const saveResult = await this.repo.save(
      this.modelType,
      this.modelId,
      data,
      content,
    );

    this.finalized = true;
    return this.buildHandle(
      saveResult.version,
      content.length,
      saveResult.checksum,
    );
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
        { deferred: this.deferred },
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
      { deferred: this.deferred },
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
        { deferred: this.deferred },
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

    if (this.deferred) {
      const { receipt, size } = await this.repo.finalizeVersionDeferred(
        this.modelType,
        this.modelId,
        this.data,
        this.allocated.version,
        this.allocated.priorVersions,
      );
      this.deferredReceipt = receipt;
      this.finalized = true;
      return this.buildHandle(this.allocated.version, size);
    }

    const { size, checksum: _checksum } = await this.repo.finalizeVersion(
      this.modelType,
      this.modelId,
      this.data,
      this.allocated.version,
      this.allocated.priorVersions,
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

  private buildHandle(
    version: number,
    size: number,
    sha256?: string,
  ): DataHandle {
    return {
      name: this.options.name,
      specName: this.options.specName,
      kind: this.options.kind,
      dataId: this.dataId,
      version,
      size,
      ...(sha256 !== undefined ? { sha256 } : {}),
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

/** Bytes of a segment's SHA-256 a hashed vault key segment carries. */
const VAULT_KEY_SEGMENT_DIGEST_BYTES = 16;

/**
 * Longest vary suffix a generated vault key carries as written: shorter than
 * the hashed form (`h-` and 32 hex digits), so keeping a suffix never makes a
 * key longer than hashing it would.
 */
const MAX_VERBATIM_VAULT_KEY_SEGMENT_LENGTH = 32;

/**
 * The form a vary suffix or dotted own-field name takes inside a generated
 * vault key (swamp-club#3633, swamp-club#3529). A segment of at most 32
 * lowercase letters, digits and `-`
 * is kept as written, so the key names the instance the record is stored
 * under. Any other suffix becomes `h-` and the first 32 hex digits of its
 * SHA-256: other characters do not survive into a readable key
 * ({@link sanitizeVaultKey} drops `@`, so `x@y` and `xy` would share one; a
 * `'` ends the key inside its vault reference; Azure Key Vault names allow
 * only letters, digits and `-`), capitals would fold onto lowercase in a
 * case-insensitive vault (Azure Key Vault, or local_encryption on a
 * case-insensitive file system), and a long value would overflow the file name
 * a file-backed vault stores the key under. The hashed form is longer than any
 * suffix kept as written, so for one data name the two forms cannot produce
 * the same key.
 */
async function vaultKeySegment(suffix: string): Promise<string> {
  if (
    suffix.length <= MAX_VERBATIM_VAULT_KEY_SEGMENT_LENGTH &&
    /^[a-z0-9-]+$/.test(suffix)
  ) {
    return suffix;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(suffix),
  );
  const hex = Array.from(
    new Uint8Array(digest).slice(0, VAULT_KEY_SEGMENT_DIGEST_BYTES),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `h-${hex}`;
}

/**
 * Returns true if any resource output spec in the model requires a vault
 * (has fields marked `{ sensitive: true }` or `sensitiveOutput: true`).
 */
export function modelRequiresVault(
  resources: Record<string, ResourceOutputSpec> | undefined,
): boolean {
  if (!resources) return false;
  for (const spec of Object.values(resources)) {
    if (spec.sensitiveOutput) return true;
    if (extractSensitiveFields(spec.schema).length > 0) return true;
  }
  return false;
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
  specName: string,
  instanceName: string,
  callbacks?: DataWriterCallbacks,
): Promise<string[]> {
  const sensitiveFields = extractSensitiveFields(spec.schema);

  // Under sensitiveOutput every top-level key is sensitive. Each is read and
  // written by its own name, never as a dot path: a key holding a dot would
  // otherwise be looked up as a nested path, skipped, and persisted as
  // written under the `*` tag that promises every field was vaulted
  // (swamp-club#3529). A key with a dot is added even when the schema names
  // that path, since the schema path means the nested field.
  const ownKeys = new Set<SensitiveFieldInfo>();
  if (spec.sensitiveOutput) {
    const existingPaths = new Set(sensitiveFields.map((f) => f.path));
    for (const key of Object.keys(data)) {
      if (!existingPaths.has(key) || key.includes(".")) {
        const field = { path: key };
        sensitiveFields.push(field);
        ownKeys.add(field);
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
    const value = ownKeys.has(field)
      ? snapshot[field.path]
      : getNestedValue(snapshot, field.path);
    if (value !== undefined && value !== null) {
      fieldsWithValues.push({ field, originalValue: value });
    }
  }

  if (fieldsWithValues.length === 0) {
    return [];
  }

  // Validate vault availability. Reserved vaults (such as the _token-secrets
  // control-plane vault serve registers) never hold user data, so only user
  // vaults count.
  const userVaultNames = vaultService.getUserVaultNames();
  if (userVaultNames.length === 0) {
    const fieldList = fieldsWithValues.map((f) => `'${f.field.path}'`).join(
      ", ",
    );
    throw new Error(
      `Cannot persist data: fields ${fieldList} are marked as sensitive ` +
        `but no vault is configured. Create a vault using: swamp vault create <type> <name>`,
    );
  }

  // Every target and key is resolved, and decided under the run's vault
  // access with the key the put will name, before the first value is stored,
  // so a refusal (including one from a grant revoked mid-run, or a grant
  // conditioned on the key) leaves no earlier field's value orphaned.
  const targets = await Promise.all(
    fieldsWithValues.map(async ({ field, originalValue }) => {
      const targetVault = resolveSensitiveOutputVault(
        { fieldVaultName: field.vaultName, specVaultName: spec.vaultName },
        vaultService,
      ) ?? userVaultNames[0];
      if (isReservedVaultName(targetVault)) {
        throw new Error(
          `Cannot store sensitive field '${field.path}': vault '${targetVault}' is reserved for internal use`,
        );
      }
      // A literal dotted key is a different identity from a schema dot-path.
      // Hash its exact name so sanitizing a.b and a..b cannot merge them.
      const keyField = ownKeys.has(field) && field.path.includes(".")
        ? `own-${await vaultKeySegment(field.path)}`
        : field.path;
      const vaultKey = field.vaultKey ??
        sanitizeVaultKey(
          `${modelType.normalized}/${modelId}/${methodName}/${specName}/${instanceName}/${keyField}`,
        );
      return { field, originalValue, targetVault, vaultKey };
    }),
  );
  const targetFields = new Map<string, string>();
  for (const { field, targetVault, vaultKey } of targets) {
    const target = `${targetVault}\0${vaultKey}`;
    const previous = targetFields.get(target);
    if (previous !== undefined) {
      throw new Error(
        `Sensitive fields '${previous}' and '${field.path}' target the same vault key in '${targetVault}'. Configure distinct vaultKey values.`,
      );
    }
    targetFields.set(target, field.path);
  }
  const access = currentVaultAccess();
  if (access) {
    const checked = new Set<string>();
    for (const { targetVault, vaultKey } of targets) {
      const pair = `${targetVault}\0${vaultKey}`;
      if (checked.has(pair)) continue;
      checked.add(pair);
      await access.check(targetVault, "write", vaultKey);
    }
  }

  for (const { field, originalValue, targetVault, vaultKey } of targets) {
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

    // Wildcard output stores each original top-level value as a whole.
    // Nested fields still populate their configured vault keys, but must
    // not replace an already-vaulted parent's reference with an object.
    if (
      spec.sensitiveOutput && !ownKeys.has(field) && field.path.includes(".")
    ) continue;

    const vaultRef = `\${{ vault.get('${targetVault}', '${vaultKey}') }}`;

    // Apply vault reference to data
    if (!ownKeys.has(field) && field.path.includes(".")) {
      setNestedValue(data, field.path, vaultRef);
    } else {
      data[field.path] = vaultRef;
    }
  }

  return fieldsWithValues.map((f) => f.field.path);
}

/**
 * Redacts registered secrets from the serialized resource payload, except
 * inside the vault references {@link processSensitiveResourceData} put at
 * `vaultedPaths`. A generated vault key embeds the instance name, which can
 * contain a resolved secret, so redacting the reference would point it at a
 * key the vault does not hold (swamp-club#3585). The text is split at each
 * reference's JSON literal, and the text between them is redacted as the
 * whole payload was before.
 */
function redactOutsideVaultReferences(
  data: Record<string, unknown>,
  vaultedPaths: string[],
  redactor: SecretRedactor,
  sensitiveOutput: boolean,
): string {
  // A sensitive object with a sensitive field inside holds that field's
  // reference rather than its own, so only string values are references.
  const literals = new Set<string>();
  const references = sensitiveOutput && vaultedPaths.length > 0
    ? Object.values(data)
    : vaultedPaths.map((path) => getNestedValue(data, path));
  for (const reference of references) {
    if (typeof reference === "string") literals.add(JSON.stringify(reference));
  }

  let pieces = [{ text: JSON.stringify(data), reference: false }];
  for (const literal of literals) {
    pieces = pieces.flatMap((piece) => {
      if (piece.reference) return [piece];
      const [first, ...rest] = piece.text.split(literal);
      return [
        { text: first, reference: false },
        ...rest.flatMap((text) => [
          { text: literal, reference: true },
          { text, reference: false },
        ]),
      ];
    });
  }
  return pieces.map((piece) =>
    piece.reference ? piece.text : redactor.redact(piece.text)
  ).join("");
}

/**
 * Applies {@link dataNamePortability} to a data name about to be written
 * (swamp-club#3568). Throws when this host cannot store the name; otherwise
 * emits one warning per name for a name that will not store correctly on
 * Windows, so an author on Linux or macOS sees it. The name is never changed.
 */
function checkDataNamePortability(
  name: string,
  modelType: ModelType,
  os: typeof Deno.build.os,
  warned: Set<string>,
  onEvent?: (event: MethodExecutionEvent) => void,
): void {
  const portability = dataNamePortability(name, os);
  if (portability.kind === "refuse") {
    throw wordedError(
      wordedText((w) =>
        `Data name '${name}' in ${w.noun} '${modelType.normalized}' ${portability.problem}, ` +
        `so this Windows host cannot store it. Use a different name.`
      ),
    );
  }
  if (portability.kind === "warn" && !warned.has(name)) {
    warned.add(name);
    onEvent?.({
      type: "data_name_portability_warning",
      message: `Data name '${name}' ${portability.problem}, ` +
        `so it will not store correctly on Windows. ` +
        `Use a different name to keep this data portable.`,
    });
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
    vaultName?: string;
  }>,
  definitionTags?: Record<string, string>,
  runtimeTags?: Record<string, string>,
  definitionName?: string,
  vaultService?: VaultService,
  methodName?: string,
  onEvent?: (event: MethodExecutionEvent) => void,
  redactor?: SecretRedactor,
  deferred = false,
  os: typeof Deno.build.os = Deno.build.os,
): {
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: ResourceWriteOverrides,
  ) => Promise<DataHandle>;
  getHandles: () => DataHandle[];
  getDeferredReceipts: () => DeferredWriteReceipt[];
} {
  const handles: DataHandle[] = [];
  const deferredReceipts: DeferredWriteReceipt[] = [];
  const portabilityWarned = new Set<string>();
  const assertWriteTagsUnreserved = writeTagsGuard(
    modelType,
    definitionTags,
    tagOverrides,
    runtimeTags,
    dataOutputOverrides,
  );
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
      throw wordedError(
        wordedText((w) =>
          `Undeclared resource spec '${specName}' in ${w.noun} '${modelType.normalized}'. ` +
          `Declared resource specs: ${declared || "(none)"}`
        ),
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

    // Validate name is a non-empty string
    if (typeof name !== "string" || name.trim() === "") {
      throw wordedError(
        wordedText((w) =>
          `writeResource: instance name must be a non-empty string for spec '${specName}' ` +
          `in ${w.noun} '${modelType.normalized}', got ${typeof name}`
        ),
      );
    }

    // Validate name is not reserved for internal use
    if (isReservedDataName(name)) {
      throw wordedError(
        wordedText((w) =>
          `Data name '${name}' is reserved for internal use in ${w.noun} '${modelType.normalized}'. ` +
          `Use a different name.`
        ),
      );
    }

    let instanceName = name;
    let varySuffix: string | undefined;

    assertWriteTagsUnreserved("resource", specName, spec.tags, overrides?.tags);

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
    let effectiveSpec = spec;
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
        if (override.resolvedVarySuffix) {
          varySuffix = override.resolvedVarySuffix;
          instanceName = `${instanceName}-${override.resolvedVarySuffix}`;
        }
        const vaultName = overriddenSpecVaultName(
          spec.vaultName,
          override.vaultName,
        );
        if (vaultName !== spec.vaultName) {
          effectiveSpec = { ...spec, vaultName };
        }
      }
    }

    checkDataNamePortability(
      instanceName,
      modelType,
      os,
      portabilityWarned,
      onEvent,
    );

    // Process sensitive fields before serialization
    const hasSensitiveFields = effectiveSpec.sensitiveOutput ||
      extractSensitiveFields(effectiveSpec.schema).length > 0;
    if (hasSensitiveFields && !vaultService) {
      const fields = extractSensitiveFields(effectiveSpec.schema)
        .map((f) => `'${f.path}'`).join(", ");
      const detail = effectiveSpec.sensitiveOutput
        ? `resource '${specName}' is marked sensitiveOutput`
        : `fields ${fields} in resource '${specName}' are marked as sensitive`;
      throw new Error(
        `Cannot persist data: ${detail} but no vault is configured. ` +
          `Create a vault using: swamp vault create <type> <name>`,
      );
    }
    let vaultedPaths: string[] = [];
    if (vaultService && methodName && hasSensitiveFields) {
      vaultedPaths = await processSensitiveResourceData(
        data,
        effectiveSpec,
        vaultService,
        modelType,
        modelId,
        methodName,
        specName,
        // The vary suffix is part of the key, so each vary instance keeps its
        // own secret (swamp-club#3633).
        varySuffix === undefined
          ? name
          : `${name}-${await vaultKeySegment(varySuffix)}`,
        { onEvent },
      );
      if (vaultedPaths.length > 0) {
        resolvedTags[SENSITIVE_FIELDS_TAG] = effectiveSpec.sensitiveOutput
          ? SENSITIVE_FIELDS_ALL
          : JSON.stringify(vaultedPaths);
        resolvedTags[SENSITIVE_FIELDS_VERSION_TAG] = SENSITIVE_FIELDS_VERSION;
      }
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
        ...(tagOverrides?.["workflowId"]
          ? { workflowId: tagOverrides["workflowId"] }
          : {}),
        ...(tagOverrides?.["workflowRunId"]
          ? { workflowRunId: tagOverrides["workflowRunId"] }
          : {}),
        ...(tagOverrides?.["workflow"]
          ? { workflowName: tagOverrides["workflow"] }
          : {}),
        ...(tagOverrides?.["job"] ? { jobName: tagOverrides["job"] } : {}),
        ...(tagOverrides?.["step"] ? { stepName: tagOverrides["step"] } : {}),
        ...(tagOverrides?.["source"] ? { source: tagOverrides["source"] } : {}),
      },
    };

    const writer = new DefaultDataWriter(
      repo,
      modelType,
      modelId,
      resolvedOptions,
      {},
      deferred,
    );

    const serialized = redactor?.hasSecrets
      ? redactOutsideVaultReferences(
        data,
        vaultedPaths,
        redactor,
        effectiveSpec.sensitiveOutput === true,
      )
      : JSON.stringify(data);
    const handle = await writer.writeText(serialized);
    handle.attributes = { ...data };
    handles.push(handle);
    const receipt = writer.getDeferredReceipt();
    if (receipt) {
      deferredReceipts.push(receipt);
    }
    return handle;
  };

  return {
    writeResource,
    getHandles: () => [...handles],
    getDeferredReceipts: () => [...deferredReceipts],
  };
}

/**
 * Tag key used to record which field paths were vaulted on write.
 * Read sites use this tag to limit vault reference resolution to only
 * those paths, preventing untrusted data in non-sensitive fields from
 * being resolved as vault references.
 */
export const SENSITIVE_FIELDS_TAG = "_swamp.sensitiveFields";

/**
 * Marks records vaulted after reserved tags and dotted own-key handling
 * became write-path invariants. Older records can contain forged tags or
 * unvaulted reference text, so their field tag alone cannot authorize a
 * remote resource claim (swamp-club#3529). Only the resource writer sets it.
 */
export const SENSITIVE_FIELDS_VERSION_TAG = "_swamp.sensitiveFieldsVersion";
export const SENSITIVE_FIELDS_VERSION = "1";

/**
 * Sentinel value for the {@link SENSITIVE_FIELDS_TAG} tag when all fields
 * are sensitive (`sensitiveOutput: true` on the resource spec).
 */
export const SENSITIVE_FIELDS_ALL = "*";

/** Who must remove a reserved tag that a type's own code supplies. */
const typeAuthorRemedy = (w: BehaviorWords) =>
  `The ${w.noun} type's author must remove it.`;

/**
 * The refusal of a tag key under {@link RESERVED_TAG_PREFIX} from a source
 * swamp does not control (swamp-club#3635), or undefined when `tags` holds
 * none. Readers trust `_swamp.*` tags as swamp's own, and
 * {@link SENSITIVE_FIELDS_TAG} chooses which fields resolve vault references,
 * so the vaulting step must be the only way one reaches a record. The message
 * names the key and its source, never the value, which may be sensitive.
 *
 * @param tags - The tags from one source, if any
 * @param source - Completes "Tag 'x' from …"
 * @param remedy - The sentence that says how to fix it
 */
export function reservedTagRefusal(
  tags: Record<string, string> | undefined,
  source: (w: BehaviorWords) => string,
  remedy: (w: BehaviorWords) => string = () => "Remove it.",
): WordedText | undefined {
  if (!tags) return undefined;
  const key = findReservedTagKey(tags);
  if (key === undefined) return undefined;
  return wordedText((w) =>
    `Tag '${key}' from ${source(w)} is reserved: tag keys starting with ` +
    `'${RESERVED_TAG_PREFIX}' are written by swamp alone. ${remedy(w)}`
  );
}

/** Throws the {@link reservedTagRefusal} of `tags`, if there is one. */
export function assertNoReservedTags(
  tags: Record<string, string> | undefined,
  source: (w: BehaviorWords) => string,
  remedy?: (w: BehaviorWords) => string,
): void {
  const refusal = reservedTagRefusal(tags, source, remedy);
  if (refusal) throw wordedError(refusal);
}

/**
 * The tag sources of one method run that exist before the method runs. A
 * caller checking only workflow-authored sources leaves out `modelType`.
 */
export interface RunTagSources {
  modelType?: ModelType;
  definitionTags?: Record<string, string>;
  specs?: ReadonlyArray<{
    kind: "resource" | "file";
    specName: string;
    tags?: Record<string, string>;
  }>;
  tagOverrides?: Record<string, string>;
  runtimeTags?: Record<string, string>;
  dataOutputOverrides?: ReadonlyArray<{
    specName: string;
    tags?: Record<string, string>;
  }>;
}

/**
 * The first refusal of a reserved tag key in any source of a method run known
 * before the method runs: the definition, spec defaults, workflow tags,
 * `--tag` and data output overrides. Validation reports it; a run throws it.
 */
export function reservedRunTagRefusal(
  sources: RunTagSources,
): WordedText | undefined {
  const inType = (w: BehaviorWords) =>
    sources.modelType
      ? ` in ${w.noun} type '${sources.modelType.normalized}'`
      : "";
  const refusals = [
    () =>
      reservedTagRefusal(
        sources.definitionTags,
        (w) => `the ${w.noun} definition's tags`,
      ),
    ...(sources.specs ?? []).map((spec) => () =>
      reservedTagRefusal(
        spec.tags,
        (w) =>
          `the default tags of ${spec.kind} spec '${spec.specName}'${
            inType(w)
          }`,
        typeAuthorRemedy,
      )
    ),
    () => reservedTagRefusal(sources.tagOverrides, () => "the workflow's tags"),
    () => reservedTagRefusal(sources.runtimeTags, () => "--tag"),
    ...(sources.dataOutputOverrides ?? []).map((override) => () =>
      reservedTagRefusal(
        override.tags,
        () => `the data output override for spec '${override.specName}'`,
      )
    ),
  ];
  for (const refusal of refusals) {
    const found = refusal();
    if (found) return found;
  }
  return undefined;
}

/** The default tags of every resource and file spec a type declares. */
export function outputSpecTags(
  modelDef: Pick<ModelDefinition, "resources" | "files">,
): NonNullable<RunTagSources["specs"]> {
  return [
    ...Object.entries(modelDef.resources ?? {}).map(([specName, spec]) => ({
      kind: "resource" as const,
      specName,
      tags: spec.tags,
    })),
    ...Object.entries(modelDef.files ?? {}).map(([specName, spec]) => ({
      kind: "file" as const,
      specName,
      tags: spec.tags,
    })),
  ];
}

/**
 * Throws the {@link reservedRunTagRefusal} of a method run's sources. The
 * method execution service calls it before anything executes; the writers
 * call it again on every write, with the method's own write overrides, as
 * the backstop.
 */
export function assertNoReservedRunTags(sources: RunTagSources): void {
  const refusal = reservedRunTagRefusal(sources);
  if (refusal) throw wordedError(refusal);
}

/**
 * Binds {@link assertNoReservedRunTags} to one writer factory's sources and
 * adds the write's own spec and method overrides.
 */
function writeTagsGuard(
  modelType: ModelType,
  definitionTags: Record<string, string> | undefined,
  tagOverrides: Record<string, string> | undefined,
  runtimeTags: Record<string, string> | undefined,
  dataOutputOverrides:
    | Array<{ specName: string; tags?: Record<string, string> }>
    | undefined,
): (
  kind: "resource" | "file",
  specName: string,
  specTags: Record<string, string> | undefined,
  overrideTags: Record<string, string> | undefined,
) => void {
  return (kind, specName, specTags, overrideTags) => {
    assertNoReservedRunTags({
      modelType,
      definitionTags,
      specs: [{ kind, specName, tags: specTags }],
      tagOverrides,
      runtimeTags,
      dataOutputOverrides: dataOutputOverrides?.filter((o) =>
        o.specName === specName
      ),
    });
    assertNoReservedTags(
      overrideTags,
      (w) =>
        `the write overrides of ${kind} spec '${specName}' in ${w.noun} type '${modelType.normalized}'`,
      typeAuthorRemedy,
    );
  };
}

/**
 * Parses the `_swamp.sensitiveFields` tag from a data record's tags.
 *
 * @returns A string array of dot-paths, `"*"` when all fields are sensitive,
 *          or `null` when the tag is absent (legacy data).
 */
export function parseSensitiveFieldsTag(
  tags: Record<string, string>,
): string[] | "*" | null {
  const raw = tags[SENSITIVE_FIELDS_TAG];
  if (raw === undefined) return null;
  if (raw === SENSITIVE_FIELDS_ALL) return SENSITIVE_FIELDS_ALL;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((v) => typeof v === "string")
    ) {
      return parsed as string[];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Regex matching vault expression strings produced by `processSensitiveResourceData()`.
 * Captures the vault name (group 1) and key (group 2).
 */
const VAULT_REF_REGEX =
  /^\$\{\{\s*vault\.get\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)\s*\}\}$/;

/**
 * The vault name and key of `text` when it is exactly one stored reference:
 * the anchored text {@link processSensitiveResourceData} writes at a vaulted
 * path. Undefined for any other text, reference-looking or not.
 */
export function parseStoredVaultReference(
  text: string,
): SecretReference | undefined {
  const match = VAULT_REF_REGEX.exec(text);
  return match ? { vaultName: match[1], key: match[2] } : undefined;
}

/** A path segment, or field name, that would reach a prototype rather than a field. */
export const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * The strict reading of a record's {@link SENSITIVE_FIELDS_TAG}: no tag,
 * every top-level field, or the writer's dot-paths as segment lists.
 */
export type SensitiveFieldsTag =
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | {
    readonly kind: "paths";
    readonly paths: readonly (readonly string[])[];
  };

/**
 * A {@link SENSITIVE_FIELDS_TAG} the writer could not have produced. The
 * message names the reason only, never the tag's text, which can be data
 * from outside this repository.
 */
export class SensitiveFieldsTagInvalidError extends Error {
  constructor(readonly reason: string) {
    super(`The ${SENSITIVE_FIELDS_TAG} tag is invalid: ${reason}`);
    this.name = "SensitiveFieldsTagInvalidError";
  }
}

/**
 * Reads the {@link SENSITIVE_FIELDS_TAG} strictly, as the expression-facing
 * accessors do (design/enablers/typed-secrets.md Section 6.1): an absent tag
 * means no sensitive fields, the star value means every top-level field, and
 * anything else must be the JSON list of dot-paths the writer stores. A tag
 * that is not text, not JSON, not a list of strings, or that holds an empty
 * path, an empty segment or an unsafe segment throws
 * {@link SensitiveFieldsTagInvalidError}. Unlike {@link parseSensitiveFieldsTag},
 * a malformed tag is never read as absent.
 */
export function readSensitiveFieldsTag(
  tags: Record<string, string>,
): SensitiveFieldsTag {
  const raw: unknown = tags[SENSITIVE_FIELDS_TAG];
  if (raw === undefined) return { kind: "none" };
  if (typeof raw !== "string") {
    throw new SensitiveFieldsTagInvalidError("not text");
  }
  if (raw === SENSITIVE_FIELDS_ALL) return { kind: "all" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SensitiveFieldsTagInvalidError("not JSON");
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((path) => typeof path === "string")
  ) {
    throw new SensitiveFieldsTagInvalidError("not a list of path strings");
  }
  const paths = (parsed as string[]).map((path) => {
    if (path === "") throw new SensitiveFieldsTagInvalidError("an empty path");
    const segments = path.split(".");
    for (const segment of segments) {
      if (segment === "") {
        throw new SensitiveFieldsTagInvalidError("an empty path segment");
      }
      if (UNSAFE_PATH_SEGMENTS.has(segment)) {
        throw new SensitiveFieldsTagInvalidError(
          `the unsafe path segment '${segment}'`,
        );
      }
    }
    return segments;
  });
  return { kind: "paths", paths };
}

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
  redactor?: SecretSink,
): Promise<void> {
  await walkAndResolve(data, vaultService, redactor);
}

async function walkAndResolve(
  obj: unknown,
  vaultService: VaultService,
  redactor?: SecretSink,
): Promise<unknown> {
  if (typeof obj === "string") {
    const match = VAULT_REF_REGEX.exec(obj);
    if (match) {
      const [, vaultName, key] = match;
      const value = await vaultService.get(
        vaultName,
        key,
        "data-writer:vault-ref-resolve",
      );
      redactor?.addSecret(value, { vaultName, key });
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
 * Resolves vault references only at the specified field paths (or all fields
 * when `sensitiveFields` is `"*"`). Unlike {@link resolveVaultRefsInData} which
 * walks the entire object tree, this function targets only the paths that were
 * written by {@link processSensitiveResourceData}, preventing untrusted data in
 * non-sensitive fields from being resolved as vault references.
 */
export async function resolveSensitiveVaultRefs(
  data: Record<string, unknown>,
  sensitiveFields: string[] | "*",
  vaultService: VaultService,
  redactor?: SecretSink,
): Promise<void> {
  if (sensitiveFields === SENSITIVE_FIELDS_ALL) {
    await walkAndResolve(data, vaultService, redactor);
    return;
  }

  for (const fieldPath of sensitiveFields) {
    const value = getNestedValue(data, fieldPath);
    const resolved = await resolveValueAtPath(value, vaultService, redactor);
    if (resolved !== value) {
      if (fieldPath.includes(".")) {
        setNestedValue(data, fieldPath, resolved);
      } else {
        data[fieldPath] = resolved;
      }
    }
  }
}

/**
 * The vault references a record's sensitive fields hold, in the shape
 * {@link processSensitiveResourceData} leaves them: one whole-string
 * reference exactly at each tagged location, which is the value at each
 * path the sensitive-fields tag lists, or the value of each top-level key
 * by its own name for the `*` tag. Listed in document order without
 * repeats, so serve can authorize a worker's read of a tagged field
 * against the record itself (swamp-club#3529). A null `sensitiveFields`
 * (no tag, or a malformed one, as {@link parseSensitiveFieldsTag} reads it)
 * names none.
 *
 * Nothing nested inside a tagged location is named: the writer vaults the
 * whole value there, so a reference below it is not one the writer made.
 * {@link resolveSensitiveVaultRefs} still walks below a tagged location for
 * records written before that shape was relied on; a remote read of such a
 * record needs independent allowlist authorization on serve.
 *
 * That authorization rests on two guards of the write path: the writer
 * vaults every present value of a sensitive field, reference text included,
 * so a tagged location only ever holds a reference the writer generated;
 * and the tag sits under {@link RESERVED_TAG_PREFIX}, which swamp alone
 * writes. Serve also requires {@link SENSITIVE_FIELDS_VERSION_TAG}, so a
 * record written before those guards existed cannot authorize a claim.
 */
export function sensitiveVaultReferences(
  data: Record<string, unknown>,
  sensitiveFields: string[] | "*" | null,
): SecretReference[] {
  const references: SecretReference[] = [];
  const seen = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value !== "string") return;
    const reference = parseStoredVaultReference(value);
    if (!reference) return;
    const { vaultName, key } = reference;
    const id = `${vaultName}\u0000${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    references.push({ vaultName, key });
  };
  if (sensitiveFields === null) return references;
  if (sensitiveFields === SENSITIVE_FIELDS_ALL) {
    for (const key of Object.keys(data)) collect(data[key]);
  } else {
    for (const fieldPath of sensitiveFields) {
      collect(getNestedValue(data, fieldPath));
    }
  }
  return references;
}

async function resolveValueAtPath(
  value: unknown,
  vaultService: VaultService,
  redactor?: SecretSink,
): Promise<unknown> {
  if (typeof value === "string") {
    const match = VAULT_REF_REGEX.exec(value);
    if (match) {
      const [, vaultName, key] = match;
      const resolved = await vaultService.get(
        vaultName,
        key,
        "data-writer:vault-ref-resolve",
      );
      redactor?.addSecret(resolved, { vaultName, key });
      return resolved;
    }
    return value;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = await resolveValueAtPath(value[i], vaultService, redactor);
    }
    return value;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = await resolveValueAtPath(
        record[key],
        vaultService,
        redactor,
      );
    }
    return record;
  }

  return value;
}

/**
 * Creates a readResource function bound to a specific execution context.
 *
 * The returned function reads previously stored resource data by instance name,
 * returning the parsed JSON object or null if no data exists.
 * When a VaultService is provided, vault reference expressions are resolved
 * only in the fields {@link getSensitiveFieldsForResolution} chooses: those
 * the `_swamp.sensitiveFields` tag names, or, for an untagged record, those
 * the resource spec schema marks sensitive. A malformed tag fails the read.
 * The worker's remote method context builds the same reader over its proxies
 * with the verified bundle's specs, so both executors read alike
 * (swamp-club#3530).
 *
 * @param repo - The unified data repository
 * @param modelType - The model type
 * @param modelId - The model ID (definition ID)
 * @param vaultService - Optional vault service, or a factory scoped to the record being read
 * @param redactor - Optional secret redactor to register resolved secrets
 * @param resourceSpecs - Optional resource specs for the untagged-record schema fallback
 * @returns A readResource function
 */
export function createResourceReader(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  vaultService?: VaultService | ((record: Data) => VaultService),
  redactor?: SecretRedactor,
  resourceSpecs?: Record<string, ResourceOutputSpec>,
): (
  instanceName: string,
  version?: number,
) => Promise<Record<string, unknown> | null> {
  return async (
    instanceName: string,
    version?: number,
  ): Promise<Record<string, unknown> | null> => {
    const dataRecord = await repo.findByName(
      modelType,
      modelId,
      instanceName,
      version,
    );
    const resolvedVersion = dataRecord?.version;

    // Follow a rename consistently: read and authorize the returned record
    // by its current name and pinned version.
    const content = await repo.getContent(
      modelType,
      modelId,
      dataRecord?.name ?? instanceName,
      resolvedVersion ?? version,
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
    // Decided before any vault read, so a malformed tag refuses the read
    // whether or not a vault service is wired.
    const sensitiveFields = dataRecord
      ? getSensitiveFieldsForResolution(
        dataRecord.tags,
        resourceSpecs,
        instanceName,
      )
      : null;
    if (vaultService && sensitiveFields && dataRecord) {
      await resolveSensitiveVaultRefs(
        data,
        sensitiveFields,
        typeof vaultService === "function"
          ? vaultService(dataRecord)
          : vaultService,
        redactor,
      );
    }
    return data;
  };
}

/**
 * Decides which fields of a stored resource resolve vault references, for
 * `readResource` on both executors. The record's `_swamp.sensitiveFields` tag
 * is read strictly, as the accessor adapter reads it
 * ({@link readSensitiveFieldsTag}): a present tag names the fields, and a tag
 * the writer could not have produced fails the read with
 * {@link ResourceSensitiveFieldsInvalidError}, naming the record, rather than
 * being read as absent. An absent tag (a record written before the tag
 * existed, or with nothing vaulted at write time) falls back to the resource
 * spec's schema, found by the record's `specName` tag; without specs, a spec
 * name or a matching spec nothing resolves, the secure default.
 */
export function getSensitiveFieldsForResolution(
  tags: Record<string, string>,
  resourceSpecs: Record<string, ResourceOutputSpec> | undefined,
  instanceName: string,
): string[] | "*" | null {
  let tag: SensitiveFieldsTag;
  try {
    tag = readSensitiveFieldsTag(tags);
  } catch (error) {
    if (error instanceof SensitiveFieldsTagInvalidError) {
      throw new ResourceSensitiveFieldsInvalidError(instanceName, error);
    }
    throw error;
  }
  if (tag.kind === "all") return SENSITIVE_FIELDS_ALL;
  if (tag.kind === "paths") {
    return tag.paths.map((segments) => segments.join("."));
  }

  if (!resourceSpecs) return null;
  const specName = tags["specName"];
  if (!specName) return null;
  const spec = resourceSpecs[specName];
  if (!spec) return null;

  if (spec.sensitiveOutput) return SENSITIVE_FIELDS_ALL;
  const fields = extractSensitiveFields(spec.schema);
  return fields.length > 0 ? fields.map((f) => f.path) : null;
}

/**
 * Creates a deleteResource function bound to a specific execution context.
 *
 * @param repo - The unified data repository
 * @param modelType - The model type
 * @param modelId - The model ID (definition ID)
 * @returns A deleteResource function
 */
export function createResourceDeleter(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
): (instanceName: string) => Promise<void> {
  return async (instanceName: string): Promise<void> => {
    await repo.delete(modelType, modelId, instanceName);
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
  deferred = false,
  os: typeof Deno.build.os = Deno.build.os,
): {
  createFileWriter: (
    specName: string,
    name: string,
    overrides?: FileWriterOverrides,
  ) => DataWriter;
  getHandles: () => DataHandle[];
  getDeferredReceipts: () => DeferredWriteReceipt[];
} {
  const handles: DataHandle[] = [];
  const writers: DefaultDataWriter[] = [];
  const deferredReceipts: DeferredWriteReceipt[] = [];
  const portabilityWarned = new Set<string>();
  const assertWriteTagsUnreserved = writeTagsGuard(
    modelType,
    definitionTags,
    tagOverrides,
    runtimeTags,
    dataOutputOverrides,
  );

  const createFileWriter = (
    specName: string,
    name: string,
    overrides?: FileWriterOverrides,
  ): DataWriter => {
    const spec = files[specName];
    if (!spec) {
      const declared = Object.keys(files).join(", ");
      throw wordedError(
        wordedText((w) =>
          `Undeclared file spec '${specName}' in ${w.noun} '${modelType.normalized}'. ` +
          `Declared file specs: ${declared || "(none)"}`
        ),
      );
    }

    // Validate name is a non-empty string
    if (typeof name !== "string" || name.trim() === "") {
      throw wordedError(
        wordedText((w) =>
          `createFileWriter: instance name must be a non-empty string for spec '${specName}' ` +
          `in ${w.noun} '${modelType.normalized}', got ${typeof name}`
        ),
      );
    }

    // Validate name is not reserved for internal use
    if (isReservedDataName(name)) {
      throw wordedError(
        wordedText((w) =>
          `Data name '${name}' is reserved for internal use in ${w.noun} '${modelType.normalized}'. ` +
          `Use a different name.`
        ),
      );
    }

    let instanceName = name;

    assertWriteTagsUnreserved("file", specName, spec.tags, overrides?.tags);

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

    checkDataNamePortability(
      instanceName,
      modelType,
      os,
      portabilityWarned,
      callbacks?.onEvent,
    );

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
        ...(tagOverrides?.["workflowId"]
          ? { workflowId: tagOverrides["workflowId"] }
          : {}),
        ...(tagOverrides?.["workflowRunId"]
          ? { workflowRunId: tagOverrides["workflowRunId"] }
          : {}),
        ...(tagOverrides?.["workflow"]
          ? { workflowName: tagOverrides["workflow"] }
          : {}),
        ...(tagOverrides?.["job"] ? { jobName: tagOverrides["job"] } : {}),
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
      deferred,
    );
    writers.push(writer);

    // Wrap write methods to track handles
    const originalWriteAll = writer.writeAll.bind(writer);
    const originalFinalize = writer.finalize.bind(writer);

    // Only wrap the terminal methods (writeAll, finalize) — writeText delegates
    // to writeAll and writeStream delegates to finalize, so wrapping those too
    // would record each handle twice.
    writer.writeAll = async (content: Uint8Array) => {
      const handle = await originalWriteAll(content);
      handles.push(handle);
      const receipt = writer.getDeferredReceipt();
      if (receipt) {
        deferredReceipts.push(receipt);
      }
      return handle;
    };

    writer.finalize = async () => {
      const handle = await originalFinalize();
      handles.push(handle);
      const receipt = writer.getDeferredReceipt();
      if (receipt) {
        deferredReceipts.push(receipt);
      }
      return handle;
    };

    return writer;
  };

  return {
    createFileWriter,
    getHandles: () => [...handles],
    getDeferredReceipts: () => {
      const receipts = [...deferredReceipts];
      for (const writer of writers) {
        const pending = writer.getPendingDeferredReceipt();
        if (pending) receipts.push(pending);
      }
      return receipts;
    },
  };
}
