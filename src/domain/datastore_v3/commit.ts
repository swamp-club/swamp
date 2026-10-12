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
 * The v3 commit envelope (swamp-club#3233): one transaction on one
 * partition.
 *
 * @module
 */

import { intentPartition } from "./intent.ts";
import { isOp, type Op, opFromJSON, type OpJSON, requireFence } from "./op.ts";
import { PartitionKey } from "./partition_key.ts";

/** The most ops one commit may carry. The commit store may revisit it. */
export const MAX_COMMIT_OPS = 10_000;

/** The longest namespace, txnId, writer field or principal accepted. */
const MAX_FIELD_LENGTH = 1024;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The process that wrote a commit. */
export interface CommitWriter {
  readonly host: string;
  readonly pid: number;
  /** The writing instance's id: one CLI invocation or one serve process. */
  readonly instance: string;
}

/** What {@link Commit.create} takes. */
export interface CommitProps {
  readonly seq: number;
  readonly partition: PartitionKey;
  /** The datastore namespace; empty for an unnamespaced datastore. */
  readonly namespace: string;
  /** The outbox entry id. A retry carries the same one, so it lands once. */
  readonly txnId: string;
  readonly writer: CommitWriter;
  /** When the writer ran the operation, by its own clock. */
  readonly executedAt?: string;
  /** The writer's clock offset from the single writer's, when known. */
  readonly clockOffsetMs?: number;
  /** Who the commit acts for. Set by serve only. */
  readonly principal?: string;
  /**
   * The writer's fence: the solo writer lock's in solo mode, the leader
   * lease's in team mode (swamp-club#3234). Once a partition has seen a fence
   * it refuses a commit without one.
   */
  readonly fence?: number;
  /** When the single writer accepted the commit. */
  readonly at: string;
  readonly ops: readonly Op[];
}

/** The serialized form of a {@link Commit}. */
export interface CommitJSON {
  readonly v: 3;
  readonly seq: number;
  readonly partition: string;
  readonly namespace: string;
  readonly txnId: string;
  readonly writer: CommitWriter;
  readonly executedAt?: string;
  readonly clockOffsetMs?: number;
  readonly principal?: string;
  readonly fence?: number;
  readonly at: string;
  readonly ops: readonly OpJSON[];
}

/**
 * One transaction on one partition: its ops apply together or not at all
 * (`Partition.append`). Immutable; built by {@link Commit.create} or
 * {@link Commit.fromJSON}.
 */
export class Commit {
  readonly v = 3 as const;

  private constructor(
    readonly seq: number,
    readonly partition: PartitionKey,
    readonly namespace: string,
    readonly txnId: string,
    readonly writer: CommitWriter,
    readonly executedAt: string | undefined,
    readonly clockOffsetMs: number | undefined,
    readonly principal: string | undefined,
    readonly fence: number | undefined,
    readonly at: string,
    readonly ops: readonly Op[],
  ) {}

  /**
   * Checks the envelope. Throws when `seq` is not a positive integer, a
   * string field is empty or too long, a timestamp is not an ISO instant in
   * UTC, the fence is not a non-negative integer, there are no ops or more
   * than {@link MAX_COMMIT_OPS}, an op was not built by the op factories, a
   * put's or tombstone's intent belongs to another partition, or a
   * data-version op is in a partition that is not a model's.
   */
  static create(props: CommitProps): Commit {
    if (!Number.isSafeInteger(props.seq) || props.seq < 1) {
      throw new Error(`Commit seq must be a positive integer: ${props.seq}`);
    }
    if (!(props.partition instanceof PartitionKey)) {
      throw new TypeError("Commit partition must be a PartitionKey");
    }
    if (
      typeof props.namespace !== "string" ||
      props.namespace.length > MAX_FIELD_LENGTH
    ) {
      throw new Error(
        `Commit namespace must be a string of at most ${MAX_FIELD_LENGTH} characters`,
      );
    }
    requireText(props.txnId, "txnId");
    const writer = readWriter(props.writer);
    if (props.executedAt !== undefined) {
      requireInstant(props.executedAt, "executedAt");
    }
    if (
      props.clockOffsetMs !== undefined &&
      (typeof props.clockOffsetMs !== "number" ||
        !Number.isFinite(props.clockOffsetMs))
    ) {
      throw new Error("Commit clockOffsetMs must be a finite number");
    }
    if (props.principal !== undefined) {
      requireText(props.principal, "principal");
    }
    if (props.fence !== undefined) requireFence(props.fence);
    requireInstant(props.at, "at");
    if (!Array.isArray(props.ops) || props.ops.length === 0) {
      throw new Error("A commit carries at least one op");
    }
    if (props.ops.length > MAX_COMMIT_OPS) {
      throw new Error(`A commit carries at most ${MAX_COMMIT_OPS} ops`);
    }
    for (const op of props.ops) {
      if (!isOp(op)) {
        throw new TypeError("Commit ops must be built by the op factories");
      }
      if (op.kind === "put" || op.kind === "tombstone") {
        const target = intentPartition(op.intent);
        if (!target.equals(props.partition)) {
          throw new Error(
            `Op intent ${op.intent.kind} belongs to partition ${target}, not ${props.partition}`,
          );
        }
      }
      if (op.kind === "data-version" && props.partition.kind !== "model") {
        throw new Error(
          `A data-version op belongs in a model partition, not ${props.partition}`,
        );
      }
    }
    return new Commit(
      props.seq,
      props.partition,
      props.namespace,
      props.txnId,
      writer,
      props.executedAt,
      props.clockOffsetMs,
      props.principal,
      props.fence,
      props.at,
      Object.freeze([...props.ops]),
    );
  }

  /**
   * Parses the serialized form. Async because each put's inline digest is
   * recomputed from its bytes rather than read from the input.
   */
  static async fromJSON(value: unknown): Promise<Commit> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("A commit must be an object");
    }
    const json = value as Record<string, unknown>;
    const allowed = [
      "v",
      "seq",
      "partition",
      "namespace",
      "txnId",
      "writer",
      "executedAt",
      "clockOffsetMs",
      "principal",
      "fence",
      "at",
      "ops",
    ];
    for (const field of Object.keys(json)) {
      if (!allowed.includes(field)) {
        throw new Error(`A commit does not take the field '${field}'`);
      }
    }
    if (json.v !== 3) {
      throw new Error(`Unsupported commit format: v${String(json.v)}`);
    }
    if (typeof json.partition !== "string") {
      throw new TypeError("Commit partition must be a string");
    }
    if (!Array.isArray(json.ops)) {
      throw new TypeError("Commit ops must be an array");
    }
    if (json.ops.length > MAX_COMMIT_OPS) {
      throw new Error(`A commit carries at most ${MAX_COMMIT_OPS} ops`);
    }
    const ops: Op[] = [];
    for (const op of json.ops) ops.push(await opFromJSON(op));
    return Commit.create({
      seq: json.seq as number,
      partition: PartitionKey.parse(json.partition),
      namespace: json.namespace as string,
      txnId: json.txnId as string,
      writer: json.writer as CommitWriter,
      executedAt: json.executedAt as string | undefined,
      clockOffsetMs: json.clockOffsetMs as number | undefined,
      principal: json.principal as string | undefined,
      fence: json.fence as number | undefined,
      at: json.at as string,
      ops,
    });
  }

  toJSON(): CommitJSON {
    return {
      v: 3,
      seq: this.seq,
      partition: this.partition.toString(),
      namespace: this.namespace,
      txnId: this.txnId,
      writer: this.writer,
      ...(this.executedAt === undefined ? {} : { executedAt: this.executedAt }),
      ...(this.clockOffsetMs === undefined
        ? {}
        : { clockOffsetMs: this.clockOffsetMs }),
      ...(this.principal === undefined ? {} : { principal: this.principal }),
      ...(this.fence === undefined ? {} : { fence: this.fence }),
      at: this.at,
      ops: this.ops.map((op) => op.toJSON()),
    };
  }

  /**
   * The chunks this commit's puts name, each once: chunk garbage collection
   * must keep every one of them for as long as the commit is stored.
   */
  chunkRefs(): readonly string[] {
    const hashes = new Set<string>();
    for (const op of this.ops) {
      if (op.kind !== "put" || !("blob" in op.content)) continue;
      for (const sha256 of op.content.blob.chunkHashes()) hashes.add(sha256);
    }
    return [...hashes];
  }

  /** Commits are equal when their serialized forms are. */
  equals(other: Commit): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }
}

function readWriter(value: unknown): CommitWriter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Commit writer must be an object");
  }
  const json = value as Record<string, unknown>;
  for (const field of Object.keys(json)) {
    if (!["host", "pid", "instance"].includes(field)) {
      throw new Error(`Commit writer does not take the field '${field}'`);
    }
  }
  requireText(json.host, "writer.host");
  requireText(json.instance, "writer.instance");
  if (
    typeof json.pid !== "number" || !Number.isSafeInteger(json.pid) ||
    json.pid < 1
  ) {
    throw new Error(`Commit writer.pid must be a positive integer`);
  }
  return Object.freeze({
    host: json.host as string,
    pid: json.pid,
    instance: json.instance as string,
  });
}

function requireText(value: unknown, label: string): void {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_FIELD_LENGTH
  ) {
    throw new Error(
      `Commit ${label} must be a non-empty string of at most ${MAX_FIELD_LENGTH} characters`,
    );
  }
}

function requireInstant(value: unknown, label: string): void {
  if (
    typeof value !== "string" || !ISO_INSTANT.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    // Reject dates the engine would roll over, such as February 30.
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new Error(
      `Commit ${label} must be an ISO 8601 instant in UTC: ${String(value)}`,
    );
  }
}
