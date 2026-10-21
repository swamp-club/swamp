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
 * The typed changes a model's data and output repositories stage on v3
 * (swamp-club#3250): a factory that turns what a repository already knows
 * (the model's type and id, a data name and version, an output's file) into
 * {@link TypedChange}s with the right partition, intent and record key.
 * Repositories never build a partition key or an intent themselves.
 *
 * Record keys are built from segments in today's cache layout, relative to
 * the namespace root, never from an OS path, so a Windows separator cannot
 * reach a key:
 *
 * - `data/{type}/{modelId}/{name}/{version}/raw` and `.../metadata.yaml`;
 * - `data/{type}/{modelId}/{name}/latest`, the name's latest marker;
 * - `outputs/{type}/{method}/{file}`, an output record.
 *
 * The mapping from each repository write to these changes is in "v3
 * repository staging", `design/enablers/datastores.md`.
 *
 * swamp-club#3256 adds the factories of the definition, workflow and
 * evaluated repositories: {@link ConfigChanges} for a managed-config
 * definition (and its evaluated workflow), {@link AutoDefinitionChanges},
 * {@link RunSnapshotChanges}, and the evaluated-definition changes of
 * {@link ModelChanges}. Their keys are the path a repository wrote or
 * removed, relative to the namespace root, as segments
 * ({@link recordKeyOf}); each change takes its precondition explicitly,
 * because the repository decides it per key.
 *
 * swamp-club#3257 adds {@link RunChanges}, a workflow run's record.
 *
 * @module
 */

import type { ModelType } from "../models/model_type.ts";
import type { ContentSource, TypedChange } from "./commit_log_unit_of_work.ts";
import type { FileAccess } from "./file_access.ts";
import { createIntent, type Intent, modelRef } from "./intent.ts";
import { dataVersionOp, type PutExpect, tombstoneOp } from "./op.ts";
import {
  type DefinitionKind,
  type PartitionKey,
  partitionOf,
} from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";

/** The two files a data version's directory holds. */
export type DataVersionFile = "raw" | "metadata.yaml";

/** What a removal of data does, which decides its intent. */
export type DataRemoval = "data.delete" | "data.gc";

/**
 * Why a version is written: a save, an append to a live version, or a
 * rename's write (under the new name, or the old name's marker), whose
 * intent names the old name and the new one.
 */
export type DataWrite =
  | { readonly kind: "data.save" | "data.append" }
  | {
    readonly kind: "data.rename";
    readonly from: string;
    readonly to: string;
  };

/** One data version's files, as a repository wrote them. */
export interface WrittenVersion {
  readonly name: string;
  readonly version: number;
  /** The metadata written to `metadata.yaml`, as the repository built it. */
  readonly metadata: unknown;
  readonly metadataBytes: Uint8Array;
  /**
   * The SHA-256 the version's `metadata.yaml` must hold for the write to
   * apply: an append edits the version it was loaded from, so a version
   * another writer recorded under the same number refuses it.
   */
  readonly metadataExpect?: { readonly sha256: string };
  /** The version's content: bytes, or a stream of the file just written. */
  readonly raw: ContentSource;
  /**
   * The content file's access (swamp-club#3693), so every checkout's copy
   * is executable or private when the writer's was; undefined when plain.
   */
  readonly rawAccess?: FileAccess;
}

/** The typed changes for one model's data and outputs. */
export class ModelChanges {
  readonly partition: PartitionKey;
  readonly #type: ModelType;
  readonly #modelId: string;

  constructor(type: ModelType, modelId: string) {
    this.partition = partitionOf({ kind: "model", type, id: modelId });
    this.#type = type;
    this.#modelId = modelId;
  }

  /** The key of a version's file. */
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

  /** The key of a name's latest marker. */
  latestKey(name: string): RecordKey {
    return this.#key(
      "data",
      this.#type.toDirectoryPath(),
      this.#modelId,
      name,
      "latest",
    );
  }

  /**
   * A written version: puts of its content and metadata, and the
   * data-version op recording it. A save or a rename records a version the
   * name does not hold live; an append re-records the live version it
   * extended.
   */
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
   * A written version whose metadata is gone, so it records no version: a
   * promotion whose metadata a concurrent delete removed still moves the
   * marker and keeps the content, as v2 does.
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
   * A latest-marker write. A save's or append's names the version it points
   * at; a removal's (the marker lowered after a delete or gc) carries no
   * version, as the marker is no version's.
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

  /** A removed version: tombstones of both of its files, with its version. */
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
   * A removed latest marker. A version-less `data.gc` is expiry
   * (`removeLatestMarker`): the read model drops the name's catalog rows
   * and keeps its versions.
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

  /** A written evaluated definition of this model (swamp-club#3256). */
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

  /** A removed evaluated definition file of this model. */
  removeEvaluatedDefinition(key: RecordKey): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({
        intent: this.#intent({ kind: "evaluated-definition.delete" }),
        key,
      }),
    };
  }

  /** The key of an output record. */
  outputKey(method: string, file: string): RecordKey {
    return this.#key("outputs", this.#type.normalized, method, file);
  }

  /** A written output record. */
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

  /** A removed output record. */
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
 * A record key from path segments relative to the namespace root, e.g.
 * `["config", "models", "aws", "vpc.yaml"]`. A segment holding a separator
 * is refused, so an OS path never reaches a key unsplit.
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

/** The intents a managed-config definition's own file changes carry. */
export type ConfigWrite =
  | "definition.create"
  | "definition.edit"
  | "evaluated-workflow.save";

/** The intents of a removal in a managed-config definition's partition. */
export type ConfigRemoval =
  | "definition.create"
  | "definition.edit"
  | "definition.delete"
  | "evaluated-workflow.delete";

/**
 * The typed changes of one managed-config definition, by kind and name
 * (swamp-club#3256): its files under `config/`, and for a workflow its
 * evaluated workflow under `workflows-evaluated/`. A rename spans two of
 * these: {@link renameTo} in the new name's, then {@link renameFrom} in the
 * old name's, staged as two batches so the new name lands first.
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
   * A written file. A create or edit of the definition carries the
   * precondition the repository read: `absent` for a new key, the replaced
   * bytes' digest for an edit. An evaluated workflow carries none.
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

  /**
   * A removed file: a delete, the old key of a move (with the move's create
   * or edit intent, expecting the file present), or an evaluated workflow.
   */
  remove(why: ConfigRemoval, key: RecordKey, expect?: "present"): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({ intent: this.#intent({ kind: why }), key, expect }),
    };
  }

  /**
   * A rename's write under this, the new, name: a put that expects the key
   * absent in this partition, naming the old name.
   */
  renameTo(from: string, key: RecordKey, content: ContentSource): TypedChange {
    return putChange(
      this.partition,
      this.#intent({ kind: "definition.rename-to", from }),
      key,
      content,
      "absent",
    );
  }

  /**
   * A rename's removal under this, the old, name: a tombstone that expects
   * the key present, naming the new name.
   */
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
 * The typed changes of one auto-definition, by id (swamp-club#3256). None
 * carries a precondition: every direct execution rewrites the file, and
 * writers v3 never sees leave files its partition does not hold.
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

  /** A written auto-definition file. */
  write(key: RecordKey, content: ContentSource): TypedChange {
    return putChange(
      this.partition,
      this.#intentOf("auto-definition.save"),
      key,
      content,
    );
  }

  /** A removed auto-definition file. */
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

/**
 * The typed changes of one workflow run's evaluated-workflow snapshot
 * (swamp-club#3256). The snapshot is derived, so neither carries a
 * precondition.
 */
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

  /** A written snapshot. */
  write(key: RecordKey, content: ContentSource): TypedChange {
    return putChange(
      this.partition,
      this.#intentOf("run-snapshot.save"),
      key,
      content,
    );
  }

  /** A removed snapshot. */
  remove(key: RecordKey): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({ intent: this.#intentOf("run-snapshot.delete"), key }),
    };
  }
}

/**
 * The typed changes of one workflow run's record (swamp-club#3257). None
 * carries a precondition: a run has one writer at a time under its lock,
 * and cancel, recovery and the reapers rewrite the record too. A
 * run is saved many times in one unit, so its record is staged as a stream
 * of the written file: the unit elides every earlier save still unread, and
 * a flush commits the last one, under the last save's intent.
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

  /** A written run record: `run.create` for a new file, else `run.update`. */
  write(
    kind: "run.create" | "run.update",
    key: RecordKey,
    content: ContentSource,
  ): TypedChange {
    return putChange(this.partition, this.#intentOf(kind), key, content);
  }

  /** A removed run record. */
  remove(key: RecordKey): TypedChange {
    return {
      partition: this.partition,
      op: tombstoneOp({ intent: this.#intentOf("run.delete"), key }),
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
): TypedChange {
  return {
    partition,
    put: {
      intent,
      key,
      content,
      ...(expect === undefined ? {} : { expect }),
      ...(access === undefined ? {} : { access }),
    },
  };
}

function isRemoval(
  why: DataWrite | { readonly kind: DataRemoval },
): why is { readonly kind: DataRemoval } {
  return why.kind === "data.delete" || why.kind === "data.gc";
}

/**
 * The typed change of the managed-config extension lockfile
 * (swamp-club#3279): one put in its single partition. The lockfile is only
 * ever rewritten, never removed.
 */
export class LockfileChanges {
  readonly partition: PartitionKey = partitionOf({ kind: "lockfile" });

  /** The lockfile as written. */
  write(key: RecordKey, content: ContentSource): TypedChange {
    return putChange(
      this.partition,
      createIntent({ kind: "lockfile.write" }),
      key,
      content,
    );
  }
}
