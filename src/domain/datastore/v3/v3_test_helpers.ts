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

import { ModelType } from "../../models/model_type.ts";
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
