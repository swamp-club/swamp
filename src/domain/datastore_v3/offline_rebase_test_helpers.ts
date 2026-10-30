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
 * Shared fixtures for the offline rebase tests (swamp-club#4195): commits
 * built by the data repository's own change factory, a partition with its
 * history, and the lookups a flush reads.
 *
 * @module
 */

import type { DataMetadata } from "../data/data_metadata.ts";
import { checkCommitBindings } from "./commit_authorization.ts";
import { Commit } from "./commit.ts";
import type { TypedChange } from "./commit_log_unit_of_work.ts";
import type { VersionObservation } from "./latest_choice.ts";
import type {
  OfflineRebaseLookups,
  RebasedCommit,
  VersionContent,
} from "./offline_rebase.ts";
import { type Op, putOp } from "./op.ts";
import { Partition } from "./partition.ts";
import { ModelChanges } from "./repository_changes.ts";
import { ModelType } from "../models/model_type.ts";
import { type PartitionKey, partitionOf } from "./partition_key.ts";

/** The fixture behavior: a production file may not import `_test` paths. */
export const MODEL_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
export const MODEL_TYPE = ModelType.create("@swamp/aws-ec2");
const DATA_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

/** The fixture behavior's partition. */
export function modelPartition(): PartitionKey {
  return partitionOf({ kind: "model", type: MODEL_TYPE, id: MODEL_ID });
}

/** Valid metadata for a fixture data version. */
export function metadata(name: string, version: number): DataMetadata {
  return {
    name,
    id: DATA_ID,
    version,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    streaming: false,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    createdAt: "2026-10-11T00:00:00.000Z",
  };
}

/** The fixture's metadata encoding: stable JSON, as the tests compare it. */
export function encodeMetadata(value: DataMetadata): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** The fixture model's change factory. */
export function fixtureChanges(): ModelChanges {
  return new ModelChanges(MODEL_TYPE, MODEL_ID);
}

/** Base64 of bytes. */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Typed changes as ops, storing every pending put inline. */
export async function toOps(changes: readonly TypedChange[]): Promise<Op[]> {
  const ops: Op[] = [];
  for (const change of changes) {
    if ("op" in change) {
      ops.push(change.op);
      continue;
    }
    const content = change.put.content;
    if (!(content instanceof Uint8Array)) {
      throw new Error("The fixtures stage bytes only");
    }
    ops.push(
      await putOp({
        intent: change.put.intent,
        key: change.put.key,
        inline: base64Of(content),
        ...(change.put.expect === undefined
          ? {}
          : { expect: change.put.expect }),
        ...(change.put.access === undefined
          ? {}
          : { access: change.put.access }),
      }),
    );
  }
  return ops;
}

/** A save of one version, with its latest marker, as the repository stages it. */
export async function saveOps(props: {
  readonly name: string;
  readonly version: number;
  readonly text?: string;
  readonly tags?: Readonly<Record<string, string>>;
  /** The writer's clock when it saved; the fixture's default otherwise. */
  readonly createdAt?: string;
  readonly marker?: boolean;
}): Promise<Op[]> {
  const changes = fixtureChanges();
  const meta = {
    ...metadata(props.name, props.version),
    ...(props.tags === undefined ? {} : {
      tags: { type: "resource", ...props.tags },
    }),
    ...(props.createdAt === undefined ? {} : { createdAt: props.createdAt }),
  };
  const staged: TypedChange[] = changes.writeVersion({ kind: "data.save" }, {
    name: props.name,
    version: props.version,
    metadata: meta,
    metadataBytes: encodeMetadata(meta),
    raw: new TextEncoder().encode(
      props.text ?? `${props.name}@${props.version}`,
    ),
  });
  if (props.marker !== false) {
    staged.push(
      changes.latestPut(
        { kind: "data.save" },
        props.name,
        props.version,
        new TextEncoder().encode(String(props.version)),
      ),
    );
  }
  return await toOps(staged);
}

/** A commit on the fixture model. */
export function fixtureCommit(props: {
  readonly seq: number;
  readonly txnId: string;
  readonly ops: readonly Op[];
  readonly at?: string;
  readonly executedAt?: string;
  readonly clockOffsetMs?: number;
  readonly fence?: number;
}): Commit {
  return Commit.create({
    seq: props.seq,
    partition: modelPartition(),
    namespace: "",
    txnId: props.txnId,
    writer: { host: "host-a", pid: 4242, instance: "cli-1" },
    at: props.at ?? "2026-10-30T10:00:00.000Z",
    ...(props.executedAt === undefined ? {} : { executedAt: props.executedAt }),
    ...(props.clockOffsetMs === undefined
      ? {}
      : { clockOffsetMs: props.clockOffsetMs }),
    ...(props.fence === undefined ? {} : { fence: props.fence }),
    ops: props.ops,
  });
}

/**
 * A partition and the history the lookups read: every commit appended
 * records each version's commit time, content and metadata.
 */
export class FixtureHistory {
  readonly partition = Partition.empty(modelPartition());
  readonly #observations = new Map<string, VersionObservation>();
  readonly #content = new Map<string, VersionContent>();
  /** Versions whose commit was compacted away: no commit time. */
  readonly compacted = new Set<string>();

  /** Appends `commit` and records its versions. */
  append(commit: Commit): void {
    this.partition.append(commit);
    for (const op of commit.ops) {
      if (op.kind !== "data-version") continue;
      const id = `${op.metadata.name}@${op.metadata.version}`;
      this.#observations.set(id, {
        committedAt: commit.at,
        createdAt: op.metadata.createdAt,
        tags: op.metadata.tags,
      });
      const raw = commit.ops.find((other) =>
        other.kind === "put" &&
        other.key.toString().endsWith(
          `/${op.metadata.name}/${op.metadata.version}/raw`,
        )
      );
      if (raw !== undefined && raw.kind === "put") {
        this.#content.set(id, { raw: raw.content, metadata: op.metadata });
      }
    }
  }

  /** The next seq on the partition. */
  get nextSeq(): number {
    return this.partition.seq + 1;
  }

  lookups(): OfflineRebaseLookups {
    return {
      observation: (name, version) => {
        const found = this.#observations.get(`${name}@${version}`);
        if (found === undefined) return undefined;
        return this.compacted.has(`${name}@${version}`)
          ? { createdAt: found.createdAt, tags: found.tags }
          : found;
      },
      content: (name, version) => this.#content.get(`${name}@${version}`),
    };
  }

  /**
   * Lands a rebase's result as serve would: checks its bindings, builds the
   * commit under its txnId and appends it. Returns the landed commit, or
   * undefined for an unsent one.
   */
  async land(result: RebasedCommit, at: string): Promise<Commit | undefined> {
    if (result.kind === "rejected") return undefined;
    const ops = result.kind === "unchanged"
      ? result.commit.ops
      : await toOps(result.changes);
    const bindings = checkCommitBindings(this.partition.key, ops);
    if (!bindings.ok) {
      throw new Error(`Rebased commit fails its bindings: ${bindings.message}`);
    }
    const landed = Commit.create({
      seq: this.nextSeq,
      partition: this.partition.key,
      namespace: result.commit.namespace,
      txnId: result.commit.txnId,
      writer: result.commit.writer,
      at,
      ops,
    });
    this.append(landed);
    return landed;
  }
}
