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
 * A change serve refused because its author lacks a grant it needs, kept
 * for an admin to accept or discard (swamp-club#4195). A member's offline work that
 * meets a grant revoked while it was offline is never dropped: its flush
 * hands it to serve, which keeps it in the shared control plane until an
 * admin accepts it, or discards it so it never lands.
 *
 * Serve keeps two records per change:
 *
 * - its **record** ({@link QuarantineRecord}), small, under
 *   `quarantine/<txnId>/<principalKey>` while it is held,
 *   `quarantine-accepted/<txnId>/<principalKey>` once accepted and
 *   `quarantine-discarded/<txnId>/<principalKey>` once discarded. The key
 *   alone names the change and its author, so caps are counted from a
 *   listing of held keys without reading any record;
 * - its **content** ({@link QuarantineContent}): the commit, the head it
 *   was built on and the chunks it names, under `quarantine-content/<txnId>`,
 *   removed once accepted or discarded.
 *
 * Content is written before the record, so a held record always has its
 * content; a crash between leaves only content no record names.
 *
 * @module
 */

/** Where held records live. */
export const QUARANTINE_HELD_PREFIX = "quarantine/";
/** Where accepted records live. */
export const QUARANTINE_ACCEPTED_PREFIX = "quarantine-accepted/";
/** Where discarded records live. */
export const QUARANTINE_DISCARDED_PREFIX = "quarantine-discarded/";
/** Where a held change's content lives. */
export const QUARANTINE_CONTENT_PREFIX = "quarantine-content/";

/**
 * The most bytes one deposit carries: its chunks and its commit. A control
 * plane write holds the whole record in memory, so it stays far below what
 * one commit may carry; a larger change stays quarantined in its author's
 * checkout only.
 */
export const MAX_QUARANTINE_DEPOSIT_BYTES = 32 * 1024 * 1024;
/** The most changes one principal has held at once. */
export const MAX_QUARANTINED_PER_PRINCIPAL = 32;
/** The most changes serve holds at once, from everyone. */
export const MAX_QUARANTINED = 1024;
/**
 * The most bytes of deposits one principal has held at once: with the
 * count cap, so 32 deposits near the per-deposit limit cannot all be kept.
 */
export const MAX_QUARANTINED_BYTES_PER_PRINCIPAL = 128 * 1024 * 1024;
/** The longest refusal reason a record keeps. */
const MAX_REASON_LENGTH = 2048;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A held, accepted or discarded change, without its content. */
export interface QuarantineRecord {
  /** The change's txnId: lowercase UUID, the same it lands under. */
  readonly txnId: string;
  /** The partition it changes. */
  readonly partition: string;
  /** Its author, as serve stamped the deposit: the principal it lands as. */
  readonly principal: string;
  /**
   * The author's groups and collectives when it deposited: an accept judges
   * the change's content with the author's access, never the admin's, and
   * this is the membership serve last saw for it. Absent on a record kept
   * before they were recorded, which then judges with none.
   */
  readonly groups?: readonly string[];
  readonly collectives?: readonly string[];
  /** Why serve refused it. */
  readonly reason: string;
  /** When serve took it (ISO). */
  readonly depositedAt: string;
  /** The deposit's size, in bytes. */
  readonly bytes: number;
  readonly state: "held" | "accepted" | "discarded";
  /** The admin who accepted it. */
  readonly acceptedBy?: string;
  /** When it was accepted (ISO). */
  readonly acceptedAt?: string;
  /** The seq it landed at. */
  readonly seq?: number;
  /** The admin who discarded it, so it never lands. */
  readonly discardedBy?: string;
  /** When it was discarded (ISO). */
  readonly discardedAt?: string;
}

/** The most groups, or collectives, a record keeps for its author. */
export const MAX_RECORDED_MEMBERSHIPS = 256;

/** The prefix records in `state` live under. */
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

/** A chunk a held change names, with its bytes. */
export interface QuarantineChunk {
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/** What a held change lands from once accepted. */
export interface QuarantineContent {
  /** The commit as its author's checkout built it, `Commit.toJSON` form. */
  readonly commit: unknown;
  /** The partition head it was built on. */
  readonly base: { readonly seq: number; readonly txnId?: string };
  readonly chunks: readonly QuarantineChunk[];
}

/** Thrown for a record or content that does not hold what it must. */
export class QuarantineRecordInvalidError extends Error {
  constructor(what: string, detail: string) {
    super(`The quarantined change's ${what} is not valid: ${detail}`);
    this.name = "QuarantineRecordInvalidError";
  }
}

/** Whether `value` is a txnId as a quarantine key names it. */
export function isQuarantineTxnId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * The key a record lives under: its state's prefix, its txnId and its
 * author's key ({@link principalKeyOf}).
 */
export function quarantineRecordKey(
  state: QuarantineRecord["state"],
  txnId: string,
  principalKey: string,
): string {
  return `${prefixOf(state)}${txnId}/${principalKey}`;
}

/** The key a held change's content lives under. */
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

/** A record key's txnId and author key; undefined for any other key. */
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

/**
 * Whether one more change by the author `principalKey` may be held, from
 * the held record keys serve lists: within {@link MAX_QUARANTINED} for
 * everyone and {@link MAX_QUARANTINED_PER_PRINCIPAL} for the author, and,
 * given `bytes` (the author's held bytes and the deposit's), within
 * {@link MAX_QUARANTINED_BYTES_PER_PRINCIPAL}.
 */
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

/** A record as stored. */
export function serializeQuarantineRecord(
  record: QuarantineRecord,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, ...record }));
}

/**
 * A stored record, checked: it is read back from a store anyone with
 * storage access could write, so every field is validated.
 *
 * @throws QuarantineRecordInvalidError for a record that is not one
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

/** A refusal reason as a record keeps it: bounded. */
export function boundedQuarantineReason(reason: string): string {
  return reason.length <= MAX_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/** Content as stored: chunk bytes in base64. */
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

/**
 * Stored content, checked: base64 that decodes and hashes as named, a base
 * seq that is a seq. The commit stays unparsed; `Commit.fromJSON` checks it.
 *
 * @throws QuarantineRecordInvalidError for content that is not valid
 */
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

/**
 * A deposit's base, checked.
 *
 * @throws QuarantineRecordInvalidError for one that is not a head
 */
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
 * Chunks in their wire form (`{sha256, data}`, base64), each decoded and
 * hashed: bytes that do not hash as named are refused, and so is a chunk
 * named twice, which could stand in for one the commit names but the
 * deposit does not carry.
 *
 * @throws QuarantineRecordInvalidError for a chunk that is not valid
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
 * Whether `chunks` are exactly the chunks `named`, each once: what a deposit
 * carries and what an accept lands must not lean on anyone's access for a
 * chunk the author never provided.
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

/** Chunks in their wire form. */
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

/** Where serve keeps quarantined changes: the port its adapter implements. */
export interface QuarantineStore {
  /** The keys of every held record. */
  heldKeys(): Promise<string[]>;
  /**
   * The bytes of every change `principalKey`'s author has held, from its
   * held records (at most {@link MAX_QUARANTINED_PER_PRINCIPAL} of them).
   */
  heldBytesOf(principalKey: string): Promise<number>;
  /**
   * The change `txnId`, accepted, discarded or held; undefined when serve
   * has none.
   */
  find(txnId: string): Promise<QuarantineRecord | undefined>;
  /** A held change's content; undefined when it has none. */
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
  /**
   * Every held record and up to `maxAccepted` accepted or discarded ones,
   * newest first; `truncated` when more were accepted or discarded.
   */
  list(maxAccepted: number): Promise<{
    readonly records: readonly QuarantineRecord[];
    readonly truncated: boolean;
  }>;
}
