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
 * record keys are built from segments relative to the namespace root, never
 * from an OS path, so a Windows separator cannot reach a key
 */

import type { ModelType } from "../models/model_type.ts";
import type { ContentSource, TypedChange } from "./commit_log_unit_of_work.ts";
import type { FileAccess } from "./file_access.ts";
import { createIntent, type Intent, modelRef } from "./intent.ts";
import {
  dataVersionOp,
  type PutExpect,
  type TombstoneExpect,
  tombstoneOp,
} from "./op.ts";
import {
  type DefinitionKind,
  type PartitionKey,
  partitionOf,
} from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";

export type DataVersionFile = "raw" | "metadata.yaml";

export type DataRemoval = "data.delete" | "data.gc";

export type DataWrite =
  | { readonly kind: "data.save" | "data.append" }
  | {
    readonly kind: "data.rename";
    readonly from: string;
    readonly to: string;
  };

export interface WrittenVersion {
  readonly name: string;
  readonly version: number;
  readonly metadata: unknown;
  readonly metadataBytes: Uint8Array;
  /**
   * The SHA-256 the version's `metadata.yaml` must hold for the write to
   * apply: an append edits the version it was loaded from, so a version
   * another writer recorded under the same number refuses it.
   */
  readonly metadataExpect?: { readonly sha256: string };
  readonly raw: ContentSource;
  /**
   * so every checkout's copy is executable or private when the writer's was;
   * undefined when plain
   */
  readonly rawAccess?: FileAccess;
}

export class ModelChanges {
  readonly partition: PartitionKey;
  readonly #type: ModelType;
  readonly #modelId: string;

  constructor(type: ModelType, modelId: string) {
    this.partition = partitionOf({ kind: "model", type, id: modelId });
    this.#type = type;
    this.#modelId = modelId;
  }

  dataKey(name: string, version: number, file: DataVersionFile): RecordKey {
    return this.#key(
      "data",
      this.#type.toDirectoryPath(),
      this.#modelId,
      name,
      String(version),
      file,
    );
  }

  latestKey(name: string): RecordKey {
    return this.#key(
      "data",
      this.#type.toDirectoryPath(),
      this.#modelId,
      name,
      "latest",
    );
  }

  writeVersion(why: DataWrite, written: WrittenVersion): TypedChange[] {
    const intent = this.#writeIntent(why, written.name, written.version);
    const metadataKey = this.dataKey(
      written.name,
      written.version,
      "metadata.yaml",
    );
    return [
      this.#put(
        intent,
        this.dataKey(written.name, written.version, "raw"),
        written.raw,
        undefined,
        written.rawAccess,
      ),
      this.#put(
        intent,
        metadataKey,
        written.metadataBytes,
        written.metadataExpect,
      ),
      {
        partition: this.partition,
        op: dataVersionOp({ key: metadataKey, metadata: written.metadata }),
      },
    ];
  }

  /**
   * a promotion whose metadata a concurrent delete removed still moves the
   * marker and keeps the content, as v2 does
   */
  writeContent(
    why: DataWrite,
    name: string,
    version: number,
    raw: ContentSource,
    access?: FileAccess,
  ): TypedChange {
    return this.#put(
      this.#writeIntent(why, name, version),
      this.dataKey(name, version, "raw"),
      raw,
      undefined,
      access,
    );
  }

  /**
   * a removal's marker write (lowered after a delete or gc) carries no version,
   * as the marker is no version's
   */
  latestPut(
    why: DataWrite | { readonly kind: DataRemoval },
    name: string,
    version: number,
    bytes: Uint8Array,
  ): TypedChange {
    const intent = isRemoval(why)
      ? this.#intent({ kind: why.kind, name })
      : this.#writeIntent(why, name, version);
    return this.#put(intent, this.latestKey(name), bytes);
  }

  removeVersion(
    why: DataRemoval,
    name: string,
    version: number,
  ): TypedChange[] {
    const intent = this.#intent({ kind: why, name, version });
    return (["raw", "metadata.yaml"] as const).map((file) => ({
      partition: this.partition,
      op: tombstoneOp({ intent, key: this.dataKey(name, version, file) }),
    }));
  }

  /**
   * a version-less data.gc is expiry: the read model drops the name's catalog
   * rows and keeps its versions
   */
  removeLatest(why: DataRemoval, name: string): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({
        intent: this.#intent({ kind: why, name }),
        key: this.latestKey(name),
      }),
    };
  }

  writeEvaluatedDefinition(
    key: RecordKey,
    content: ContentSource,
  ): TypedChange {
    return this.#put(
      this.#intent({ kind: "evaluated-definition.save" }),
      key,
      content,
    );
  }

  removeEvaluatedDefinition(key: RecordKey): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({
        intent: this.#intent({ kind: "evaluated-definition.delete" }),
        key,
      }),
    };
  }

  outputKey(method: string, file: string): RecordKey {
    return this.#key("outputs", this.#type.normalized, method, file);
  }

  writeOutput(
    outputId: string,
    method: string,
    file: string,
    bytes: Uint8Array,
  ): TypedChange {
    return this.#put(
      this.#intent({ kind: "output.save", outputId }),
      this.outputKey(method, file),
      bytes,
    );
  }

  removeOutput(outputId: string, method: string, file: string): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({
        intent: this.#intent({ kind: "output.delete", outputId }),
        key: this.outputKey(method, file),
      }),
    };
  }

  #writeIntent(why: DataWrite, name: string, version: number): Intent {
    return why.kind === "data.rename"
      ? this.#intent({ kind: why.kind, name: why.from, to: why.to })
      : this.#intent({ kind: why.kind, name, version });
  }

  #intent(fields: Record<string, unknown>): Intent {
    return createIntent({
      ...fields,
      model: modelRef(this.#type, this.#modelId),
    });
  }

  #put(
    intent: Intent,
    key: RecordKey,
    content: ContentSource,
    expect?: { readonly sha256: string },
    access?: FileAccess,
  ): TypedChange {
    return putChange(this.partition, intent, key, content, expect, access);
  }

  #key(...segments: string[]): RecordKey {
    return RecordKey.create(segments.join("/"));
  }
}

/**
 * a segment holding a separator is refused, so an OS path never reaches a key
 * unsplit
 */
export function recordKeyOf(segments: readonly string[]): RecordKey {
  for (const segment of segments) {
    if (segment.includes("/") || segment.includes("\\")) {
      throw new Error(
        `A record key segment must not hold a separator: ${segment}`,
      );
    }
  }
  return RecordKey.create(segments.join("/"));
}

export type ConfigWrite =
  | "definition.create"
  | "definition.edit"
  | "evaluated-workflow.save";

export type ConfigRemoval =
  | "definition.create"
  | "definition.edit"
  | "definition.delete"
  | "evaluated-workflow.delete";

/**
 * a rename is staged as two batches, renameTo in the new name's partition then
 * renameFrom in the old one's, so the new name lands first
 */
export class ConfigChanges {
  readonly partition: PartitionKey;
  readonly #kind: DefinitionKind;
  readonly #name: string;

  constructor(kind: DefinitionKind, name: string) {
    this.partition = partitionOf({
      kind: "config",
      definitionKind: kind,
      name,
    });
    this.#kind = kind;
    this.#name = name;
  }

  /**
   * a create or edit of the definition carries the precondition the repository
   * read: absent for a new key, the replaced bytes' digest for an edit; an
   * evaluated workflow carries none
   */
  write(
    why: ConfigWrite,
    key: RecordKey,
    content: ContentSource,
    expect?: PutExpect,
  ): TypedChange {
    return putChange(
      this.partition,
      this.#intent({ kind: why }),
      key,
      content,
      expect,
    );
  }

  remove(
    why: ConfigRemoval,
    key: RecordKey,
    expect?: TombstoneExpect,
  ): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({ intent: this.#intent({ kind: why }), key, expect }),
    };
  }

  renameTo(from: string, key: RecordKey, content: ContentSource): TypedChange {
    return putChange(
      this.partition,
      this.#intent({ kind: "definition.rename-to", from }),
      key,
      content,
      "absent",
    );
  }

  renameFrom(to: string, key: RecordKey): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({
        intent: this.#intent({ kind: "definition.rename-from", to }),
        key,
        expect: "present",
      }),
    };
  }

  #intent(fields: Record<string, unknown>): Intent {
    return createIntent({
      ...fields,
      definition: { kind: this.#kind, name: this.#name },
    });
  }
}

/**
 * no precondition: every direct execution rewrites the file, and writers v3
 * never sees leave files its partition does not hold
 */
export class AutoDefinitionChanges {
  readonly partition: PartitionKey;
  readonly #intentOf: (
    kind: "auto-definition.save" | "auto-definition.delete",
  ) => Intent;

  constructor(id: string) {
    this.partition = partitionOf({ kind: "definition", id });
    this.#intentOf = (kind) => createIntent({ kind, autoDefinition: { id } });
  }

  write(key: RecordKey, content: ContentSource): TypedChange {
    return putChange(
      this.partition,
      this.#intentOf("auto-definition.save"),
      key,
      content,
    );
  }

  remove(key: RecordKey): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({
        intent: this.#intentOf("auto-definition.delete"),
        key,
      }),
    };
  }
}

/** the snapshot is derived, so neither change carries a precondition */
export class RunSnapshotChanges {
  readonly partition: PartitionKey;
  readonly #intentOf: (
    kind: "run-snapshot.save" | "run-snapshot.delete",
  ) => Intent;

  constructor(workflowId: string, runId: string) {
    this.partition = partitionOf({ kind: "run", workflowId, runId });
    this.#intentOf = (kind) =>
      createIntent({ kind, run: { workflowId, runId } });
  }

  write(key: RecordKey, content: ContentSource): TypedChange {
    return putChange(
      this.partition,
      this.#intentOf("run-snapshot.save"),
      key,
      content,
    );
  }

  remove(key: RecordKey): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({ intent: this.#intentOf("run-snapshot.delete"), key }),
    };
  }
}

/**
 * no precondition: a run has one writer under its lock, and cancel, recovery
 * and reapers rewrite it too; staged as a stream so the unit elides earlier
 * unread saves and a flush commits the last
 */
export class RunChanges {
  readonly partition: PartitionKey;
  readonly #intentOf: (
    kind: "run.create" | "run.update" | "run.delete",
  ) => Intent;

  constructor(workflowId: string, runId: string) {
    this.partition = partitionOf({ kind: "run", workflowId, runId });
    this.#intentOf = (kind) =>
      createIntent({ kind, run: { workflowId, runId } });
  }

  write(
    kind: "run.create" | "run.update",
    key: RecordKey,
    content: ContentSource,
    withdrawn?: () => boolean,
  ): TypedChange {
    return putChange(
      this.partition,
      this.#intentOf(kind),
      key,
      content,
      undefined,
      undefined,
      withdrawn,
    );
  }

  remove(key: RecordKey): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({ intent: this.#intentOf("run.delete"), key }),
    };
  }
}

/** a start is written once under its own key, so neither carries a precondition */
export class RunStartChanges {
  readonly partition: PartitionKey;
  readonly #intentOf: (kind: "run-start.save" | "run-start.delete") => Intent;

  constructor(workflowId: string, runId: string) {
    this.partition = partitionOf({ kind: "run", workflowId, runId });
    this.#intentOf = (kind) =>
      createIntent({ kind, run: { workflowId, runId } });
  }

  write(key: RecordKey, content: Uint8Array): TypedChange {
    return putChange(
      this.partition,
      this.#intentOf("run-start.save"),
      key,
      content,
    );
  }

  remove(key: RecordKey): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({ intent: this.#intentOf("run-start.delete"), key }),
    };
  }
}

function putChange(
  partition: PartitionKey,
  intent: Intent,
  key: RecordKey,
  content: ContentSource,
  expect?: PutExpect,
  access?: FileAccess,
  withdrawn?: () => boolean,
): TypedChange {
  return {
    partition,
    put: {
      intent,
      key,
      content,
      ...(expect === undefined ? {} : { expect }),
      ...(access === undefined ? {} : { access }),
      ...(withdrawn === undefined ? {} : { withdrawn }),
    },
  };
}

function isRemoval(
  why: DataWrite | { readonly kind: DataRemoval },
): why is { readonly kind: DataRemoval } {
  return why.kind === "data.delete" || why.kind === "data.gc";
}

export class LockfileChanges {
  readonly partition: PartitionKey = partitionOf({ kind: "lockfile" });

  write(
    key: RecordKey,
    content: ContentSource,
    expect?: PutExpect,
  ): TypedChange {
    return putChange(
      this.partition,
      createIntent({ kind: "lockfile.write" }),
      key,
      content,
      expect,
    );
  }
}
