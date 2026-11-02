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
 * content is written before the record, so a held record always has its
 * content; a crash between leaves only content no record names
 */

export const QUARANTINE_HELD_PREFIX = "quarantine/";
export const QUARANTINE_ACCEPTED_PREFIX = "quarantine-accepted/";
export const QUARANTINE_DISCARDED_PREFIX = "quarantine-discarded/";
export const QUARANTINE_CONTENT_PREFIX = "quarantine-content/";

/**
 * a control plane write holds the whole record in memory, so this stays far
 * below what one commit may carry; a larger change stays quarantined in its
 * author's checkout only
 */
export const MAX_QUARANTINE_DEPOSIT_BYTES = 32 * 1024 * 1024;
export const MAX_QUARANTINED_PER_PRINCIPAL = 32;
export const MAX_QUARANTINED = 1024;
/**
 * The most bytes of deposits one principal has held at once: with the
 * count cap, so 32 deposits near the per-deposit limit cannot all be kept.
 */
export const MAX_QUARANTINED_BYTES_PER_PRINCIPAL = 128 * 1024 * 1024;
const MAX_REASON_LENGTH = 2048;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface QuarantineRecord {
  readonly txnId: string;
  readonly partition: string;
  readonly principal: string;
  /**
   * an accept judges the content with the author's access, never the admin's,
   * using the membership serve last saw; absent on a record kept before they
   * were recorded, which then judges with none
   */
  readonly groups?: readonly string[];
  readonly collectives?: readonly string[];
  readonly reason: string;
  readonly depositedAt: string;
  readonly bytes: number;
  readonly state: "held" | "accepted" | "discarded";
  readonly acceptedBy?: string;
  readonly acceptedAt?: string;
  readonly seq?: number;
  readonly discardedBy?: string;
  readonly discardedAt?: string;
}

export const MAX_RECORDED_MEMBERSHIPS = 256;

function prefixOf(state: QuarantineRecord["state"]): string {
  switch (state) {
    case "held":
      return QUARANTINE_HELD_PREFIX;
    case "accepted":
      return QUARANTINE_ACCEPTED_PREFIX;
    case "discarded":
      return QUARANTINE_DISCARDED_PREFIX;
  }
}

export interface QuarantineChunk {
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface QuarantineContent {
  readonly commit: unknown;
  readonly base: { readonly seq: number; readonly txnId?: string };
  readonly chunks: readonly QuarantineChunk[];
}

export class QuarantineRecordInvalidError extends Error {
  constructor(what: string, detail: string) {
    super(`The quarantined change's ${what} is not valid: ${detail}`);
    this.name = "QuarantineRecordInvalidError";
  }
}

export function isQuarantineTxnId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function quarantineRecordKey(
  state: QuarantineRecord["state"],
  txnId: string,
  principalKey: string,
): string {
  return `${prefixOf(state)}${txnId}/${principalKey}`;
}

export function quarantineContentKey(txnId: string): string {
  return `${QUARANTINE_CONTENT_PREFIX}${txnId}`;
}

/**
 * A principal as a key segment: the SHA-256 of its name, so any principal
 * (`user:a@b`, `token:x`) names one segment that holds no separator.
 */
export async function principalKeyOf(principal: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(principal),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function parseQuarantineRecordKey(
  key: string,
): {
  readonly state: QuarantineRecord["state"];
  readonly txnId: string;
  readonly principalKey: string;
} | undefined {
  const state = key.startsWith(QUARANTINE_HELD_PREFIX)
    ? "held"
    : key.startsWith(QUARANTINE_ACCEPTED_PREFIX)
    ? "accepted"
    : key.startsWith(QUARANTINE_DISCARDED_PREFIX)
    ? "discarded"
    : undefined;
  if (state === undefined) return undefined;
  const rest = key.slice(prefixOf(state).length).split("/");
  if (
    rest.length !== 2 || !UUID.test(rest[0]) || !SHA256_HEX.test(rest[1])
  ) {
    return undefined;
  }
  return { state, txnId: rest[0], principalKey: rest[1] };
}

export function quarantineHasRoom(
  heldKeys: readonly string[],
  principalKey: string,
  bytes?: { readonly held: number; readonly deposit: number },
): boolean {
  if (
    bytes !== undefined &&
    bytes.held + bytes.deposit > MAX_QUARANTINED_BYTES_PER_PRINCIPAL
  ) {
    return false;
  }
  let total = 0;
  let mine = 0;
  for (const key of heldKeys) {
    const parsed = parseQuarantineRecordKey(key);
    if (parsed === undefined || parsed.state !== "held") continue;
    total++;
    if (parsed.principalKey === principalKey) mine++;
  }
  return total < MAX_QUARANTINED && mine < MAX_QUARANTINED_PER_PRINCIPAL;
}

export function serializeQuarantineRecord(
  record: QuarantineRecord,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, ...record }));
}

/**
 * read back from a store anyone with storage access could write, so every field
 * is validated
 */
export function parseQuarantineRecord(bytes: Uint8Array): QuarantineRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new QuarantineRecordInvalidError("record", String(error));
  }
  const fields = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
  if (fields === undefined || fields.v !== 1) {
    throw new QuarantineRecordInvalidError("record", "unknown version");
  }
  const text = (name: string, max = 1024): string => {
    const value = fields[name];
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
      throw new QuarantineRecordInvalidError("record", `field ${name}`);
    }
    return value;
  };
  const names = (name: string): readonly string[] => {
    const value = fields[name];
    if (
      !Array.isArray(value) || value.length > MAX_RECORDED_MEMBERSHIPS ||
      !value.every((entry) =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 256
      )
    ) {
      throw new QuarantineRecordInvalidError("record", `field ${name}`);
    }
    return value as string[];
  };
  const txnId = text("txnId");
  if (!UUID.test(txnId)) {
    throw new QuarantineRecordInvalidError("record", "txnId");
  }
  const state = fields.state;
  if (state !== "held" && state !== "accepted" && state !== "discarded") {
    throw new QuarantineRecordInvalidError("record", "state");
  }
  const bytesField = fields.bytes;
  if (
    typeof bytesField !== "number" || !Number.isSafeInteger(bytesField) ||
    bytesField < 0
  ) {
    throw new QuarantineRecordInvalidError("record", "bytes");
  }
  const record: QuarantineRecord = {
    txnId,
    partition: text("partition"),
    principal: text("principal"),
    ...(fields.groups === undefined ? {} : { groups: names("groups") }),
    ...(fields.collectives === undefined
      ? {}
      : { collectives: names("collectives") }),
    reason: text("reason", MAX_REASON_LENGTH),
    depositedAt: text("depositedAt", 64),
    bytes: bytesField,
    state,
    ...(fields.acceptedBy === undefined
      ? {}
      : { acceptedBy: text("acceptedBy") }),
    ...(fields.acceptedAt === undefined
      ? {}
      : { acceptedAt: text("acceptedAt", 64) }),
    ...(fields.seq === undefined ? {} : { seq: seqOf(fields.seq) }),
    ...(fields.discardedBy === undefined
      ? {}
      : { discardedBy: text("discardedBy") }),
    ...(fields.discardedAt === undefined
      ? {}
      : { discardedAt: text("discardedAt", 64) }),
  };
  return record;
}

function seqOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new QuarantineRecordInvalidError("record", "seq");
  }
  return value;
}

export function boundedQuarantineReason(reason: string): string {
  return reason.length <= MAX_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

export function serializeQuarantineContent(
  content: QuarantineContent,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    v: 1,
    commit: content.commit,
    base: content.base,
    chunks: content.chunks.map((chunk) => ({
      sha256: chunk.sha256,
      data: base64Of(chunk.bytes),
    })),
  }));
}

export async function parseQuarantineContent(
  bytes: Uint8Array,
): Promise<QuarantineContent> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new QuarantineRecordInvalidError("content", String(error));
  }
  const fields = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
  if (fields === undefined || fields.v !== 1) {
    throw new QuarantineRecordInvalidError("content", "unknown version");
  }
  return {
    commit: fields.commit,
    base: baseOf(fields.base),
    chunks: await chunksOf(fields.chunks),
  };
}

export function baseOf(
  value: unknown,
): { readonly seq: number; readonly txnId?: string } {
  const base = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
  if (
    base === undefined || typeof base.seq !== "number" ||
    !Number.isSafeInteger(base.seq) || base.seq < 0
  ) {
    throw new QuarantineRecordInvalidError("content", "base seq");
  }
  if (base.txnId !== undefined && typeof base.txnId !== "string") {
    throw new QuarantineRecordInvalidError("content", "base txnId");
  }
  return {
    seq: base.seq,
    ...(typeof base.txnId === "string" ? { txnId: base.txnId } : {}),
  };
}

/**
 * bytes that do not hash as named are refused, and so is a chunk named twice,
 * which could stand in for one the commit names but the deposit does not carry
 */
export async function chunksOf(value: unknown): Promise<QuarantineChunk[]> {
  if (!Array.isArray(value)) {
    throw new QuarantineRecordInvalidError("content", "chunks");
  }
  const chunks: QuarantineChunk[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const chunk = typeof raw === "object" && raw !== null
      ? raw as Record<string, unknown>
      : {};
    if (
      typeof chunk.sha256 !== "string" || !SHA256_HEX.test(chunk.sha256) ||
      typeof chunk.data !== "string"
    ) {
      throw new QuarantineRecordInvalidError("content", "a chunk");
    }
    if (seen.has(chunk.sha256)) {
      throw new QuarantineRecordInvalidError(
        "content",
        `chunk ${chunk.sha256} more than once`,
      );
    }
    seen.add(chunk.sha256);
    let bytes: Uint8Array;
    try {
      bytes = bytesOf(chunk.data);
    } catch {
      throw new QuarantineRecordInvalidError("content", "a chunk's data");
    }
    if (await sha256Hex(bytes) !== chunk.sha256) {
      throw new QuarantineRecordInvalidError(
        "content",
        `chunk ${chunk.sha256} does not hold its own bytes`,
      );
    }
    chunks.push({ sha256: chunk.sha256, bytes });
  }
  return chunks;
}

/**
 * what a deposit carries and an accept lands must not lean on anyone's access
 * for a chunk the author never provided
 */
export function carriesExactly(
  chunks: readonly QuarantineChunk[],
  named: ReadonlySet<string>,
): boolean {
  const carried = new Set(chunks.map((chunk) => chunk.sha256));
  if (carried.size !== chunks.length || carried.size !== named.size) {
    return false;
  }
  for (const sha256 of named) {
    if (!carried.has(sha256)) return false;
  }
  return true;
}

export function chunksToWire(
  chunks: readonly QuarantineChunk[],
): { sha256: string; data: string }[] {
  return chunks.map((chunk) => ({
    sha256: chunk.sha256,
    data: base64Of(chunk.bytes),
  }));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface QuarantineStore {
  heldKeys(): Promise<string[]>;
  heldBytesOf(principalKey: string): Promise<number>;
  find(txnId: string): Promise<QuarantineRecord | undefined>;
  content(txnId: string): Promise<QuarantineContent | undefined>;
  /** Keeps a change: its content first, then its record. */
  deposit(record: QuarantineRecord, content: QuarantineContent): Promise<void>;
  /**
   * Records `accepted` (state `accepted`), then removes the held record and
   * its content.
   */
  markAccepted(accepted: QuarantineRecord): Promise<void>;
  /**
   * Records `discarded` (state `discarded`), then removes the held record
   * and its content: it no longer counts against any cap.
   */
  markDiscarded(discarded: QuarantineRecord): Promise<void>;
  list(maxAccepted: number): Promise<{
    readonly records: readonly QuarantineRecord[];
    readonly truncated: boolean;
  }>;
}
