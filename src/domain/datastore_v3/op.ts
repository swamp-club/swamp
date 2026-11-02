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

/**
 * ops are built by factories, never literals: putOp computes a put's digest so
 * it matches its bytes, and the commit checks each op is one of these classes;
 * tombstones are by exact key, never by prefix
 */

import {
  type DataMetadata,
  DataMetadataSchema,
} from "../data/data_metadata.ts";
import { BlobRef, type BlobRefJSON, isSha256Hex } from "./blob_ref.ts";
import { type FileAccess, readFileAccess } from "./file_access.ts";
import { createIntent, type Intent } from "./intent.ts";
import { RecordKey } from "./record_key.ts";
import { formatUntrustedIssues, parseUntrusted } from "../untrusted_parse.ts";

export const MAX_INLINE_BYTES = 8 * 1024;

const MAX_INLINE_BASE64_LENGTH = Math.ceil(MAX_INLINE_BYTES / 3) * 4;

const MAX_HOLDER_LENGTH = 1024;

export type PutExpect = "absent" | { readonly sha256: string };

export type TombstoneExpect = "present" | { readonly sha256: string };

export interface PutOpJSON {
  readonly kind: "put";
  readonly intent: Intent;
  readonly key: string;
  readonly blob?: BlobRefJSON;
  readonly inline?: string;
  readonly expect?: PutExpect;
  readonly access?: FileAccess;
}

export interface TombstoneOpJSON {
  readonly kind: "tombstone";
  readonly intent: Intent;
  readonly key: string;
  readonly expect?: TombstoneExpect;
}

export interface DataVersionOpJSON {
  readonly kind: "data-version";
  readonly key: string;
  readonly metadata: DataMetadata;
}

export interface LeaseOpJSON {
  readonly kind: "lease";
  readonly holder: string;
  readonly fence: number;
}

export type OpJSON =
  | PutOpJSON
  | TombstoneOpJSON
  | DataVersionOpJSON
  | LeaseOpJSON;

/** Held only by this module, so ops are built through its factories. */
const BUILD: unique symbol = Symbol("Op.build");

export class PutOp {
  readonly kind = "put" as const;

  private constructor(
    readonly intent: Intent,
    readonly key: RecordKey,
    readonly content:
      | { readonly blob: BlobRef }
      | { readonly inline: string },
    readonly sha256: string,
    readonly expect: PutExpect | undefined,
    readonly access: FileAccess | undefined,
  ) {}

  static build(
    token: typeof BUILD,
    intent: Intent,
    key: RecordKey,
    content: { readonly blob: BlobRef } | { readonly inline: string },
    sha256: string,
    expect: PutExpect | undefined,
    access: FileAccess | undefined,
  ): PutOp {
    if (token !== BUILD) throw new Error("Use putOp() to build a put");
    return Object.freeze(
      new PutOp(
        intent,
        key,
        Object.freeze({ ...content }),
        sha256,
        expect,
        access,
      ),
    );
  }

  /**
   * The serialized form. It never includes the inline digest: a reader
   * recomputes it ({@link opFromJSON}), so a stored digest cannot disagree
   * with the bytes.
   */
  toJSON(): PutOpJSON {
    return {
      kind: "put",
      intent: this.intent,
      key: this.key.toString(),
      ...("blob" in this.content
        ? { blob: this.content.blob.toJSON() }
        : { inline: this.content.inline }),
      ...(this.expect === undefined ? {} : { expect: this.expect }),
      ...(this.access === undefined ? {} : { access: this.access }),
    };
  }
}

export class TombstoneOp {
  readonly kind = "tombstone" as const;

  private constructor(
    readonly intent: Intent,
    readonly key: RecordKey,
    readonly expect: TombstoneExpect | undefined,
  ) {}

  static build(
    token: typeof BUILD,
    intent: Intent,
    key: RecordKey,
    expect: TombstoneExpect | undefined,
  ): TombstoneOp {
    if (token !== BUILD) {
      throw new Error("Use tombstoneOp() to build a tombstone");
    }
    return Object.freeze(new TombstoneOp(intent, key, expect));
  }

  toJSON(): TombstoneOpJSON {
    return {
      kind: "tombstone",
      intent: this.intent,
      key: this.key.toString(),
      ...(this.expect === undefined ? {} : { expect: this.expect }),
    };
  }
}

export class DataVersionOp {
  readonly kind = "data-version" as const;

  private constructor(
    readonly key: RecordKey,
    readonly metadata: DataMetadata,
  ) {}

  static build(
    token: typeof BUILD,
    key: RecordKey,
    metadata: DataMetadata,
  ): DataVersionOp {
    if (token !== BUILD) {
      throw new Error("Use dataVersionOp() to build a data-version op");
    }
    return Object.freeze(new DataVersionOp(key, metadata));
  }

  toJSON(): DataVersionOpJSON {
    return {
      kind: "data-version",
      key: this.key.toString(),
      metadata: this.metadata,
    };
  }
}

export class LeaseOp {
  readonly kind = "lease" as const;

  private constructor(
    readonly holder: string,
    readonly fence: number,
  ) {}

  static build(token: typeof BUILD, holder: string, fence: number): LeaseOp {
    if (token !== BUILD) throw new Error("Use leaseOp() to build a lease");
    return Object.freeze(new LeaseOp(holder, fence));
  }

  toJSON(): LeaseOpJSON {
    return { kind: "lease", holder: this.holder, fence: this.fence };
  }
}

export type Op = PutOp | TombstoneOp | DataVersionOp | LeaseOp;

export function isOp(value: unknown): value is Op {
  return value instanceof PutOp || value instanceof TombstoneOp ||
    value instanceof DataVersionOp || value instanceof LeaseOp;
}

/**
 * exactly one of blob and inline is given; inline must be canonical base64
 * (re-encoding its decoded bytes gives it back) of at most MAX_INLINE_BYTES
 */
export async function putOp(props: {
  intent: Intent;
  key: RecordKey;
  blob?: BlobRef;
  inline?: string;
  expect?: PutExpect;
  access?: FileAccess;
}): Promise<PutOp> {
  const intent = createIntent(props.intent);
  const key = requireKey(props.key);
  const expect = readPutExpect(props.expect);
  const access = readFileAccess(props.access);
  if ((props.blob === undefined) === (props.inline === undefined)) {
    throw new Error("A put carries exactly one of blob and inline");
  }
  if (props.blob !== undefined) {
    if (!(props.blob instanceof BlobRef)) {
      throw new TypeError("A put's blob must be a BlobRef");
    }
    return PutOp.build(
      BUILD,
      intent,
      key,
      { blob: props.blob },
      props.blob.sha256,
      expect,
      access,
    );
  }
  const inline = props.inline as string;
  const bytes = decodeInline(inline);
  return PutOp.build(
    BUILD,
    intent,
    key,
    { inline },
    await sha256Hex(bytes),
    expect,
    access,
  );
}

export function tombstoneOp(props: {
  intent: Intent;
  key: RecordKey;
  expect?: TombstoneExpect;
}): TombstoneOp {
  return TombstoneOp.build(
    BUILD,
    createIntent(props.intent),
    requireKey(props.key),
    readTombstoneExpect(props.expect),
  );
}

const MAX_REPORTED_METADATA_ISSUES = 10;

export function dataVersionOp(props: {
  key: RecordKey;
  metadata: unknown;
}): DataVersionOp {
  // a commit envelope carries this from its caller, so the parse stops at the
  // first failure in each container
  const parsed = parseUntrusted(DataMetadataSchema, props.metadata);
  if (!parsed.success) {
    throw new Error(
      `A data-version op needs valid data metadata: ${
        formatUntrustedIssues(parsed.error.issues, MAX_REPORTED_METADATA_ISSUES)
      }`,
    );
  }
  // Tags in key order, so equal metadata serializes equally; frozen, so the
  // op cannot change after a commit holds it.
  const tags = Object.fromEntries(
    Object.entries(parsed.data.tags).sort((
      [a],
      [b],
    ) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return DataVersionOp.build(
    BUILD,
    requireKey(props.key),
    deepFreeze({ ...parsed.data, tags }),
  );
}

export function leaseOp(props: { holder: string; fence: number }): LeaseOp {
  if (
    typeof props.holder !== "string" || props.holder.length === 0 ||
    props.holder.length > MAX_HOLDER_LENGTH
  ) {
    throw new Error(
      `A lease holder must be a non-empty string of at most ${MAX_HOLDER_LENGTH} characters`,
    );
  }
  requireFence(props.fence);
  return LeaseOp.build(BUILD, props.holder, props.fence);
}

export async function opFromJSON(value: unknown): Promise<Op> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("An op must be an object");
  }
  const json = value as Record<string, unknown>;
  switch (json.kind) {
    case "put":
      requireOnlyFields(json, [
        "kind",
        "intent",
        "key",
        "blob",
        "inline",
        "expect",
        "access",
      ]);
      return await putOp({
        intent: json.intent as Intent,
        key: RecordKey.fromJSON(json.key),
        blob: json.blob === undefined ? undefined : BlobRef.fromJSON(json.blob),
        inline: json.inline as string | undefined,
        expect: json.expect as PutExpect | undefined,
        access: json.access as FileAccess | undefined,
      });
    case "tombstone":
      requireOnlyFields(json, ["kind", "intent", "key", "expect"]);
      return tombstoneOp({
        intent: json.intent as Intent,
        key: RecordKey.fromJSON(json.key),
        expect: json.expect as TombstoneExpect | undefined,
      });
    case "data-version":
      requireOnlyFields(json, ["kind", "key", "metadata"]);
      return dataVersionOp({
        key: RecordKey.fromJSON(json.key),
        metadata: json.metadata,
      });
    case "lease":
      requireOnlyFields(json, ["kind", "holder", "fence"]);
      return leaseOp({
        holder: json.holder as string,
        fence: json.fence as number,
      });
    default:
      throw new Error(`Unknown op kind: ${String(json.kind)}`);
  }
}

export function requireFence(fence: unknown): asserts fence is number {
  if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 0) {
    throw new Error(`A fence must be a non-negative integer: ${String(fence)}`);
  }
}

function readPutExpect(expect: unknown): PutExpect | undefined {
  if (expect === undefined || expect === "absent") return expect;
  if (typeof expect === "object" && expect !== null && !Array.isArray(expect)) {
    const json = expect as Record<string, unknown>;
    if (Object.keys(json).length === 1 && isSha256Hex(json.sha256)) {
      return Object.freeze({ sha256: json.sha256 });
    }
  }
  throw new Error(
    "A put's expect must be 'absent' or { sha256 } with a lowercase hex digest",
  );
}

function readTombstoneExpect(
  expect: unknown,
): TombstoneExpect | undefined {
  if (expect === undefined || expect === "present") return expect;
  if (typeof expect === "object" && expect !== null && !Array.isArray(expect)) {
    const json = expect as Record<string, unknown>;
    if (Object.keys(json).length === 1 && isSha256Hex(json.sha256)) {
      return Object.freeze({ sha256: json.sha256 });
    }
  }
  throw new Error(
    "A tombstone's expect must be 'present' or { sha256 } with a lowercase " +
      `hex digest: ${JSON.stringify(expect)}`,
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requireKey(key: unknown): RecordKey {
  if (!(key instanceof RecordKey)) {
    throw new TypeError("An op's key must be a RecordKey");
  }
  return key;
}

function decodeInline(inline: unknown): Uint8Array<ArrayBuffer> {
  if (typeof inline !== "string") {
    throw new TypeError("A put's inline content must be a base64 string");
  }
  if (inline.length > MAX_INLINE_BASE64_LENGTH) {
    throw new Error(
      `Inline content is larger than ${MAX_INLINE_BYTES} bytes; store it as a blob`,
    );
  }
  let binary: string;
  try {
    binary = atob(inline);
  } catch {
    throw new Error("A put's inline content is not valid base64");
  }
  if (btoa(binary) !== inline) {
    throw new Error("A put's inline content is not canonical base64");
  }
  if (binary.length > MAX_INLINE_BYTES) {
    throw new Error(
      `Inline content is larger than ${MAX_INLINE_BYTES} bytes; store it as a blob`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function requireOnlyFields(
  json: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const field of Object.keys(json)) {
    if (!allowed.includes(field)) {
      throw new Error(
        `Op ${String(json.kind)} does not take the field '${field}'`,
      );
    }
  }
}
