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
 * Builders shared by the v3 domain model's and commit store's tests, and a
 * reference model of the partition rules with random command sequences to
 * drive it: the oracle for the partition's and the commit store's property
 * tests. Test-only.
 *
 * @module
 */

import type {
  DatastoreStorage,
  StoredChunk,
} from "../datastore/datastore_storage.ts";
import fc from "fast-check";
import { ModelType } from "../models/model_type.ts";
import type { BlobRef } from "./blob_ref.ts";
import { Commit, type CommitProps } from "./commit.ts";
import { createIntent, type Intent, modelRef } from "./intent.ts";
import {
  type DataVersionOp,
  dataVersionOp,
  leaseOp,
  type Op,
  type PutOp,
  putOp,
  type TombstoneOp,
  tombstoneOp,
} from "./op.ts";
import type { AppendResult, Partition } from "./partition.ts";
import { type PartitionKey, partitionOf } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";

export const MODEL_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
export const DATA_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const MODEL_TYPE = ModelType.create("@swamp/aws-ec2");

/** The partition of the fixture model. */
export function modelPartition(): PartitionKey {
  return partitionOf({ kind: "model", type: MODEL_TYPE, id: MODEL_ID });
}

/** An intent on the fixture model. */
export function modelIntent(
  fields: Record<string, unknown> & { kind: Intent["kind"] },
): Intent {
  return createIntent({ ...fields, model: modelRef(MODEL_TYPE, MODEL_ID) });
}

/** The cache-layout key of a fixture data version's content. */
export function dataKey(name: string, version: number): RecordKey {
  return RecordKey.create(
    `data/${MODEL_TYPE.normalized}/${MODEL_ID}/${name}/${version}/raw`,
  );
}

/** Valid metadata for a fixture data version. */
export function metadata(name: string, version: number): unknown {
  return {
    name,
    id: DATA_ID,
    version,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    createdAt: "2026-10-11T00:00:00.000Z",
  };
}

/** Base64 of a UTF-8 string. */
export function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** The lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Of(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A put of a fixture data version's content, inlined: a save, or with
 * `kind` `data.append` an append to a live version.
 */
export function savePut(
  name: string,
  version: number,
  text = `${name}@${version}`,
  expect?: "absent" | { sha256: string },
  kind: "data.save" | "data.append" = "data.save",
): Promise<PutOp> {
  return putOp({
    intent: modelIntent({ kind, name, version }),
    key: dataKey(name, version),
    inline: base64(text),
    expect,
  });
}

/** A put of a fixture data version whose content is stored as chunks. */
export function blobPut(
  name: string,
  version: number,
  blob: BlobRef,
): Promise<PutOp> {
  return putOp({
    intent: modelIntent({ kind: "data.save", name, version }),
    key: dataKey(name, version),
    blob,
  });
}

/** The data-version op that records a fixture version. */
export function versionOp(name: string, version: number): DataVersionOp {
  return dataVersionOp({
    key: RecordKey.create(
      `data/${MODEL_TYPE.normalized}/${MODEL_ID}/${name}/${version}/metadata.yaml`,
    ),
    metadata: metadata(name, version),
  });
}

/** A versioned delete of a fixture data version's content. */
export function deleteVersion(
  name: string,
  version: number,
  expect?: "present",
): TombstoneOp {
  return tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name, version }),
    key: dataKey(name, version),
    expect,
  });
}

/** A commit on the fixture model's partition. */
export function modelCommit(
  seq: number,
  ops: readonly Op[],
  overrides: Partial<CommitProps> = {},
): Commit {
  return Commit.create({
    seq,
    partition: modelPartition(),
    namespace: "",
    txnId: `txn-${seq}`,
    writer: { host: "host-a", pid: 4242, instance: "cli-1" },
    at: "2026-10-11T00:00:00.000Z",
    ops,
    ...overrides,
  });
}

/**
 * A `storage/1` double held in memory, recording the calls the chunk store
 * makes. `touch: false` leaves `touch` unimplemented.
 */
export class MemoryStorage implements DatastoreStorage {
  readonly contract = "storage/1" as const;
  readonly chunks = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  readonly touch?: DatastoreStorage["touch"];

  constructor(
    readonly options: { maxChunkBytes?: number; touch?: boolean } = {},
  ) {
    if (options.touch ?? true) {
      this.touch = (namespace, hashes, signal) => {
        signal.throwIfAborted();
        this.calls.push(`touch ${hashes.length}`);
        return Promise.resolve(
          new Set(hashes.filter((h) => !this.chunks.has(`${namespace}/${h}`))),
        );
      };
    }
  }

  capabilities() {
    return {
      maxChunkBytes: this.options.maxChunkBytes ?? 64 * 1024 * 1024,
      touch: this.options.touch ?? true,
    };
  }

  has(namespace: string, hashes: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    this.calls.push(`has ${hashes.length}`);
    return Promise.resolve(
      new Set(hashes.filter((h) => this.chunks.has(`${namespace}/${h}`))),
    );
  }

  put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.calls.push(`put ${sha256.slice(0, 8)}`);
    this.chunks.set(`${namespace}/${sha256}`, bytes.slice());
    return Promise.resolve();
  }

  get(namespace: string, sha256: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const bytes = this.chunks.get(`${namespace}/${sha256}`);
    return Promise.resolve(bytes === undefined ? null : bytes.slice());
  }

  async *list(namespace: string, signal: AbortSignal) {
    signal.throwIfAborted();
    for (const key of this.chunks.keys()) {
      if (key.startsWith(`${namespace}/`)) {
        yield {
          sha256: key.slice(namespace.length + 1),
          lastModified: new Date(0),
        } satisfies StoredChunk;
      }
    }
  }

  delete(namespace: string, sha256: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.chunks.delete(`${namespace}/${sha256}`);
    return Promise.resolve();
  }

  /** How many put calls the chunk store made. */
  puts(): number {
    return this.calls.filter((c) => c.startsWith("put ")).length;
  }
}

/** Reads a stream to the end and joins its chunks. */
export async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  for await (const piece of stream) pieces.push(piece);
  const joined = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  return joined;
}

/** A stream yielding `bytes` in pieces of the given sizes, then the rest. */
export function streamOf(
  bytes: Uint8Array,
  pieceSizes: readonly number[] = [],
): ReadableStream<Uint8Array> {
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (const size of pieceSizes) {
    if (at >= bytes.length) break;
    pieces.push(bytes.slice(at, at + size));
    at += size;
  }
  if (at < bytes.length) pieces.push(bytes.slice(at));
  return ReadableStream.from(pieces);
}

// The partition reference model.

export const NAMES = ["a", "b"] as const;
const CONTENTS = ["x", "y", "z"] as const;

const arbName = fc.constantFrom(...NAMES);
const arbVersion = fc.integer({ min: 1, max: 6 });

/** One op, described without building it. */
export const arbOpSpec = fc.oneof(
  fc.record({
    kind: fc.constant("put" as const),
    name: arbName,
    version: arbVersion,
    content: fc.constantFrom(...CONTENTS),
    /** A `data.append` put, which lets a live version be re-recorded. */
    append: fc.boolean(),
    expect: fc.oneof(
      fc.constant(undefined),
      fc.constant("absent" as const),
      fc.constantFrom(...CONTENTS).map((c) => ({ content: c })),
    ),
  }),
  fc.record({
    kind: fc.constant("tombstone" as const),
    name: arbName,
    version: arbVersion,
    versioned: fc.boolean(),
    present: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("data-version" as const),
    name: arbName,
    version: arbVersion,
  }),
  fc.record({
    kind: fc.constant("lease" as const),
    fence: fc.nat({ max: 6 }),
  }),
);

export type OpSpec = typeof arbOpSpec extends fc.Arbitrary<infer T> ? T : never;

/** One append, described relative to the partition's state when it runs. */
export const arbCommand = fc.record({
  /** 0: the next seq; otherwise an offset from it (a gap or a stale seq). */
  seqOffset: fc.oneof(
    { weight: 4, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.integer({ min: -2, max: 2 }) },
  ),
  /** Reuse an earlier commit's txnId instead of a fresh one. */
  reuseTxn: fc.oneof(
    { weight: 5, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: fc.nat() },
  ),
  fence: fc.option(fc.nat({ max: 6 }), { nil: undefined }),
  ops: fc.array(arbOpSpec, { minLength: 1, maxLength: 4 }),
});

export type Command = typeof arbCommand extends fc.Arbitrary<infer T> ? T
  : never;

/** The tombstoned key of a version-less delete: the name's latest marker. */
function latestKey(name: string): RecordKey {
  return RecordKey.create(`data/model/${name}/latest`);
}

const DIGESTS = new Map<string, string>();
async function digest(content: string): Promise<string> {
  let value = DIGESTS.get(content);
  if (value === undefined) {
    value = await sha256Of(content);
    DIGESTS.set(content, value);
  }
  return value;
}

export async function buildOp(spec: OpSpec): Promise<Op> {
  switch (spec.kind) {
    case "put":
      return await savePut(
        spec.name,
        spec.version,
        spec.content,
        spec.expect === undefined || spec.expect === "absent"
          ? spec.expect
          : { sha256: await digest(spec.expect.content) },
        spec.append ? "data.append" : "data.save",
      );
    case "tombstone":
      return tombstoneOp({
        intent: modelIntent(
          spec.versioned
            ? { kind: "data.delete", name: spec.name, version: spec.version }
            : { kind: "data.delete", name: spec.name },
        ),
        key: spec.versioned
          ? dataKey(spec.name, spec.version)
          : latestKey(spec.name),
        expect: spec.present ? "present" : undefined,
      });
    case "data-version":
      return versionOp(spec.name, spec.version);
    case "lease":
      return leaseOp({ holder: "serve", fence: spec.fence });
  }
}

/** The reference model's state: plain data, written straight from the rules. */
export interface Model {
  seq: number;
  fence: number | undefined;
  txnIds: string[];
  records: Record<string, string>;
  live: Record<string, number[]>;
  highWater: Record<string, number>;
}

export type ModelResult = AppendResult | { kind: "rejected"; reason: string };

export async function modelAppend(
  model: Model,
  commit: Commit,
  specs: readonly OpSpec[],
): Promise<{ model: Model; result: ModelResult }> {
  if (model.txnIds.includes(commit.txnId)) {
    return { model, result: { kind: "duplicate" } };
  }
  const reject = (reason: string) => ({
    model,
    result: { kind: "rejected" as const, reason },
  });
  if (commit.seq !== model.seq + 1) return reject("seq-gap");
  const next: Model = structuredClone(model);
  const raise = (fence: number): boolean => {
    if (next.fence !== undefined && fence < next.fence) return false;
    next.fence = fence;
    return true;
  };
  if (commit.fence === undefined) {
    // Once a fence was seen, every commit must carry one.
    if (model.fence !== undefined) return reject("unfenced");
  } else if (!raise(commit.fence)) {
    return reject("stale-fence");
  }
  // Append puts seen so far in this commit, each letting one data-version
  // op re-record its live version.
  const appended: string[] = [];
  for (const spec of specs) {
    if (spec.kind === "put") {
      if (spec.append) appended.push(`${spec.version}:${spec.name}`);
      const key = dataKey(spec.name, spec.version).toString();
      const current = next.records[key];
      if (spec.expect === "absent" && current !== undefined) {
        return reject("expect-failed");
      }
      if (
        typeof spec.expect === "object" &&
        current !== await digest(spec.expect.content)
      ) {
        return reject("expect-failed");
      }
      next.records[key] = await digest(spec.content);
    } else if (spec.kind === "tombstone") {
      const key = (spec.versioned
        ? dataKey(spec.name, spec.version)
        : latestKey(spec.name)).toString();
      if (spec.present && next.records[key] === undefined) {
        return reject("expect-failed");
      }
      delete next.records[key];
      if (spec.versioned) {
        next.live[spec.name] = (next.live[spec.name] ?? []).filter((v) =>
          v !== spec.version
        );
      }
    } else if (spec.kind === "data-version") {
      const live = next.live[spec.name] ?? [];
      if (live.includes(spec.version)) {
        // Only an append in the same commit re-records a live version.
        const at = appended.indexOf(`${spec.version}:${spec.name}`);
        if (at === -1) return reject("version-live");
        appended.splice(at, 1);
      } else {
        next.live[spec.name] = [...live, spec.version];
      }
      next.highWater[spec.name] = Math.max(
        next.highWater[spec.name] ?? 0,
        spec.version,
      );
    } else if (!raise(spec.fence)) {
      return reject("stale-fence");
    }
  }
  next.seq = commit.seq;
  next.txnIds.push(commit.txnId);
  return { model: next, result: { kind: "appended", seq: commit.seq } };
}

/** The partition's observable state, in the reference model's shape. */
export function observe(partition: Partition) {
  return {
    seq: partition.seq,
    fence: partition.highestFence,
    records: Object.fromEntries(
      partition.recordKeys().map((key) => [
        key,
        partition.record(RecordKey.create(key))?.sha256,
      ]),
    ),
    live: Object.fromEntries(
      NAMES.map((name) => [name, [...partition.versions(name)]]),
    ),
    highWater: Object.fromEntries(
      NAMES.map((name) => [name, partition.highWater(name)]),
    ),
  };
}

export function expected(model: Model) {
  return {
    seq: model.seq,
    fence: model.fence,
    records: Object.fromEntries(
      Object.entries(model.records).sort(([a], [b]) => a.localeCompare(b)),
    ),
    live: Object.fromEntries(
      NAMES.map((name) => [
        name,
        [...(model.live[name] ?? [])].sort((a, b) => a - b),
      ]),
    ),
    highWater: Object.fromEntries(
      NAMES.map((name) => [name, model.highWater[name] ?? 0]),
    ),
  };
}

/** The reference model of a partition with no commits. */
export function emptyModel(): Model {
  return {
    seq: 0,
    fence: undefined,
    txnIds: [],
    records: {},
    live: {},
    highWater: {},
  };
}
