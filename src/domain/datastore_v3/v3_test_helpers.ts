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
 * Builders shared by the v3 domain model's tests. Test-only.
 *
 * @module
 */

import type {
  DatastoreStorage,
  StoredChunk,
} from "../datastore/datastore_storage.ts";
import { ModelType } from "../models/model_type.ts";
import { Commit, type CommitProps } from "./commit.ts";
import { createIntent, type Intent, modelRef } from "./intent.ts";
import {
  type DataVersionOp,
  dataVersionOp,
  type Op,
  type PutOp,
  putOp,
  type TombstoneOp,
  tombstoneOp,
} from "./op.ts";
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

/** A put of a fixture data version's content, inlined. */
export function savePut(
  name: string,
  version: number,
  text = `${name}@${version}`,
  expect?: "absent" | { sha256: string },
): Promise<PutOp> {
  return putOp({
    intent: modelIntent({ kind: "data.save", name, version }),
    key: dataKey(name, version),
    inline: base64(text),
    expect,
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
