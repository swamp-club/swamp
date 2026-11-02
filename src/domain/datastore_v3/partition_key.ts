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
 * type and name segments are percent-encoded since flattening / to - would give
 * a-b/c and a/b-c one key; ids are UUIDs, which never hold --, so a key parses
 * back without ambiguity
 */

import { ModelType } from "../models/model_type.ts";

export const DEFINITION_KINDS = ["model", "workflow", "vault"] as const;

export type DefinitionKind = typeof DEFINITION_KINDS[number];

export const LOCKFILE_NAME = "upstream_extensions";

export const MAX_PARTITION_KEY_LENGTH = 1024;

/**
 * only a model type's normalized form reaches the key, so every spelling of one
 * type gives one partition
 */
export type AggregateIdentity =
  | { readonly kind: "model"; readonly type: ModelType; readonly id: string }
  | {
    readonly kind: "run";
    readonly workflowId: string;
    readonly runId: string;
  }
  | {
    readonly kind: "config";
    readonly definitionKind: DefinitionKind;
    readonly name: string;
  }
  | { readonly kind: "lockfile" }
  | { readonly kind: "definition"; readonly id: string };

export type PartitionIdentity =
  | { readonly kind: "model"; readonly type: string; readonly id: string }
  | Exclude<AggregateIdentity, { kind: "model" }>;

const BUILD: unique symbol = Symbol("PartitionKey.build");

/**
 * A UUID in canonical lowercase. Ids are lowercased by {@link partitionOf}, so
 * one aggregate never splits into two partitions by letter case, and
 * {@link PartitionKey.parse} accepts only the lowercase form.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_LENGTH = 36;

export class PartitionKey {
  private constructor(
    private readonly value: string,
    readonly identity: PartitionIdentity,
  ) {}

  static fromIdentity(
    token: typeof BUILD,
    identity: PartitionIdentity,
  ): PartitionKey {
    if (token !== BUILD) throw new Error("Use partitionOf() to build a key");
    const value = format(identity);
    if (value.length > MAX_PARTITION_KEY_LENGTH) {
      throw new Error(
        `Partition key is longer than ${MAX_PARTITION_KEY_LENGTH} characters`,
      );
    }
    return new PartitionKey(value, identity);
  }

  static parse(value: string): PartitionKey {
    if (typeof value !== "string") {
      throw new TypeError("Partition key must be a string");
    }
    const identity = parseIdentity(value);
    const key = PartitionKey.fromIdentity(BUILD, identity);
    if (key.value !== value) {
      throw new Error(`Partition key is not canonical: ${value}`);
    }
    return key;
  }

  get kind(): PartitionIdentity["kind"] {
    return this.identity.kind;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }

  equals(other: PartitionKey): boolean {
    return this.value === other.value;
  }
}

export function partitionOf(identity: AggregateIdentity): PartitionKey {
  switch (identity.kind) {
    case "model":
      if (!(identity.type instanceof ModelType)) {
        throw new TypeError("A model partition needs a ModelType");
      }
      return PartitionKey.fromIdentity(BUILD, {
        kind: "model",
        type: identity.type.normalized,
        id: canonicalUuid(identity.id, "model id"),
      });
    case "run":
      return PartitionKey.fromIdentity(BUILD, {
        kind: "run",
        workflowId: canonicalUuid(identity.workflowId, "workflow id"),
        runId: canonicalUuid(identity.runId, "run id"),
      });
    case "config":
      if (!DEFINITION_KINDS.includes(identity.definitionKind)) {
        throw new Error(
          `Unknown definition kind: ${String(identity.definitionKind)}`,
        );
      }
      requireName(identity.name);
      return PartitionKey.fromIdentity(BUILD, {
        kind: "config",
        definitionKind: identity.definitionKind,
        name: identity.name,
      });
    case "lockfile":
      return PartitionKey.fromIdentity(BUILD, { kind: "lockfile" });
    case "definition":
      return PartitionKey.fromIdentity(BUILD, {
        kind: "definition",
        id: canonicalUuid(identity.id, "auto-definition id"),
      });
    default: {
      const unknown: never = identity;
      throw new Error(
        `Unknown aggregate kind: ${
          String((unknown as { kind: unknown }).kind)
        }`,
      );
    }
  }
}

export function runPartitionsPrefix(workflowId: string): string {
  return `run--${canonicalUuid(workflowId, "workflow id")}--`;
}

function format(identity: PartitionIdentity): string {
  switch (identity.kind) {
    case "model":
      return `model--${encodeSegment(identity.type)}--${identity.id}`;
    case "run":
      return `run--${identity.workflowId}--${identity.runId}`;
    case "config":
      return `config--${identity.definitionKind}--${
        encodeSegment(identity.name)
      }`;
    case "lockfile":
      return `config--lockfile--${LOCKFILE_NAME}`;
    case "definition":
      return `definition--${identity.id}`;
  }
}

function parseIdentity(value: string): PartitionIdentity {
  if (value.startsWith("model--")) {
    const rest = value.slice("model--".length);
    const at = rest.lastIndexOf("--");
    if (at <= 0) throw new Error(`Malformed model partition key: ${value}`);
    const type = decodeSegment(rest.slice(0, at), value);
    const id = rest.slice(at + 2);
    requireUuid(id, "model id");
    let normalized: string;
    try {
      normalized = ModelType.create(type).normalized;
    } catch {
      throw new Error(`Malformed model partition key: ${value}`);
    }
    if (normalized !== type) {
      throw new Error(
        `Partition key holds a model type that is not normalized: ${value}`,
      );
    }
    return { kind: "model", type, id };
  }
  if (value.startsWith("run--")) {
    const rest = value.slice("run--".length);
    if (
      rest.length !== UUID_LENGTH * 2 + 2 ||
      rest.slice(UUID_LENGTH, UUID_LENGTH + 2) !== "--"
    ) {
      throw new Error(`Malformed run partition key: ${value}`);
    }
    const workflowId = rest.slice(0, UUID_LENGTH);
    const runId = rest.slice(UUID_LENGTH + 2);
    requireUuid(workflowId, "workflow id");
    requireUuid(runId, "run id");
    return { kind: "run", workflowId, runId };
  }
  if (value === `config--lockfile--${LOCKFILE_NAME}`) {
    return { kind: "lockfile" };
  }
  if (value.startsWith("config--")) {
    const rest = value.slice("config--".length);
    for (const definitionKind of DEFINITION_KINDS) {
      const prefix = `${definitionKind}--`;
      if (rest.startsWith(prefix)) {
        const name = decodeSegment(rest.slice(prefix.length), value);
        requireName(name);
        return { kind: "config", definitionKind, name };
      }
    }
    throw new Error(`Malformed config partition key: ${value}`);
  }
  if (value.startsWith("definition--")) {
    const id = value.slice("definition--".length);
    requireUuid(id, "auto-definition id");
    return { kind: "definition", id };
  }
  throw new Error(`Unknown partition key kind: ${value}`);
}

/**
 * Percent-encodes a type or name segment. `@` stays literal, as it reads
 * better in a key and is never a separator; everything encodeURIComponent
 * encodes otherwise stays encoded, including `/` as `%2F`.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll("%40", "@");
}

function decodeSegment(segment: string, key: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error(`Partition key is not validly percent-encoded: ${key}`);
  }
  if (encodeSegment(decoded) !== segment) {
    throw new Error(`Partition key is not canonically encoded: ${key}`);
  }
  return decoded;
}

function canonicalUuid(id: string, label: string): string {
  const lowered = typeof id === "string" ? id.toLowerCase() : id;
  requireUuid(lowered, label);
  return lowered;
}

function requireUuid(id: string, label: string): void {
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new Error(`A partition ${label} must be a UUID: ${String(id)}`);
  }
}

function requireName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("A config partition needs a non-empty name");
  }
}
