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
 * @module
 */

import type { ModelType } from "../models/model_type.ts";
import type { ContentSource, TypedChange } from "./commit_log_unit_of_work.ts";
import { createIntent, type Intent, modelRef } from "./intent.ts";
import { dataVersionOp, tombstoneOp } from "./op.ts";
import { type PartitionKey, partitionOf } from "./partition_key.ts";
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
  ): TypedChange {
    return this.#put(
      this.#writeIntent(why, name, version),
      this.dataKey(name, version, "raw"),
      raw,
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
  ): TypedChange {
    return {
      partition: this.partition,
      put: {
        intent,
        key,
        content,
        ...(expect === undefined ? {} : { expect }),
      },
    };
  }

  #key(...segments: string[]): RecordKey {
    return RecordKey.create(segments.join("/"));
  }
}

function isRemoval(
  why: DataWrite | { readonly kind: DataRemoval },
): why is { readonly kind: DataRemoval } {
  return why.kind === "data.delete" || why.kind === "data.gc";
}
