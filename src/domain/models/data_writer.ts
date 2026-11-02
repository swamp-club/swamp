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
import { markErrorPaths } from "../errors.ts";
import {
  type BehaviorWords,
  wordedError,
  type WordedText,
  wordedText,
} from "../behavior_wording.ts";
import {
  currentVaultAccess,
  VaultAccessDeniedError,
} from "../vaults/run_vault_access.ts";
import { ResourceSensitiveFieldsInvalidError } from "../vaults/secret_reference_errors.ts";
import {
  overriddenSpecVaultName,
  resolveSensitiveOutputVault,
} from "./sensitive_output_vault.ts";
import type { SecretRedactor, SecretSink } from "../secrets/mod.ts";
import {
  extractSensitiveFields,
  findSensitiveResourceValues,
  getNestedValue,
  schemaHoldsSensitiveFields,
  setNestedValue,
} from "./sensitive_field_extractor.ts";

const logger = getLogger(["swamp", "data-writer"]);

export class DefaultDataWriter implements DataWriter {
  readonly dataId: DataId;
  readonly name: string;

  private readonly repo: UnifiedDataRepository;
  private readonly modelType: ModelType;
  private readonly modelId: string;
  private readonly options: ResolvedDataWriterOptions;
  private readonly callbacks: DataWriterCallbacks;

  private allocated:
    | {
      version: number;
      contentPath: string;
      priorVersions: number[];
      durable?: boolean;
      syncContent?: (file: Deno.FsFile) => Promise<void>;
    }
    | null = null;
  /**
   * whether writeStream synced the content on its own handle, so finalize need
   * not have the repository sync it
   */
  private contentSynced = false;
  private data: Data | null = null;
  private lineBuffer: string[] | null = null;
  private finalized = false;
  private pathHandedOut = false;
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

  /**
   * a non-deferred writer's version allocated through getFilePath but never
   * finalised is content with no metadata that nothing commits or claims, so a
   * failed method rolls it back
   */
  getUnfinalizedReceipt(): DeferredWriteReceipt | null {
    if (
      this.deferred || this.finalized || !this.allocated || !this.pathHandedOut
    ) {
      return null;
    }
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
      const data = this.createDataEntity();
      this.data = data;
      this.allocated = await this.repo.allocateVersion(
        this.modelType,
        this.modelId,
        data,
        { deferred: this.deferred },
      );
      await Deno.writeFile(this.allocated.contentPath, new Uint8Array());
      this.lineBuffer = [];
    }

    const lineContent = line + "\n";
    const file = await Deno.open(this.allocated.contentPath, { append: true });
    try {
      await file.write(new TextEncoder().encode(lineContent));
    } finally {
      file.close();
    }

    this.lineBuffer!.push(line);

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

        await file.write(value);

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

      if (buffer && (options?.onLine || this.callbacks.onLine)) {
        options?.onLine?.(buffer);
        this.callbacks.onLine?.(this.name, buffer);
      }

      // sync on the writing handle through the repository policy, as Linux
      // reports a write-back error only to handles open at the time; outside
      // finally so a sync error never hides a stream error
      if (this.allocated.durable) {
        try {
          await (this.allocated.syncContent ?? ((f) => f.sync()))(file);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw markErrorPaths(
            new Error(
              `Could not sync ${this.allocated.contentPath} to disk: ${reason}.`,
              { cause: error },
            ),
            [this.allocated.contentPath],
          );
        }
        this.contentSynced = true;
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

    this.pathHandedOut = true;
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
        { contentSynced: this.contentSynced },
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
      { contentSynced: this.contentSynced },
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
      version: 1,
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
 * vault providers like local_encryption map keys to filenames, so path
 * separators, .. and null bytes are rejected; @ is dropped and / or backslash
 * become -
 */
export function sanitizeVaultKey(key: string): string {
  return key
    .replace(/@/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\.\./g, ".")
    .replace(/\0/g, "");
}

const VAULT_KEY_SEGMENT_DIGEST_BYTES = 16;

/**
 * Longest vary suffix a generated vault key carries as written: shorter than
 * the hashed form (`h-` and 32 hex digits), so keeping a suffix never makes a
 * key longer than hashing it would.
 */
const MAX_VERBATIM_VAULT_KEY_SEGMENT_LENGTH = 32;

/**
 * lowercase letter/digit/dash suffixes of at most 32 chars stay as written;
 * others become h- plus 32 hex of SHA-256, since @, capitals and long values
 * break or collide in vault keys
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

export function modelRequiresVault(
  resources: Record<string, ResourceOutputSpec> | undefined,
): boolean {
  if (!resources) return false;
  for (const spec of Object.values(resources)) {
    if (spec.sensitiveOutput) return true;
    if (schemaHoldsSensitiveFields(spec.schema)) return true;
  }
  return false;
}

/**
 * a string is a dot path, the form every release reads from
 * SENSITIVE_FIELDS_TAG; an array lists the keys and indexes, for a place a dot
 * path cannot name
 */
export type SensitiveFieldPath =
  | string
  | (string | number)[]
  | JsonSensitiveField;

/**
 * a vaulted place whose vault value is JSON text for a non-string value, parsed
 * back once resolved
 */
export interface JsonSensitiveField {
  keys: (string | number)[];
  json: true;
}

export interface VaultedFields {
  /**
   * where each stored value and each sensitive field inside one sits, which
   * readers register as a secret once the outer value is restored: a dot path
   * where one names it for every release, else its keys
   */
  paths: (string | (string | number)[])[];
  /**
   * keys of non-string values stored as JSON text that older writers did not
   * vault: inside an array element or record value, a union member's field, or
   * a field under a lazy schema
   */
  jsonKeys: (string | number)[][];
}

interface SensitiveTarget {
  keys: (string | number)[];
  path: string;
  vaultName?: string;
  vaultKey?: string;
  /**
   * Whether the value sits inside an array element or record value, and so
   * needs a vault key of its own per element.
   */
  perElement: boolean;
  originalValue: unknown;
  /**
   * still stored under its own key so a reader of that key keeps getting the
   * current value, while the data keeps the outer reference in its place
   */
  insideStored?: boolean;
  /**
   * outside a sensitiveOutput spec the data then holds an object of those
   * values' references here, not one reference
   */
  holdsStored?: boolean;
  /**
   * a top-level value of a sensitiveOutput spec, read and written by its own
   * key, never as a dot path
   */
  ownKey?: boolean;
}

/**
 * a value inside another being stored is carried by the outer value: one
 * outside any array element or record value is still stored under its own key,
 * one inside an element is not stored again
 */
function findSensitiveTargets(
  data: Record<string, unknown>,
  spec: ResourceOutputSpec,
): { stored: SensitiveTarget[]; found: (string | number)[][] } {
  // Values are read from a snapshot, so that replacing one value with its
  // reference never changes another one stored after it.
  const snapshot = structuredClone(data);
  const targets: SensitiveTarget[] = findSensitiveResourceValues(
    spec.schema,
    snapshot,
  ).map((found) => ({
    keys: found.keys,
    path: found.perElement ? found.path : found.keys.join("."),
    vaultName: found.vaultName,
    vaultKey: found.vaultKey,
    perElement: found.perElement,
    originalValue: found.value,
  }));

  if (spec.sensitiveOutput) {
    const topLevel = new Set<string | number>();
    for (const target of targets) {
      if (target.keys.length === 1) {
        target.ownKey = true;
        topLevel.add(target.keys[0]);
      }
    }
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined || value === null) continue;
      if (!topLevel.has(key)) {
        targets.push({
          keys: [key],
          path: key,
          perElement: false,
          originalValue: value,
          ownKey: true,
        });
      }
    }
  }

  // Looked up by each target's ancestors, so a resource with many elements
  // is checked in time proportional to its targets, not their square.
  const stored = new Set(targets.map((target) => JSON.stringify(target.keys)));
  const kept: SensitiveTarget[] = [];
  const holders = new Set<string>();
  for (const target of targets) {
    const ancestor = outermostStoredAncestor(target.keys, stored);
    if (ancestor === undefined) {
      kept.push(target);
    } else if (!target.perElement) {
      kept.push({ ...target, insideStored: true });
      holders.add(ancestor);
    }
  }
  for (const target of kept) {
    if (!target.insideStored && holders.has(JSON.stringify(target.keys))) {
      target.holdsStored = true;
    }
  }
  return { stored: kept, found: targets.map((target) => target.keys) };
}

/**
 * values reached by walking nested objects alone were vaulted by the earlier
 * writer and read back as JSON text when not a string; any other is newly
 * vaulted and reads back as written
 */
function vaultedBefore3038(
  spec: ResourceOutputSpec,
): (keys: (string | number)[]) => boolean {
  const paths = new Set(extractSensitiveFields(spec.schema).map((f) => f.path));
  return (keys) =>
    keys.every((key) => typeof key === "string" && !key.includes(".")) &&
    paths.has(keys.join("."));
}

function outermostStoredAncestor(
  keys: (string | number)[],
  stored: Set<string>,
): string | undefined {
  for (let length = 1; length < keys.length; length++) {
    const prefix = JSON.stringify(keys.slice(0, length));
    if (stored.has(prefix)) {
      return prefix;
    }
  }
  return undefined;
}

function sensitiveFieldList(
  spec: ResourceOutputSpec,
  data: Record<string, unknown>,
): string {
  let paths = extractSensitiveFields(spec.schema).map((f) => f.path);
  if (paths.length === 0) {
    paths = findSensitiveResourceValues(spec.schema, data).map((f) => f.path);
  }
  return paths.length > 0
    ? `fields ${paths.map((p) => `'${p}'`).join(", ")}`
    : "some fields";
}

/**
 * a record key kept as written in an element vault key: lowercase only, since
 * capitals fold onto lowercase in a case-insensitive vault
 */
const PLAIN_KEY = /^[a-z0-9_-]+$/;

async function shortHash(text: string, hexDigits: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("").slice(0, hexDigits);
}

/**
 * vault providers map keys to file and secret names, which have length limits
 * of their own
 */
const MAX_ELEMENT_VAULT_KEY_LENGTH = 200;

/**
 * record keys come from resource data, so other characters become -; a
 * non-plain key also gets 12 hex digits of SHA-256 of the exact keys, keeping
 * case-only differences distinct and each key stable across writes
 */
async function encodeElementKeys(keys: (string | number)[]): Promise<string> {
  let changed = false;
  const encoded = keys.map((key) => {
    if (typeof key === "number" || PLAIN_KEY.test(key)) {
      return String(key);
    }
    changed = true;
    return key.replace(/[^A-Za-z0-9_-]+/g, "-") || "-";
  }).join(".");
  if (!changed) {
    return encoded;
  }
  return `${encoded}-${await shortHash(JSON.stringify(keys), 12)}`;
}

/**
 * outside an element the key is the field vaultKey or derived from model,
 * method, spec, instance and path; inside an element its encoded place is
 * appended so elements never share a key; long keys end in a hash
 */
async function vaultKeyFor(
  target: SensitiveTarget,
  prefix: string,
): Promise<string> {
  if (!target.perElement) {
    if (target.vaultKey !== undefined) return target.vaultKey;
    // A literal dotted key is a different identity from a schema dot-path.
    // Hash its exact name so sanitizing a.b and a..b cannot merge them.
    const field = target.ownKey && String(target.keys[0]).includes(".")
      ? `own-${await vaultKeySegment(String(target.keys[0]))}`
      : target.keys.join(".");
    return sanitizeVaultKey(`${prefix}/${field}`);
  }
  const element = await encodeElementKeys(target.keys);
  const key = target.vaultKey !== undefined
    ? `${target.vaultKey}.${element}`
    : sanitizeVaultKey(`${prefix}/${element}`);
  if (key.length <= MAX_ELEMENT_VAULT_KEY_LENGTH) {
    return key;
  }
  // Cut, and told apart from every other cut key by the hash of the whole.
  const hash = await shortHash(key, 16);
  return `${
    key.slice(0, MAX_ELEMENT_VAULT_KEY_LENGTH - hash.length - 1)
  }-${hash}`;
}

/**
 * no key may hold a dot, which older readers split on, or be empty or one of
 * UNSAFE_PATH_SEGMENTS, which readSensitiveFieldsTag refuses
 */
function writableAsDotPath(keys: (string | number)[]): boolean {
  return keys.every((key) =>
    typeof key === "number" ||
    (key !== "" && !key.includes(".") && !UNSAFE_PATH_SEGMENTS.has(key))
  );
}

function getValueAtKeys(
  data: Record<string, unknown>,
  keys: (string | number)[],
): unknown {
  let current: unknown = data;
  for (const key of keys) {
    if (
      current === null || typeof current !== "object" ||
      !Object.hasOwn(current, key)
    ) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/**
 * nothing is written when the place does not exist: no container is created,
 * and a key is only written as an own property, never through __proto__
 */
function setValueAtKeys(
  data: Record<string, unknown>,
  keys: (string | number)[],
  value: unknown,
): void {
  const parent = getValueAtKeys(data, keys.slice(0, -1));
  const last = keys.at(-1);
  if (
    last === undefined || parent === null || typeof parent !== "object" ||
    !Object.hasOwn(parent, last)
  ) {
    return;
  }
  Object.defineProperty(parent, last, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function setValueCreatingAtKeys(
  data: Record<string, unknown>,
  keys: (string | number)[],
  value: unknown,
): void {
  let current: Record<string | number, unknown> = data;
  for (const key of keys.slice(0, -1)) {
    const next = Object.hasOwn(current, key) ? current[key] : undefined;
    if (next === null || typeof next !== "object") {
      Object.defineProperty(current, key, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    current = current[key] as Record<string | number, unknown>;
  }
  const last = keys.at(-1);
  if (last === undefined) return;
  Object.defineProperty(current, last, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * snapshots original values before any mutation, prepares vault references and
 * validates all write targets, then stores the snapshots in the vault; data is
 * mutated in place
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
): Promise<VaultedFields> {
  const prepared = await prepareSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    methodName,
    specName,
    instanceName,
    callbacks,
  );
  await prepared.store();
  return { paths: prepared.paths, jsonKeys: prepared.jsonKeys };
}

interface PreparedSensitiveResourceData extends VaultedFields {
  store(): Promise<void>;
}

/**
 * the resource writer validates the final serialized bytes before committing
 * these snapshotted values, so a rejected update cannot change the secrets an
 * existing resource still references
 */
async function prepareSensitiveResourceData(
  data: Record<string, unknown>,
  spec: ResourceOutputSpec,
  vaultService: VaultService,
  modelType: ModelType,
  modelId: string,
  methodName: string,
  specName: string,
  instanceName: string,
  callbacks?: DataWriterCallbacks,
): Promise<PreparedSensitiveResourceData> {
  const { stored: fieldsWithValues, found } = findSensitiveTargets(data, spec);

  if (fieldsWithValues.length === 0) {
    return { paths: [], jsonKeys: [], store: () => Promise.resolve() };
  }

  // Validate vault availability. Reserved vaults (such as the _token-secrets
  // control-plane vault serve registers) never hold user data, so only user
  // vaults count.
  const userVaultNames = vaultService.getUserVaultNames();
  if (userVaultNames.length === 0) {
    const fieldList = fieldsWithValues.map((f) => `'${f.path}'`).join(", ");
    throw new Error(
      `Cannot persist data: fields ${fieldList} are marked as sensitive ` +
        `but no vault is configured. Create a vault using: swamp vault create <type> <name>`,
    );
  }

  // every target and key is resolved and decided under the run's vault access
  // before the first value is stored, so a refusal (even a mid-run grant revoke
  // or key-conditioned grant) leaves no field orphaned
  const keyPrefix =
    `${modelType.normalized}/${modelId}/${methodName}/${specName}/${instanceName}`;
  const targets = [];
  for (const field of fieldsWithValues) {
    const targetVault = resolveSensitiveOutputVault(
      { fieldVaultName: field.vaultName, specVaultName: spec.vaultName },
      vaultService,
    ) ?? userVaultNames[0];
    if (isReservedVaultName(targetVault)) {
      throw new Error(
        `Cannot store sensitive field '${field.path}': vault '${targetVault}' is reserved for internal use`,
      );
    }
    const vaultKey = await vaultKeyFor(field, keyPrefix);
    targets.push({ field, targetVault, vaultKey });
  }
  const targetFields = new Map<string, string>();
  for (const { field, targetVault, vaultKey } of targets) {
    const fieldName = field.path;
    const target = `${targetVault}\0${vaultKey}`;
    const previous = targetFields.get(target);
    if (previous !== undefined) {
      throw new Error(
        `Sensitive fields '${previous}' and '${fieldName}' target the same vault key in '${targetVault}'. Configure distinct vaultKey values.`,
      );
    }
    targetFields.set(target, fieldName);
  }
  const access = currentVaultAccess();
  if (access) {
    const checked = new Set<string>();
    for (const { targetVault, vaultKey } of targets) {
      const pair = `${targetVault}\0${vaultKey}`;
      if (checked.has(pair)) continue;
      checked.add(pair);
      await access.check(targetVault, "write", "put", vaultKey);
    }
  }

  const writes = targets.map(({ field, targetVault, vaultKey }) => ({
    field,
    targetVault,
    vaultKey,
    value: typeof field.originalValue === "string"
      ? field.originalValue
      : JSON.stringify(field.originalValue),
  }));
  const refOf = (targetVault: string, vaultKey: string) =>
    `\${{ vault.get('${targetVault}', '${vaultKey}') }}`;
  // a container holding another stored field is an object of those fields'
  // references, the whole container also stored under its own key; a
  // sensitiveOutput spec keeps one reference per top-level value
  const asObject = (field: SensitiveTarget) =>
    field.holdsStored === true && !spec.sensitiveOutput;
  for (const { field, targetVault, vaultKey } of writes) {
    if (!field.insideStored) {
      setValueAtKeys(
        data,
        field.keys,
        asObject(field) ? {} : refOf(targetVault, vaultKey),
      );
    }
  }
  if (!spec.sensitiveOutput) {
    // Outer fields first, so a deeper field's reference replaces an outer
    // one's, as setting dot paths in order always has.
    const inside = writes
      .filter(({ field }) => field.insideStored)
      .sort((a, b) => a.field.keys.length - b.field.keys.length);
    for (const { field, targetVault, vaultKey } of inside) {
      setValueCreatingAtKeys(data, field.keys, refOf(targetVault, vaultKey));
    }
  }

  const referenced = fieldsWithValues.filter((f) => !f.insideStored);
  const vaultedBefore = vaultedBefore3038(spec);
  return {
    // A field inside a stored value holds no reference, so every reader
    // finds nothing to resolve there; a reader that restores the outer value
    // registers the field's value as a secret.
    paths: found.map((keys) => writableAsDotPath(keys) ? keys.join(".") : keys),
    // listed as JSON-text values: those inside an element, a union member's
    // field, a field under a lazy schema, or otherwise not vaulted by older
    // writers; a container holding a stored field is never listed
    jsonKeys: referenced
      .filter((f) =>
        typeof f.originalValue !== "string" && !f.holdsStored &&
        (f.perElement || !vaultedBefore(f.keys))
      )
      .map((f) => f.keys),
    store: async () => {
      for (const { field, targetVault, vaultKey, value } of writes) {
        await vaultService.put(targetVault, vaultKey, value);
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
      }
    },
  };
}

/**
 * redacts registered secrets except inside vault references: a generated key
 * embeds the instance name, which may hold a secret, and redacting it would
 * point the reference at a key the vault lacks
 */
function redactOutsideVaultReferences(
  data: Record<string, unknown>,
  vaultedPaths: VaultedFields["paths"],
  redactor: SecretRedactor,
  sensitiveOutput: boolean,
): string {
  // The JSON shape, so dates and toJSON behave as they do in the bytes
  // that will be persisted.
  const shape: unknown = JSON.parse(JSON.stringify(data));
  // Text redaction also changes property names. Refuse sibling names that
  // would collide, rather than let a later name choose an unvaulted value
  // for a tagged field.
  if (vaultedPaths.length > 0) {
    const checkKeys = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) checkKeys(child);
      } else if (value !== null && typeof value === "object") {
        const names = new Set<string>();
        for (const [key, child] of Object.entries(value)) {
          const name = redactor.redact(JSON.stringify(key));
          if (names.has(name)) {
            throw new Error(
              "Cannot persist sensitive data: redaction would merge object property names. Use distinct names that contain no secrets.",
            );
          }
          names.add(name);
          checkKeys(child);
        }
      }
    };
    checkKeys(shape);
  }
  // A sensitive object with a sensitive field inside holds that field's
  // reference rather than its own, so only string values are references.
  const references = new Set<string>();
  const candidates = sensitiveOutput && vaultedPaths.length > 0
    ? Object.values(data)
    : vaultedPaths.map((path) =>
      typeof path === "string"
        ? getNestedValue(data, path)
        : getValueAtKeys(data, path)
    );
  for (const reference of candidates) {
    if (typeof reference === "string") references.add(reference);
  }

  const redactText = (text: string): string => {
    if (references.has(text)) return text;
    const literal = JSON.stringify(text);
    const redacted = redactor.redact(literal);
    if (redacted === literal) return text;
    try {
      const value: unknown = JSON.parse(redacted);
      if (typeof value === "string") return value;
    } catch {
      // The mask took part of the literal's quoting or an escape.
    }
    return "***";
  };
  const redactNode = (node: unknown): unknown => {
    if (typeof node === "string") return redactText(node);
    if (redactor.isSecret(JSON.stringify(node))) return "***";
    if (Array.isArray(node)) return node.map(redactNode);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map((
          [key, child],
        ) => [redactText(key), redactNode(child)]),
      );
    }
    return node;
  };
  return JSON.stringify(redactNode(shape));
}

/**
 * throws when this host cannot store the name; warns once per name that will
 * not store correctly on Windows so a Linux or macOS author sees it; the name
 * is never changed
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

    if (typeof name !== "string" || name.trim() === "") {
      throw wordedError(
        wordedText((w) =>
          `writeResource: instance name must be a non-empty string for spec '${specName}' ` +
          `in ${w.noun} '${modelType.normalized}', got ${typeof name}`
        ),
      );
    }

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

    // tag precedence, lowest to highest: type, definition, spec defaults,
    // method overrides, specName, workflow, runtime, data output overrides
    const resolvedTags: Record<string, string> = {
      type: "resource",
      ...(definitionTags ?? {}),
      ...(spec.tags ?? {}),
      ...(overrides?.tags ?? {}),
    };

    resolvedTags["specName"] = specName;

    // the modelName tag lets orphan data be recovered
    if (definitionName) {
      resolvedTags["modelName"] = definitionName;
    }

    if (tagOverrides) {
      Object.assign(resolvedTags, tagOverrides);
    }

    if (runtimeTags) {
      Object.assign(resolvedTags, runtimeTags);
    }

    let lifetime = overrides?.lifetime ?? spec.lifetime;
    let garbageCollection = overrides?.garbageCollection ??
      spec.garbageCollection;

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

    // Stamped after every override, so only the writer sets it.
    resolvedTags[RECORD_KIND_TAG] = "resource";

    checkDataNamePortability(
      instanceName,
      modelType,
      os,
      portabilityWarned,
      onEvent,
    );

    const hasSensitiveFields = effectiveSpec.sensitiveOutput ||
      schemaHoldsSensitiveFields(effectiveSpec.schema);
    if (hasSensitiveFields && !vaultService) {
      const detail = effectiveSpec.sensitiveOutput
        ? `resource '${specName}' is marked sensitiveOutput`
        : `${
          sensitiveFieldList(effectiveSpec, data)
        } in resource '${specName}' are marked as sensitive`;
      throw new Error(
        `Cannot persist data: ${detail} but no vault is configured. ` +
          `Create a vault using: swamp vault create <type> <name>`,
      );
    }
    let vaultedPaths: VaultedFields["paths"] = [];
    let sensitiveWrite: PreparedSensitiveResourceData | undefined;
    if (vaultService && methodName && hasSensitiveFields) {
      sensitiveWrite = await prepareSensitiveResourceData(
        data,
        effectiveSpec,
        vaultService,
        modelType,
        modelId,
        methodName,
        specName,
        // the vary suffix is part of the key, so each vary instance keeps its
        // own secret
        varySuffix === undefined
          ? name
          : `${name}-${await vaultKeySegment(varySuffix)}`,
        { onEvent },
      );
      vaultedPaths = sensitiveWrite.paths;
      if (vaultedPaths.length > 0) {
        if (effectiveSpec.sensitiveOutput) {
          resolvedTags[SENSITIVE_FIELDS_TAG] = SENSITIVE_FIELDS_ALL;
        } else {
          // Dot paths go where every swamp release reads them; the rest only
          // in the tag that names keys exactly.
          resolvedTags[SENSITIVE_FIELDS_TAG] = JSON.stringify(
            vaultedPaths.filter((p) => typeof p === "string"),
          );
          const keyPaths = vaultedPaths.filter((p) => Array.isArray(p));
          if (keyPaths.length > 0) {
            resolvedTags[SENSITIVE_FIELD_KEYS_TAG] = JSON.stringify(keyPaths);
          }
          if (sensitiveWrite.jsonKeys.length > 0) {
            resolvedTags[SENSITIVE_FIELD_JSON_TAG] = JSON.stringify(
              sensitiveWrite.jsonKeys,
            );
          }
        }
      }
    }

    const sensitiveFields = parseSensitiveFieldsTag(resolvedTags);
    const referenceIds = (value: Record<string, unknown>) =>
      sensitiveVaultReferences(value, sensitiveFields)
        .map((ref) => JSON.stringify([ref.vaultName, ref.key])).sort();
    const generatedReferences = referenceIds(data);
    const serialized = redactor?.hasSecrets
      ? redactOutsideVaultReferences(
        data,
        vaultedPaths,
        redactor,
        effectiveSpec.sensitiveOutput === true,
      )
      : JSON.stringify(data);
    if (vaultedPaths.length > 0) {
      // redaction keeps the payload valid JSON
      const persisted: unknown = JSON.parse(serialized);
      if (
        persisted === null || typeof persisted !== "object" ||
        Array.isArray(persisted) ||
        JSON.stringify(referenceIds(persisted as Record<string, unknown>)) !==
          JSON.stringify(generatedReferences)
      ) {
        throw new Error(
          "Cannot persist sensitive data: serialization or redaction changed the generated vault references.",
        );
      }
      resolvedTags[SENSITIVE_FIELDS_VERSION_TAG] = SENSITIVE_FIELDS_VERSION;
    }

    // Commit only after the final reference and redaction checks have passed.
    await sensitiveWrite?.store();

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
 * read sites use this tag to limit vault reference resolution to these paths,
 * so untrusted data in non-sensitive fields is never resolved as a vault
 * reference
 */
export const SENSITIVE_FIELDS_TAG = "_swamp.sensitiveFields";

/**
 * marks records written under the current write-path invariants; older records
 * can carry forged tags or unvaulted reference text, so their field tag alone
 * cannot authorize a remote resource claim
 */
export const SENSITIVE_FIELDS_VERSION_TAG = "_swamp.sensitiveFieldsVersion";
export const SENSITIVE_FIELDS_VERSION = "1";

/**
 * stamped by both writers after every override and under the reserved prefix,
 * so no user source sets it; records without it keep the schema fallback in
 * getSensitiveFieldsForResolution
 */
export const RECORD_KIND_TAG = "_swamp.kind";

export const SENSITIVE_FIELDS_ALL = "*";

const typeAuthorRemedy = (w: BehaviorWords) =>
  `The ${w.noun} type's author must remove it.`;

/**
 * readers trust reserved tags and SENSITIVE_FIELDS_TAG picks which fields
 * resolve vault references, so only vaulting may set one; the message names the
 * key and source, never the possibly sensitive value
 */
export function reservedTagRefusal(
  tags: Record<string, string> | undefined,
  source: (w: BehaviorWords) => string,
  remedy: (w: BehaviorWords) => string = () => "Remove it.",
): WordedText | undefined {
  if (!tags) return undefined;
  const key = findReservedTagKey(tags);
  if (key === undefined) return undefined;
  const reason = key.startsWith(RESERVED_TAG_PREFIX)
    ? `tag keys starting with '${RESERVED_TAG_PREFIX}' are written by swamp alone`
    : `swamp writes the '${key}' tag itself to record which spec wrote the data`;
  return wordedText((w) =>
    `Tag '${key}' from ${source(w)} is reserved: ${reason}. ${remedy(w)}`
  );
}

export function assertNoReservedTags(
  tags: Record<string, string> | undefined,
  source: (w: BehaviorWords) => string,
  remedy?: (w: BehaviorWords) => string,
): void {
  const refusal = reservedTagRefusal(tags, source, remedy);
  if (refusal) throw wordedError(refusal);
}

/**
 * tag sources that exist before the method runs; a caller checking only
 * workflow-authored sources leaves out modelType
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
 * the method execution service calls it before anything executes; the writers
 * call it again on every write, with the method's own write overrides, as the
 * backstop
 */
export function assertNoReservedRunTags(sources: RunTagSources): void {
  const refusal = reservedRunTagRefusal(sources);
  if (refusal) throw wordedError(refusal);
}

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
 * vaulted places a dot path cannot name (a key holding a dot, or __proto__) as
 * a JSON array of key lists; older releases ignore it and leave those
 * unresolved; read only alongside SENSITIVE_FIELDS_TAG
 */
export const SENSITIVE_FIELD_KEYS_TAG = "_swamp.sensitiveFieldKeys";

/**
 * vaulted places holding a non-string value stored as JSON text, as a JSON
 * array of key lists; readers parse the text back; older releases read the
 * text; used only for places SENSITIVE_FIELDS_TAG lists
 */
export const SENSITIVE_FIELD_JSON_TAG = "_swamp.sensitiveFieldJson";

function isKeyPath(value: unknown): value is (string | number)[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((key) =>
      typeof key === "string" ||
      (typeof key === "number" && Number.isSafeInteger(key) && key >= 0)
    );
}

/**
 * a tag that is not a list of key lists is ignored whole, so nothing is read
 * from it
 */
function parseKeyListTag(
  tags: Record<string, string>,
  tag: string,
): (string | number)[][] {
  const raw = tags[tag];
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isKeyPath) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * returns the vaulted places (dot paths, then key lists), * when all fields are
 * sensitive, or null when the tag is absent (legacy data); a place only the
 * JSON tag lists is ignored
 */
export function parseSensitiveFieldsTag(
  tags: Record<string, string>,
): SensitiveFieldPath[] | "*" | null {
  const raw = tags[SENSITIVE_FIELDS_TAG];
  if (raw === undefined) return null;
  if (raw === SENSITIVE_FIELDS_ALL) return SENSITIVE_FIELDS_ALL;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((v) => typeof v === "string")
    ) {
      return markJsonPlaces(
        [
          ...(parsed as string[]),
          ...parseKeyListTag(tags, SENSITIVE_FIELD_KEYS_TAG),
        ],
        parseKeyListTag(tags, SENSITIVE_FIELD_JSON_TAG),
      );
    }
    return null;
  } catch {
    return null;
  }
}

function markJsonPlaces(
  places: (string | (string | number)[])[],
  jsonKeys: (string | number)[][],
): SensitiveFieldPath[] {
  if (jsonKeys.length === 0) return places;
  const json = new Map<string, (string | number)[]>();
  for (const keys of jsonKeys) {
    json.set(JSON.stringify(keys), keys);
    if (writableAsDotPath(keys)) {
      json.set(keys.join("."), keys);
    }
  }
  return places.map((place) => {
    const keys = json.get(
      typeof place === "string" ? place : JSON.stringify(place),
    );
    return keys ? { keys, json: true } : place;
  });
}

const VAULT_REF_REGEX =
  /^\$\{\{\s*vault\.get\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)\s*\}\}$/;

/**
 * matches only the anchored text the writer puts at a vaulted path; any other
 * text, reference-looking or not, gives undefined
 */
export function parseStoredVaultReference(
  text: string,
): SecretReference | undefined {
  const match = VAULT_REF_REGEX.exec(text);
  return match ? { vaultName: match[1], key: match[2] } : undefined;
}

export const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export type SensitiveFieldsTag =
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | {
    readonly kind: "paths";
    readonly paths: readonly (readonly string[])[];
  };

/**
 * the message names the reason only, never the tag's text, which can be data
 * from outside this repository
 */
export class SensitiveFieldsTagInvalidError extends Error {
  constructor(readonly reason: string) {
    super(`The ${SENSITIVE_FIELDS_TAG} tag is invalid: ${reason}`);
    this.name = "SensitiveFieldsTagInvalidError";
  }
}

/**
 * strict read: an absent tag means no sensitive fields, * means every top-level
 * field, anything else must be the writer's JSON list of dot paths; a malformed
 * tag throws and is never read as absent
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
 * key-list segments may be empty or name a prototype property: they are object
 * keys, never a dot path, and must be read and written as own properties; a
 * malformed key-list tag is ignored whole
 */
export function readSensitiveFieldPlaces(
  tags: Record<string, string>,
): SensitiveFieldsTag {
  const tag = readSensitiveFieldsTag(tags);
  if (tag.kind !== "paths") return tag;
  const keyLists = parseKeyListTag(tags, SENSITIVE_FIELD_KEYS_TAG);
  if (keyLists.length === 0) return tag;
  return {
    kind: "paths",
    paths: [
      ...tag.paths,
      ...keyLists.map((keys) => keys.map((key) => String(key))),
    ],
  };
}

/**
 * a malformed tag is ignored whole, and a place it lists that
 * readSensitiveFieldPlaces does not is ignored
 */
export function readSensitiveFieldJsonPlaces(
  tags: Record<string, string>,
): (readonly string[])[] {
  const places = readSensitiveFieldPlaces(tags);
  if (places.kind !== "paths") return [];
  const listed = new Set(places.paths.map((path) => JSON.stringify(path)));
  return parseKeyListTag(tags, SENSITIVE_FIELD_JSON_TAG)
    .map((keys) => keys.map((key) => String(key)))
    .filter((path) => listed.has(JSON.stringify(path)));
}

/**
 * resolved values are registered with the redactor to prevent log leakage; data
 * is mutated in place
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
 * targets only the paths the writer vaulted, so untrusted data in non-sensitive
 * fields is never resolved as a vault reference; a failed read throws
 */
export async function resolveSensitiveVaultRefs(
  data: Record<string, unknown>,
  sensitiveFields: SensitiveFieldPath[] | "*",
  vaultService: VaultService,
  redactor?: SecretSink,
): Promise<void> {
  await resolveSensitiveLocations(
    data,
    sensitiveFields,
    vaultReadOf(vaultService),
    redactor,
    false,
  );
}

/**
 * for an expression read, a reference whose vault cannot be read stays as
 * stored text and is recorded unread with the provider error; the rest are
 * still read; a refusal by the run's vault access is rethrown
 */
export async function resolveSensitiveVaultRefsLeavingUnread(
  data: Record<string, unknown>,
  sensitiveFields: SensitiveFieldPath[] | "*",
  vaultService: VaultService,
  redactor?: SecretSink,
): Promise<void> {
  await resolveSensitiveLocations(
    data,
    sensitiveFields,
    vaultReadOf(vaultService),
    redactor,
    true,
  );
}

/**
 * for a read whose vault service could not be built at all; the references stay
 * as stored
 */
export async function recordSensitiveVaultRefsUnread(
  data: Record<string, unknown>,
  sensitiveFields: SensitiveFieldPath[] | "*",
  error: unknown,
  redactor?: SecretSink,
): Promise<void> {
  await resolveSensitiveLocations(
    data,
    sensitiveFields,
    () => {
      throw error;
    },
    redactor,
    true,
  );
}

type VaultRead = (vaultName: string, key: string) => Promise<string>;

function vaultReadOf(vaultService: VaultService): VaultRead {
  return (vaultName, key) =>
    vaultService.get(vaultName, key, "data-writer:vault-ref-resolve");
}

async function resolveSensitiveLocations(
  data: Record<string, unknown>,
  sensitiveFields: SensitiveFieldPath[] | "*",
  read: VaultRead,
  redactor: SecretSink | undefined,
  leaveUnread: boolean,
): Promise<void> {
  if (sensitiveFields === SENSITIVE_FIELDS_ALL) {
    // Every own key is a location by its own name, a dotted one included.
    for (const key of Object.keys(data)) {
      data[key] = await resolveValueAtPath(
        data[key],
        key,
        read,
        redactor,
        leaveUnread,
      );
    }
    return;
  }
  const restored = new Map<string, SecretReference>();
  // a place is resolved once: under an already-resolved place the content is a
  // vault-read value, never a reference to read again; outer places come first
  // so each is resolved before its fields
  const done = new Set<string>();
  const outerFirst = [...sensitiveFields].sort((a, b) =>
    placeKeysOf(a).length - placeKeysOf(b).length
  );
  for (const fieldPath of outerFirst) {
    const keys = placeKeysOf(fieldPath);
    let underResolved = false;
    for (let length = 1; length < keys.length && !underResolved; length++) {
      underResolved = done.has(placeId(keys.slice(0, length)));
    }
    done.add(placeId(keys));
    if (underResolved) continue;
    if (typeof fieldPath !== "string") {
      const reference = await resolveAtKeys(
        data,
        fieldPath,
        read,
        redactor,
        leaveUnread,
      );
      if (reference !== undefined) {
        restored.set(placeId(placeKeys(fieldPath)), reference);
      }
      continue;
    }
    const value = getNestedValue(data, fieldPath);
    const resolved = await resolveValueAtPath(
      value,
      fieldPath,
      read,
      redactor,
      leaveUnread,
    );
    if (resolved !== value) {
      if (fieldPath.includes(".")) {
        setNestedValue(data, fieldPath, resolved);
      } else {
        data[fieldPath] = resolved;
      }
    }
  }
  if (restored.size > 0 && redactor) {
    registerFieldsInsideRestored(data, sensitiveFields, restored, redactor);
  }
}

function placeId(keys: readonly (string | number)[]): string {
  return JSON.stringify(keys.map(String));
}

function placeKeysOf(place: SensitiveFieldPath): (string | number)[] {
  return typeof place === "string" ? place.split(".") : placeKeys(place);
}

function restoredAncestor(
  keys: readonly (string | number)[],
  restored: ReadonlyMap<string, SecretReference>,
): SecretReference | undefined {
  for (let length = 1; length < keys.length; length++) {
    const reference = restored.get(placeId(keys.slice(0, length)));
    if (reference !== undefined) return reference;
  }
  return undefined;
}

/**
 * registers only tagged fields inside a restored JSON place; the rest registers
 * as the whole stored text, since registering every inner string would mask
 * ordinary text (a region, a user name) all run
 */
function registerFieldsInsideRestored(
  data: Record<string, unknown>,
  sensitiveFields: SensitiveFieldPath[],
  restored: ReadonlyMap<string, SecretReference>,
  redactor: SecretSink,
): void {
  for (const fieldPath of sensitiveFields) {
    const keys = placeKeysOf(fieldPath);
    const reference = restoredAncestor(keys, restored);
    if (reference === undefined) continue;
    const value = getValueAtKeys(data, keys);
    if (value === undefined || value === null) continue;
    redactor.addSecret(
      typeof value === "string" ? value : JSON.stringify(value),
      reference,
    );
  }
}

function placeKeys(
  place: Exclude<SensitiveFieldPath, string>,
): (string | number)[] {
  return Array.isArray(place) ? place : place.keys;
}

/**
 * at a JsonSensitiveField only a reference is resolved and the secret is parsed
 * back from its JSON text, kept as text if it does not parse; it is registered
 * as the text it was stored as
 */
async function resolveAtKeys(
  data: Record<string, unknown>,
  place: Exclude<SensitiveFieldPath, string>,
  read: VaultRead,
  redactor: SecretSink | undefined,
  leaveUnread: boolean,
): Promise<SecretReference | undefined> {
  const keys = placeKeys(place);
  const json = !Array.isArray(place);
  const value = getValueAtKeys(data, keys);
  if (json && typeof value !== "string") return undefined;
  const resolved = await resolveValueAtPath(
    value,
    keys.join("."),
    read,
    redactor,
    leaveUnread,
  );
  if (resolved === value) return undefined;
  if (!json || typeof resolved !== "string") {
    setValueAtKeys(data, keys, resolved);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolved);
  } catch {
    setValueAtKeys(data, keys, resolved);
    return undefined;
  }
  setValueAtKeys(data, keys, parsed);
  return parseStoredVaultReference(value as string);
}

/**
 * one whole-string reference at each tagged location, so serve can authorize a
 * worker's read against the record; nothing nested below one is named, since
 * the writer vaults the whole value there
 */
export function sensitiveVaultReferences(
  data: Record<string, unknown>,
  sensitiveFields: SensitiveFieldPath[] | "*" | null,
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
      collect(
        typeof fieldPath === "string"
          ? getNestedValue(data, fieldPath)
          : getValueAtKeys(data, placeKeys(fieldPath)),
      );
    }
  }
  return references;
}

async function resolveValueAtPath(
  value: unknown,
  fieldPath: string,
  read: VaultRead,
  redactor: SecretSink | undefined,
  leaveUnread: boolean,
): Promise<unknown> {
  if (typeof value === "string") {
    const match = VAULT_REF_REGEX.exec(value);
    if (match) {
      const [, vaultName, key] = match;
      let resolved: string;
      try {
        resolved = await read(vaultName, key);
      } catch (error) {
        if (!leaveUnread || error instanceof VaultAccessDeniedError) {
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        logger
          .debug`Could not read sensitive field ${fieldPath} from vault ${vaultName} (key ${key}): ${reason}`;
        redactor?.recordUnread?.({
          text: value,
          vaultName,
          key,
          fieldPath,
          reason,
        });
        return value;
      }
      redactor?.addSecret(resolved, { vaultName, key });
      return resolved;
    }
    return value;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = await resolveValueAtPath(
        value[i],
        `${fieldPath}.${i}`,
        read,
        redactor,
        leaveUnread,
      );
    }
    return value;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = await resolveValueAtPath(
        record[key],
        `${fieldPath}.${key}`,
        read,
        redactor,
        leaveUnread,
      );
    }
    return record;
  }

  return value;
}

/**
 * vault references resolve only in the fields getSensitiveFieldsForResolution
 * chooses, and a malformed tag fails the read; the worker's remote context
 * builds the same reader so both executors read alike
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
 * a present tag names the fields, an invalid one fails the read; a kind-tagged
 * record without it resolves nothing; only older untagged resources fall back
 * to the spec schema, and no spec resolves nothing
 */
export function getSensitiveFieldsForResolution(
  tags: Record<string, string>,
  resourceSpecs: Record<string, ResourceOutputSpec> | undefined,
  instanceName: string,
): SensitiveFieldPath[] | "*" | null {
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
    // The strict reading passed, so the lenient one names the same dot paths,
    // with the places the key-list and JSON tags add.
    return parseSensitiveFieldsTag(tags) ?? [];
  }

  if (tags[RECORD_KIND_TAG] !== undefined) return null;
  if (tags["type"] !== "resource") return null;
  if (!resourceSpecs) return null;
  const specName = tags["specName"];
  if (!specName) return null;
  const spec = resourceSpecs[specName];
  if (!spec) return null;

  if (spec.sensitiveOutput) return SENSITIVE_FIELDS_ALL;
  const fields = extractSensitiveFields(spec.schema);
  return fields.length > 0 ? fields.map((f) => f.path) : null;
}

export function createResourceDeleter(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
): (instanceName: string) => Promise<void> {
  return async (instanceName: string): Promise<void> => {
    await repo.delete(modelType, modelId, instanceName);
  };
}

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
  getUnfinalizedReceipts: () => DeferredWriteReceipt[];
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

    if (typeof name !== "string" || name.trim() === "") {
      throw wordedError(
        wordedText((w) =>
          `createFileWriter: instance name must be a non-empty string for spec '${specName}' ` +
          `in ${w.noun} '${modelType.normalized}', got ${typeof name}`
        ),
      );
    }

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

    // tag precedence, lowest to highest: type, definition, spec defaults,
    // method overrides, specName, workflow, runtime, data output overrides
    const resolvedTags: Record<string, string> = {
      type: "file",
      ...(definitionTags ?? {}),
      ...(spec.tags ?? {}),
      ...(overrides?.tags ?? {}),
    };

    resolvedTags["specName"] = specName;

    // the modelName tag lets orphan data be recovered
    if (definitionName) {
      resolvedTags["modelName"] = definitionName;
    }

    if (tagOverrides) {
      Object.assign(resolvedTags, tagOverrides);
    }

    if (runtimeTags) {
      Object.assign(resolvedTags, runtimeTags);
    }

    const contentType = overrides?.contentType ?? spec.contentType;
    let lifetime = overrides?.lifetime ?? spec.lifetime;
    let garbageCollection = overrides?.garbageCollection ??
      spec.garbageCollection;
    const streaming = overrides?.streaming ?? spec.streaming;

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
          instanceName = `${instanceName}-${override.resolvedVarySuffix}`;
        }
      }
    }

    resolvedTags[RECORD_KIND_TAG] = "file";

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
    getUnfinalizedReceipts: () => {
      const receipts: DeferredWriteReceipt[] = [];
      for (const writer of writers) {
        const unfinalized = writer.getUnfinalizedReceipt();
        if (unfinalized) receipts.push(unfinalized);
      }
      return receipts;
    },
  };
}
