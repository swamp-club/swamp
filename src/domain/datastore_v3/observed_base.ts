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
 * The compacted base as serve sends it to a follower copy (swamp-club#4006):
 * the entries of {@link CompactedBaseEntry}, filtered to what the caller may
 * read, with each partition's data-name marks. Serve encodes them with
 * {@link observedBaseEntryToJSON}; the copy reads serve's reply as
 * untrusted input through {@link observedBaseEntryFromJSON}, which accepts
 * exactly the shape serve writes.
 *
 * @module
 */

import { DataMetadataSchema } from "../data/data_metadata.ts";
import { BlobRef, isSha256Hex } from "./blob_ref.ts";
import type { CompactedBaseEntry, DataNameMarks } from "./commit_store.ts";
import { readFileAccess } from "./file_access.ts";
import { PartitionKey } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";
import { VersionRanges } from "./version_ranges.ts";

/** One entry of the base a follower copy loads. */
export type ObservedBaseEntry =
  | Exclude<CompactedBaseEntry, { readonly kind: "partition" }>
  /** A partition's compacted seq, and its data names' marks. */
  | {
    readonly kind: "partition";
    readonly namespace: string;
    readonly partition: string;
    readonly seq: number;
    readonly names: readonly DataNameMarks[];
  };

/** One page of the base from serve. */
export interface ObservedBasePage {
  /** Serve's compaction point; pages of two points are of two bases. */
  readonly point: number;
  readonly entries: readonly ObservedBaseEntry[];
  /** Pass to the next read; undefined after the last page. */
  readonly next: string | undefined;
}

/** Thrown for a base entry that is not one serve writes. */
export class ObservedBaseEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservedBaseEntryError";
  }
}

/** The JSON form of an entry, as serve sends it. */
export function observedBaseEntryToJSON(
  entry: ObservedBaseEntry,
): Record<string, unknown> {
  switch (entry.kind) {
    case "partition":
      return {
        kind: entry.kind,
        namespace: entry.namespace,
        partition: entry.partition,
        seq: entry.seq,
        names: entry.names.map((name) => ({
          name: name.name,
          highWater: name.highWater,
          ...(name.removed === undefined || name.removed.length === 0
            ? {}
            : { removed: name.removed }),
        })),
      };
    case "record": {
      const record = entry.record;
      return {
        kind: entry.kind,
        namespace: entry.namespace,
        partition: entry.partition,
        key: entry.key,
        record: {
          sha256: record.sha256,
          ...("inline" in record.content
            ? { inline: record.content.inline }
            : { blob: record.content.blob.toJSON() }),
          ...(record.access === undefined ? {} : { access: record.access }),
        },
      };
    }
    case "version":
      return {
        kind: entry.kind,
        namespace: entry.namespace,
        partition: entry.partition,
        metadata: entry.version.metadata,
      };
    case "catalog-row":
      return {
        kind: entry.kind,
        namespace: entry.namespace,
        partition: entry.partition,
        metadata: entry.metadata,
      };
    case "forward":
      return {
        kind: entry.kind,
        namespace: entry.namespace,
        partition: entry.partition,
        name: entry.name,
        to: entry.to,
      };
    case "file":
      return {
        kind: entry.kind,
        namespace: entry.namespace,
        key: entry.key,
        owner: entry.ownership.owner,
        mark: entry.ownership.mark,
        present: entry.ownership.present,
      };
  }
}

/**
 * Reads one entry of serve's reply. Every field is checked, and an entry of
 * another shape, or of a namespace other than `namespace`, is refused with
 * {@link ObservedBaseEntryError}: serve's replies are untrusted
 * (swamp-club#4062).
 */
export function observedBaseEntryFromJSON(
  raw: unknown,
  namespace: string,
): ObservedBaseEntry {
  const json = objectOf(raw, "A base entry");
  const kind = json.kind;
  if (json.namespace !== namespace) {
    throw new ObservedBaseEntryError(
      `A base entry of namespace ${
        JSON.stringify(json.namespace)
      }, not this copy's ${JSON.stringify(namespace)}`,
    );
  }
  switch (kind) {
    case "partition": {
      only(json, ["kind", "namespace", "partition", "seq", "names"]);
      if (!Array.isArray(json.names)) fail("names must be an array");
      return {
        kind,
        namespace,
        partition: partitionOf(json.partition),
        seq: positive(json.seq, "seq"),
        names: (json.names as unknown[]).map(marksOf),
      };
    }
    case "record": {
      only(json, ["kind", "namespace", "partition", "key", "record"]);
      const record = objectOf(json.record, "A base record");
      only(record, ["sha256", "inline", "blob", "access"]);
      if (!isSha256Hex(record.sha256)) fail("sha256 must be a SHA-256 digest");
      if ((record.inline === undefined) === (record.blob === undefined)) {
        fail("a base record holds exactly one of inline and blob");
      }
      if (record.inline !== undefined && typeof record.inline !== "string") {
        fail("inline must be a string");
      }
      const access = readFileAccess(record.access);
      return {
        kind,
        namespace,
        partition: partitionOf(json.partition),
        key: keyOf(json.key),
        record: {
          sha256: record.sha256 as string,
          content: record.inline !== undefined
            ? { inline: record.inline as string }
            : { blob: BlobRef.fromJSON(record.blob) },
          ...(access === undefined ? {} : { access }),
        },
      };
    }
    case "version": {
      only(json, ["kind", "namespace", "partition", "metadata"]);
      const metadata = DataMetadataSchema.parse(json.metadata);
      return {
        kind,
        namespace,
        partition: partitionOf(json.partition),
        version: { version: metadata.version, metadata },
      };
    }
    case "catalog-row":
      only(json, ["kind", "namespace", "partition", "metadata"]);
      return {
        kind,
        namespace,
        partition: partitionOf(json.partition),
        metadata: DataMetadataSchema.parse(json.metadata),
      };
    case "forward":
      only(json, ["kind", "namespace", "partition", "name", "to"]);
      return {
        kind,
        namespace,
        partition: partitionOf(json.partition),
        name: nonEmpty(json.name, "name"),
        to: nonEmpty(json.to, "to"),
      };
    case "file":
      only(json, ["kind", "namespace", "key", "owner", "mark", "present"]);
      if (typeof json.present !== "boolean") fail("present must be a boolean");
      return {
        kind,
        namespace,
        key: keyOf(json.key),
        ownership: {
          owner: partitionOf(json.owner),
          mark: positive(json.mark, "mark"),
          present: json.present as boolean,
        },
      };
  }
  return fail(`unknown base entry kind ${JSON.stringify(kind)}`);
}

function marksOf(raw: unknown): DataNameMarks {
  const json = objectOf(raw, "A data name's marks");
  only(json, ["name", "highWater", "removed"]);
  const removed = json.removed === undefined
    ? undefined
    : rangesOf(json.removed);
  return {
    name: nonEmpty(json.name, "name"),
    highWater: nonNegative(json.highWater, "highWater"),
    ...(removed === undefined ? {} : { removed }),
  };
}

function rangesOf(raw: unknown): VersionRanges["ranges"] {
  if (
    !Array.isArray(raw) ||
    !raw.every((range) =>
      Array.isArray(range) && range.length === 2 &&
      range.every((n) => Number.isSafeInteger(n) && n > 0)
    )
  ) {
    fail("removed must be a list of version ranges");
  }
  return VersionRanges.of(raw as number[][]).ranges;
}

function objectOf(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${what} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function only(json: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of Object.keys(json)) {
    if (!fields.includes(field)) fail(`unexpected field '${field}'`);
  }
}

function partitionOf(raw: unknown): string {
  if (typeof raw !== "string") fail("a partition must be a string");
  try {
    return PartitionKey.parse(raw as string).toString();
  } catch {
    return fail(`not a partition key: ${JSON.stringify(raw)}`);
  }
}

function keyOf(raw: unknown): string {
  if (typeof raw !== "string") fail("a key must be a string");
  try {
    return RecordKey.create(raw as string).toString();
  } catch {
    return fail(`not a record key: ${JSON.stringify(raw)}`);
  }
}

function positive(raw: unknown, field: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1) {
    fail(`${field} must be a positive integer`);
  }
  return raw as number;
}

function nonNegative(raw: unknown, field: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
    fail(`${field} must be a non-negative integer`);
  }
  return raw as number;
}

function nonEmpty(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return raw as string;
}

function fail(message: string): never {
  throw new ObservedBaseEntryError(
    `Serve sent a malformed base entry: ${message}`,
  );
}
