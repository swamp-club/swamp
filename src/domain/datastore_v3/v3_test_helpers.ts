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
  type TombstoneExpect,
  type TombstoneOp,
  tombstoneOp,
} from "./op.ts";
import type { AppendResult, Partition } from "./partition.ts";
import { type PartitionKey, partitionOf } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";

export const MODEL_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
export const DATA_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const MODEL_TYPE = ModelType.create("@swamp/aws-ec2");

export function modelPartition(): PartitionKey {
  return partitionOf({ kind: "model", type: MODEL_TYPE, id: MODEL_ID });
}

export function modelIntent(
  fields: Record<string, unknown> & { kind: Intent["kind"] },
): Intent {
  return createIntent({ ...fields, model: modelRef(MODEL_TYPE, MODEL_ID) });
}

export function dataKey(name: string, version: number): RecordKey {
  return RecordKey.create(
    `data/${MODEL_TYPE.normalized}/${MODEL_ID}/${name}/${version}/raw`,
  );
}

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

export function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function sha256Of(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

export function versionOp(name: string, version: number): DataVersionOp {
  return dataVersionOp({
    key: RecordKey.create(
      `data/${MODEL_TYPE.normalized}/${MODEL_ID}/${name}/${version}/metadata.yaml`,
    ),
    metadata: metadata(name, version),
  });
}

export function deleteVersion(
  name: string,
  version: number,
  expect?: TombstoneExpect,
): TombstoneOp {
  return tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name, version }),
    key: dataKey(name, version),
    expect,
  });
}

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

  puts(): number {
    return this.calls.filter((c) => c.startsWith("put ")).length;
  }
}

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

export const NAMES = ["a", "b"] as const;
const CONTENTS = ["x", "y", "z"] as const;

const arbName = fc.constantFrom(...NAMES);
const arbVersion = fc.integer({ min: 1, max: 6 });

export const arbOpSpec = fc.oneof(
  fc.record({
    kind: fc.constant("put" as const),
    name: arbName,
    version: arbVersion,
    content: fc.constantFrom(...CONTENTS),
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

export const arbCommand = fc.record({
  seqOffset: fc.oneof(
    { weight: 4, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.integer({ min: -2, max: 2 }) },
  ),
  reuseTxn: fc.oneof(
    { weight: 5, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: fc.nat() },
  ),
  fence: fc.option(fc.nat({ max: 6 }), { nil: undefined }),
  ops: fc.array(arbOpSpec, { minLength: 1, maxLength: 4 }),
});

export type Command = typeof arbCommand extends fc.Arbitrary<infer T> ? T
  : never;

/**
 * three commands that record a version, remove it and record it again,
 * sometimes with an append put: random commands alone almost never line those
 * up
 */
export const arbReuse: fc.Arbitrary<Command[]> = fc.record({
  name: arbName,
  version: arbVersion,
  append: fc.boolean(),
}).map(({ name, version, append }) => {
  const command = (ops: OpSpec[]): Command => ({
    seqOffset: 0,
    reuseTxn: undefined,
    // The highest fence the random commands use, so none is stale.
    fence: 6,
    ops,
  });
  const record: OpSpec = { kind: "data-version", name, version };
  return [
    command([record]),
    command([{
      kind: "tombstone",
      name,
      version,
      versioned: true,
      present: false,
    }]),
    command([
      ...(append
        ? [{
          kind: "put" as const,
          name,
          version,
          content: "x" as const,
          append: true,
          expect: undefined,
        }]
        : []),
      record,
    ]),
  ];
});

export const arbCommands = (maxLength: number): fc.Arbitrary<Command[]> =>
  fc.array(
    fc.oneof(
      { weight: 4, arbitrary: arbCommand.map((command) => [command]) },
      { weight: 1, arbitrary: arbReuse },
    ),
    { minLength: 1, maxLength },
  ).map((chunks) => chunks.flat());

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

export interface Model {
  seq: number;
  fence: number | undefined;
  leaseFence: number | undefined;
  txnIds: string[];
  records: Record<string, string>;
  live: Record<string, number[]>;
  highWater: Record<string, number>;
  removed: Record<string, number[]>;
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
        const live = next.live[spec.name] ?? [];
        if (live.includes(spec.version)) {
          next.removed[spec.name] = [
            ...(next.removed[spec.name] ?? []),
            spec.version,
          ];
        }
        next.live[spec.name] = live.filter((v) =>
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
        const removed = next.removed[spec.name] ?? [];
        if (removed.includes(spec.version)) {
          const at = appended.indexOf(`${spec.version}:${spec.name}`);
          if (at === -1) return reject("version-reused");
          appended.splice(at, 1);
          next.removed[spec.name] = removed.filter((v) => v !== spec.version);
        }
        next.live[spec.name] = [...live, spec.version];
      }
      next.highWater[spec.name] = Math.max(
        next.highWater[spec.name] ?? 0,
        spec.version,
      );
    } else {
      if (next.leaseFence !== undefined && spec.fence < next.leaseFence) {
        return reject("stale-lease");
      }
      next.leaseFence = spec.fence;
    }
  }
  next.seq = commit.seq;
  next.txnIds.push(commit.txnId);
  return { model: next, result: { kind: "appended", seq: commit.seq } };
}

export function observe(partition: Partition) {
  return {
    seq: partition.seq,
    fence: partition.highestFence,
    leaseFence: partition.leaseFence,
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
    removed: Object.fromEntries(
      NAMES.map((name) => [
        name,
        Array.from({ length: partition.highWater(name) }, (_, i) => i + 1)
          .filter((version) => partition.removed(name, version)),
      ]),
    ),
  };
}

export function expected(model: Model) {
  return {
    seq: model.seq,
    fence: model.fence,
    leaseFence: model.leaseFence,
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
    removed: Object.fromEntries(
      NAMES.map((name) => [
        name,
        [...(model.removed[name] ?? [])].sort((a, b) => a - b),
      ]),
    ),
  };
}

export function emptyModel(): Model {
  return {
    seq: 0,
    fence: undefined,
    leaseFence: undefined,
    txnIds: [],
    records: {},
    live: {},
    highWater: {},
    removed: {},
  };
}

export const SAMPLE_WORKFLOW_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const SAMPLE_RUN_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

export function sampleIntent(kind: Intent["kind"]): Intent {
  const control: Record<string, string> = {
    grant: "@swamp/grant",
    group: "@swamp/group",
    token: "@swamp/server-token",
    "worker-token": "@swamp/enrollment-token",
    worker: "@swamp/worker",
  };
  const prefix = kind.split(".")[0];
  const model = modelRef(
    control[prefix] === undefined
      ? MODEL_TYPE
      : ModelType.create(control[prefix]),
    MODEL_ID,
  );
  switch (kind) {
    case "data.save":
    case "data.append":
      return createIntent({ kind, model, name: "vpc", version: 1 });
    case "data.delete":
    case "data.gc":
      return createIntent({ kind, model, name: "vpc" });
    case "data.rename":
      return createIntent({ kind, model, name: "vpc", to: "net" });
    case "output.save":
    case "output.delete":
      return createIntent({ kind, model, outputId: "o" });
    case "run.create":
    case "run.update":
    case "run.delete":
    case "run-snapshot.save":
    case "run-snapshot.delete":
    case "run-start.save":
    case "run-start.delete":
      return createIntent({
        kind,
        run: { workflowId: SAMPLE_WORKFLOW_ID, runId: SAMPLE_RUN_ID },
      });
    case "definition.create":
    case "definition.edit":
    case "definition.delete":
      return createIntent({ kind, definition: { kind: "model", name: "web" } });
    case "evaluated-workflow.save":
    case "evaluated-workflow.delete":
      return createIntent({
        kind,
        definition: { kind: "workflow", name: "deploy" },
      });
    case "definition.rename-to":
      return createIntent({
        kind,
        definition: { kind: "model", name: "web" },
        from: "old",
      });
    case "definition.rename-from":
      return createIntent({
        kind,
        definition: { kind: "model", name: "old" },
        to: "web",
      });
    case "auto-definition.save":
    case "auto-definition.delete":
      return createIntent({ kind, autoDefinition: { id: MODEL_ID } });
    case "lockfile.write":
      return createIntent({ kind });
    default:
      return createIntent({ kind, model });
  }
}
