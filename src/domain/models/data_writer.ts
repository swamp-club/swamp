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
  /** Whether `getFilePath` handed the caller the content path. */
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
   * The version a non-deferred writer allocated through `getFilePath` but
   * never finalised: content with no metadata, which nothing commits or
   * claims later, so a failed method rolls it back (swamp-club#3736).
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
 * (has fields marked `{ sensitive: true }`, wherever they sit in the schema,
 * or `sensitiveOutput: true`).
 */
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
 * Where a vaulted value sits in resource data. A string is a dot-separated
 * path (`spec.services.0.image.token`, an array index written as its digits),
 * the form every swamp release reads from {@link SENSITIVE_FIELDS_TAG}. An
 * array lists the object keys and array indexes that lead to the value, for a
 * place a dot path cannot name (see {@link SENSITIVE_FIELD_KEYS_TAG}).
 */
export type SensitiveFieldPath =
  | string
  | (string | number)[]
  | JsonSensitiveField;

/**
 * A vaulted place whose vault value is JSON text written for a value that was
 * not a string (see {@link SENSITIVE_FIELD_JSON_TAG}): it is parsed back to
 * that value once resolved.
 */
export interface JsonSensitiveField {
  keys: (string | number)[];
  json: true;
}

/** What {@link processSensitiveResourceData} stored. */
export interface VaultedFields {
  /**
   * Where each value whose reference the data now holds sits, and each
   * stored sensitive field inside one of them, whose value readers register
   * as a secret once the outer value is restored: a dot path where one names
   * it for every swamp release, else its keys.
   */
  paths: (string | (string | number)[])[];
  /**
   * The keys of each value that was not a string, and so is stored as JSON
   * text, that the writer before swamp-club#3038 did not vault: one inside an
   * array element or record value, a union member's field, a field under a
   * lazy schema.
   */
  jsonKeys: (string | number)[][];
}

/** A value in resource data to be stored in a vault. */
interface SensitiveTarget {
  /** The object keys and array indexes that lead to the value. */
  keys: (string | number)[];
  /** The path shown in messages and events. */
  path: string;
  vaultName?: string;
  vaultKey?: string;
  /**
   * Whether the value sits inside an array element or record value, and so
   * needs a vault key of its own per element.
   */
  perElement: boolean;
  /** The value before any reference replaced it. */
  originalValue: unknown;
  /**
   * Whether the value sits inside another value being stored. It is still
   * stored under its own key, as it always has been, so a reader of that
   * key keeps getting the current value, but the data keeps the outer
   * reference in its place.
   */
  insideStored?: boolean;
  /**
   * Whether another value being stored sits inside this one, marked
   * `insideStored`: outside a `sensitiveOutput` spec the data then holds an
   * object of those values' references here, not one reference.
   */
  holdsStored?: boolean;
  /**
   * Whether the value is a top-level value of a `sensitiveOutput` spec, read
   * and written by its own key, never as a dot path (swamp-club#3529).
   */
  ownKey?: boolean;
}

/**
 * Finds the values in `data` to store in a vault: every value under a field
 * marked `{ sensitive: true }` wherever it sits — nested objects, array
 * elements, record values, union members — and, for a `sensitiveOutput`
 * spec, every top-level value. Absent and null values are left out. A value
 * inside another one being stored is carried by the outer value: one outside
 * any array element or record value is still stored under its own key
 * (marked `insideStored`), one inside an element is not stored again.
 *
 * @returns The values to store, and the keys of every value found, those
 *   carried by an outer value included, in the order found
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
 * Whether the writer before swamp-club#3038 stored the value `keys` lead to
 * in a vault: a field it found by walking nested objects alone
 * ({@link extractSensitiveFields}), looked up by a dot path, so through keys
 * holding no dot. Such a value has always read back as its JSON text when it
 * was not a string (swamp-club#3480); any other is newly vaulted, and reads
 * back as written.
 */
function vaultedBefore3038(
  spec: ResourceOutputSpec,
): (keys: (string | number)[]) => boolean {
  const paths = new Set(extractSensitiveFields(spec.schema).map((f) => f.path));
  return (keys) =>
    keys.every((key) => typeof key === "string" && !key.includes(".")) &&
    paths.has(keys.join("."));
}

/**
 * The JSON of the shortest strict prefix of `keys` that is one of the
 * `stored` key lists, or undefined when there is none. That prefix has no
 * stored ancestor itself, so the data holds its reference.
 */
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

/**
 * Names the sensitive fields of a spec for an error message: the fields in
 * nested objects, else the values found in `data` inside array elements,
 * record values and union members.
 */
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
 * A record key kept as written in an element vault key: lowercase only, since
 * capitals fold onto lowercase in a case-insensitive vault (Azure Key Vault,
 * or local_encryption on a case-insensitive file system), as
 * {@link vaultKeySegment} keeps a vary suffix.
 */
const PLAIN_KEY = /^[a-z0-9_-]+$/;

/** The first `hexDigits` hex digits of the SHA-256 of `text`. */
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
 * The longest vault key given to a value inside an element. Vault providers
 * map keys to file and secret names, which have length limits of their own.
 */
const MAX_ELEMENT_VAULT_KEY_LENGTH = 200;

/**
 * Encodes the place of a value inside an array element or record value for a
 * vault key: keys and indexes joined with dots, each run of other characters
 * in a key turned into `-`. Record keys come from resource data, so this
 * keeps quotes, slashes and `..` out of the key. When a key is not
 * {@link PLAIN_KEY} (it holds a capital or another character), the first 12
 * hex digits of the SHA-256 of the exact keys are appended, so two keys that
 * differ only in such characters, or only in case, still get distinct vault
 * keys in a case-insensitive vault, and every element keeps the same vault
 * key from write to write.
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
 * The vault key a target is stored under. A value outside any element keeps
 * the key swamp has always given it: the field's `vaultKey`, or one derived
 * from the model, method, spec, instance and field path (for a dotted own
 * key of a `sensitiveOutput` spec, a hash of its name). A value inside an
 * element gets one key per element: its encoded place is appended to the
 * field's `vaultKey`, or derived the same way, so elements never share a key.
 * Such a key longer than {@link MAX_ELEMENT_VAULT_KEY_LENGTH} is cut, and ends
 * in a hash of the whole key.
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
 * Whether a dot path names exactly the place `keys` lead to for every swamp
 * release reading it: no key holds a dot, which those readers would split
 * on, and none is empty or one of {@link UNSAFE_PATH_SEGMENTS}, which
 * {@link readSensitiveFieldsTag} refuses.
 */
function writableAsDotPath(keys: (string | number)[]): boolean {
  return keys.every((key) =>
    typeof key === "number" ||
    (key !== "" && !key.includes(".") && !UNSAFE_PATH_SEGMENTS.has(key))
  );
}

/**
 * Reads the value `keys` lead to in `data`, following own properties only.
 */
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
 * Replaces the value `keys` lead to in `data`. Nothing is written when that
 * place does not exist: no container is created, and a key is only ever
 * written as an own property (never through `__proto__`).
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

/**
 * Sets the value `keys` lead to in `data`, replacing each missing or
 * non-object step on the way with an empty object, as {@link setNestedValue}
 * does, but writing every key as an own property.
 */
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
 * Processes sensitive fields in resource data before persistence.
 *
 * For each value under a field marked with `{ sensitive: true }` metadata in
 * the schema — in nested objects, array elements, record values and union
 * members — or every top-level value when `sensitiveOutput` is true on the
 * spec:
 * 1. Snapshots original values before any mutation
 * 2. Prepares vault references and validates all write targets
 * 3. Stores the snapshotted values in the vault
 *
 * A value inside an array element or record value is stored under a vault
 * key of its own per element (see {@link vaultKeyFor}).
 *
 * @param data - The resource data to process (mutated in place)
 * @param spec - The resource output specification
 * @param vaultService - The vault service for storing values
 * @param modelType - The model type (for vault key generation)
 * @param modelId - The model ID (for vault key generation)
 * @param methodName - The method name (for vault key generation)
 * @returns The places to tag, each value whose reference the data now
 *   holds and each marked field inside one of them, and which of those
 *   values are stored as JSON text
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
 * Replaces fields in the working data with their references without writing
 * the vault. The resource writer validates the final serialized bytes before
 * committing these snapshotted values, so a rejected update cannot change
 * the secrets an existing resource still references.
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

  // Every target and key is resolved, and decided under the run's vault
  // access with the key the put will name, before the first value is stored,
  // so a refusal (including one from a grant revoked mid-run, or a grant
  // conditioned on the key) leaves no earlier field's value orphaned.
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
      await access.check(targetVault, "write", vaultKey);
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
  // A container that holds another stored field keeps the shape it has
  // always had: an object of those fields' references, the whole container
  // stored under its own key as well. Expressions read each field as a
  // Secret, through the container. Its unmarked fields are not in the data,
  // as before swamp-club#3038; the vault holds them in the container's value.
  // A sensitiveOutput spec keeps each top-level value as one reference.
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
    // Before this release such a value was not vaulted, so it read back as
    // itself, not as text: an element, a union member's field, a field under
    // a lazy schema. A container that holds a stored field is an object of
    // references, not one, so it is never listed.
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
 * Redacts registered secrets from the resource payload as it will be
 * persisted, except inside the vault references
 * {@link processSensitiveResourceData} put at `vaultedPaths`. A generated
 * vault key embeds the instance name, which can contain a resolved secret,
 * so redacting the reference would point it at a key the vault does not
 * hold (swamp-club#3585).
 *
 * The payload is redacted node by node in its JSON shape and serialized
 * after, so what is persisted stays valid JSON (swamp-club#3754). A string,
 * and an object key, is redacted as it reads in the JSON text, as the whole
 * text was before, and a mask that breaks its quoting covers it whole. A
 * number, boolean or null whose JSON text is itself a registered secret (a
 * sensitive number) becomes the string `***`, and so does an object or array
 * whose JSON text is (a JSON secret written back as an object); a number
 * that only contains a secret's digits is kept, where masking the substring
 * would have broken the syntax.
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

    // Stamped after every override, so only the writer sets it.
    resolvedTags[RECORD_KIND_TAG] = "resource";

    checkDataNamePortability(
      instanceName,
      modelType,
      os,
      portabilityWarned,
      onEvent,
    );

    // Process sensitive fields before serialization
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
        // The vary suffix is part of the key, so each vary instance keeps its
        // own secret (swamp-club#3633).
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
      // Redaction keeps the payload valid JSON (swamp-club#3754).
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
 * Tag key used to record which field paths were vaulted on write.
 * Read sites use this tag to limit vault reference resolution to only
 * those paths, preventing untrusted data in non-sensitive fields from
 * being resolved as vault references.
 */
export const SENSITIVE_FIELDS_TAG = "_swamp.sensitiveFields";

/**
 * Marks records vaulted after reserved tags, dotted own-key handling and
 * final serialized reference validation became write-path invariants.
 * Older records can contain forged tags or
 * unvaulted reference text, so their field tag alone cannot authorize a
 * remote resource claim (swamp-club#3529). Only the resource writer sets it.
 */
export const SENSITIVE_FIELDS_VERSION_TAG = "_swamp.sensitiveFieldsVersion";
export const SENSITIVE_FIELDS_VERSION = "1";

/**
 * Tag key recording which writer made a record: `resource` or `file`. Both
 * writers stamp it after every override, and it sits under
 * {@link RESERVED_TAG_PREFIX}, so no user source can set it. A record that
 * carries it was written by a writer that tags every field it vaults with
 * {@link SENSITIVE_FIELDS_TAG}, so {@link getSensitiveFieldsForResolution}
 * keeps the schema fallback for records without it (swamp-club#3684).
 */
export const RECORD_KIND_TAG = "_swamp.kind";

/**
 * Sentinel value for the {@link SENSITIVE_FIELDS_TAG} tag when all fields
 * are sensitive (`sensitiveOutput: true` on the resource spec).
 */
export const SENSITIVE_FIELDS_ALL = "*";

/** Who must remove a reserved tag that a type's own code supplies. */
const typeAuthorRemedy = (w: BehaviorWords) =>
  `The ${w.noun} type's author must remove it.`;

/**
 * The refusal of a reserved tag key (`isReservedTagKey`: one under
 * {@link RESERVED_TAG_PREFIX}, or `specName`) from a source swamp does not
 * control (swamp-club#3635, swamp-club#3684), or undefined when `tags` holds
 * none. Readers trust these tags as swamp's own, and
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
  const reason = key.startsWith(RESERVED_TAG_PREFIX)
    ? `tag keys starting with '${RESERVED_TAG_PREFIX}' are written by swamp alone`
    : `swamp writes the '${key}' tag itself to record which spec wrote the data`;
  return wordedText((w) =>
    `Tag '${key}' from ${source(w)} is reserved: ${reason}. ${remedy(w)}`
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
 * Tag key recording vaulted places a dot path cannot name for every swamp
 * release — a place reached through a key holding a dot, or through
 * `__proto__` — as a JSON array of key lists
 * (`[["accounts","eu.west","token"]]`). Releases that predate it ignore it
 * and leave those references unresolved; it is read only alongside
 * {@link SENSITIVE_FIELDS_TAG}.
 */
export const SENSITIVE_FIELD_KEYS_TAG = "_swamp.sensitiveFieldKeys";

/**
 * Tag key recording vaulted places whose value was not a string and that the
 * writer before swamp-club#3038 did not vault (inside array elements and
 * record values, union members' fields), as a JSON array of key lists. Their
 * vault value is the JSON text of that value, which readers parse back so it
 * reads as it was written (a number, an object). Releases that
 * predate it ignore it and read the JSON text; it is read only alongside
 * {@link SENSITIVE_FIELDS_TAG}, and only for places that tag lists.
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
 * Reads a tag holding key lists ({@link SENSITIVE_FIELD_KEYS_TAG},
 * {@link SENSITIVE_FIELD_JSON_TAG}). A tag that is not a list of key lists is
 * ignored whole, so nothing is read from it.
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
 * Parses the `_swamp.sensitiveFields` tag from a data record's tags, with the
 * places {@link SENSITIVE_FIELD_KEYS_TAG} adds to it. A place
 * {@link SENSITIVE_FIELD_JSON_TAG} lists comes back as a
 * {@link JsonSensitiveField}; one it lists that neither of the other tags
 * names is ignored.
 *
 * @returns The vaulted places (dot paths, then key lists), `"*"` when all
 *          fields are sensitive, or `null` when the tag is absent (legacy
 *          data).
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

/**
 * Replaces each place in `places` that `jsonKeys` lists with a
 * {@link JsonSensitiveField}. A dot path matches the keys it joins; a key
 * list matches the same keys.
 */
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
 * The vaulted places of a record as the expression-facing accessors read
 * them: {@link readSensitiveFieldsTag}, strictly, with each key list
 * {@link SENSITIVE_FIELD_KEYS_TAG} adds to a path list as one more path of
 * segments, an array index written as its digits. The key-list tag is read as
 * {@link parseSensitiveFieldsTag} reads it, only alongside a path list and a
 * malformed one ignored whole, so its places stay as stored text. Its segments
 * may be empty or name a prototype property: they are object keys, never a
 * dot path, and must be read and written as own properties.
 * {@link SENSITIVE_FIELD_JSON_TAG} adds nothing here: a place it lists is
 * already a path of one of the other two tags.
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
 * The vaulted places of a record whose vault value is the JSON text of a
 * value that is not a string, as {@link SENSITIVE_FIELD_JSON_TAG} lists
 * them: segment lists, an array index written as its digits, as
 * {@link readSensitiveFieldPlaces} spells them. The tag is read as
 * {@link parseSensitiveFieldsTag} reads it, only alongside a path list and a
 * malformed one ignored whole, and a place it lists that
 * {@link readSensitiveFieldPlaces} does not is ignored.
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
 * non-sensitive fields from being resolved as vault references. A read that
 * fails throws.
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
 * {@link resolveSensitiveVaultRefs} for an expression's data read, where a
 * reference whose vault cannot be read stays as stored text. Each reference
 * is read on its own: one that fails is logged at debug and goes to
 * `redactor.recordUnread` with the vault, key and provider error, and the
 * remaining references are still read (swamp-club#3806). A refusal by the
 * run's vault access is rethrown.
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
 * Records every reference at a record's tagged sensitive locations as unread
 * with `error`, for a read whose vault service could not be built at all. The
 * references stay as stored, as
 * {@link resolveSensitiveVaultRefsLeavingUnread} leaves a reference whose
 * read fails.
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

/** Reads the secret a stored reference names. */
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
  // Each JSON place restored to a value, by its keys, with the reference
  // it was read from.
  const restored = new Map<string, SecretReference>();
  // Every place already resolved. A place is resolved once: under a place
  // resolved before it, what is there is a value read from a vault,
  // reference-shaped text included, never a reference to read again. A
  // container tagged beside its fields resolves their references as it is
  // walked; inside a restored JSON place a tagged field is only registered,
  // below. Outer places come first, so each is resolved before its fields.
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

/** Identifies a place by its keys, an array index and its digits alike. */
function placeId(keys: readonly (string | number)[]): string {
  return JSON.stringify(keys.map(String));
}

/** The keys of any vaulted place, a dot path split at its dots. */
function placeKeysOf(place: SensitiveFieldPath): (string | number)[] {
  return typeof place === "string" ? place.split(".") : placeKeys(place);
}

/**
 * The reference of the restored JSON place a strict prefix of `keys` names,
 * or undefined when no prefix is one.
 */
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
 * Registers with `redactor` the value of each tagged place inside a JSON
 * place that was restored: a sensitive field the schema marks inside a
 * stored container, which the writer tags beside the container. The rest of
 * a restored value is registered only as the whole text it was stored as,
 * as any non-string sensitive value is: registering every string inside it
 * would mask ordinary text (a region, a user name) wherever it appears for
 * the rest of the run, in logs and in the records the run persists.
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

/**
 * The object keys and array indexes of a vaulted place named by its keys.
 */
function placeKeys(
  place: Exclude<SensitiveFieldPath, string>,
): (string | number)[] {
  return Array.isArray(place) ? place : place.keys;
}

/**
 * Resolves the vault reference at a place named by its keys. At a
 * {@link JsonSensitiveField} only a reference is resolved, and the secret is
 * parsed back from the JSON text it was stored as; text that does not parse
 * is kept as the secret. The secret is registered with `redactor` as the
 * text it was stored as, as every resolved reference is.
 *
 * @returns The reference a JSON place was restored from, else undefined
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
 * The vault references a record's sensitive fields hold, in the shape
 * {@link processSensitiveResourceData} leaves them: one whole-string
 * reference exactly at each tagged location, which is the value at each
 * path the sensitive-fields tags list, or the value of each top-level key
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
 * Creates a readResource function bound to a specific execution context.
 *
 * The returned function reads previously stored resource data by instance name,
 * returning the parsed JSON object or null if no data exists.
 * When a VaultService is provided, vault reference expressions are resolved
 * only in the fields {@link getSensitiveFieldsForResolution} chooses: those
 * the `_swamp.sensitiveFields` tag names, or, for an untagged record written
 * before the writers stamped {@link RECORD_KIND_TAG}, those the resource spec
 * schema marks sensitive. A malformed tag fails the read.
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
 * being read as absent. Without the tag, a record carrying
 * {@link RECORD_KIND_TAG} had nothing vaulted at write time, so nothing
 * resolves: its `specName` and `type` tags are never consulted, since user
 * tag sources could once overwrite them (swamp-club#3684). Only a record
 * written before the writers stamped their kind falls back to the resource
 * spec's schema, found by the record's `specName` tag, and only when its
 * `type` tag says it is a resource; without specs, a spec name or a matching
 * spec nothing resolves, the secure default.
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
