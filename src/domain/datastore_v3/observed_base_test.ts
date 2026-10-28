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

import { assertEquals, assertThrows } from "@std/assert";
import { BlobRef } from "./blob_ref.ts";
import {
  type ObservedBaseEntry,
  ObservedBaseEntryError,
  observedBaseEntryFromJSON,
  observedBaseEntryToJSON,
} from "./observed_base.ts";
import {
  type DataMetadata,
  DataMetadataSchema,
} from "../data/data_metadata.ts";
import { metadata as rawMetadata, modelPartition } from "./v3_test_helpers.ts";

const metadata = (name: string, version: number): DataMetadata =>
  DataMetadataSchema.parse(rawMetadata(name, version));

const PARTITION = modelPartition().toString();
const SHA = "a".repeat(64);
const KEY =
  "data/@swamp/aws-ec2/6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b/vpc/1/raw";

function entries(): ObservedBaseEntry[] {
  return [
    {
      kind: "partition",
      namespace: "ns",
      partition: PARTITION,
      seq: 4,
      names: [{ name: "vpc", highWater: 3, removed: [[2, 2]] }],
    },
    {
      kind: "record",
      namespace: "ns",
      partition: PARTITION,
      key: KEY,
      record: { sha256: SHA, content: { inline: "eA==" } },
    },
    {
      kind: "record",
      namespace: "ns",
      partition: PARTITION,
      key: KEY,
      record: {
        sha256: SHA,
        content: { blob: BlobRef.create({ sha256: SHA, size: 3 }) },
        access: "private",
      },
    },
    {
      kind: "version",
      namespace: "ns",
      partition: PARTITION,
      version: { version: 1, metadata: metadata("vpc", 1) },
    },
    {
      kind: "catalog-row",
      namespace: "ns",
      partition: PARTITION,
      metadata: metadata("vpc", 1),
    },
    {
      kind: "forward",
      namespace: "ns",
      partition: PARTITION,
      name: "vpc",
      to: "net",
    },
    {
      kind: "file",
      namespace: "ns",
      key: KEY,
      ownership: { owner: PARTITION, mark: 7, present: true },
    },
  ];
}

Deno.test("observedBaseEntryFromJSON: reads back every entry serve writes", () => {
  for (const entry of entries()) {
    const wire = JSON.parse(JSON.stringify(observedBaseEntryToJSON(entry)));
    assertEquals(
      JSON.stringify(observedBaseEntryFromJSON(wire, "ns")),
      JSON.stringify(entry),
      entry.kind,
    );
  }
});

Deno.test("observedBaseEntryFromJSON: refuses an entry of another namespace", () => {
  const wire = observedBaseEntryToJSON(entries()[1]);
  assertThrows(
    () => observedBaseEntryFromJSON(wire, "other"),
    ObservedBaseEntryError,
    "namespace",
  );
});

Deno.test("observedBaseEntryFromJSON: refuses any field, kind or value serve does not write", () => {
  const record = observedBaseEntryToJSON(entries()[1]);
  const cases: unknown[] = [
    null,
    [],
    { ...record, kind: "commit" },
    { ...record, extra: 1 },
    { ...record, partition: "not a partition" },
    { ...record, key: "../escape" },
    { ...record, record: { sha256: "x", inline: "eA==" } },
    { ...record, record: { sha256: SHA } },
    { ...record, record: { sha256: SHA, inline: "eA==", blob: {} } },
    { ...record, record: { sha256: SHA, inline: "eA==", access: "root" } },
    { ...observedBaseEntryToJSON(entries()[0]), seq: 0 },
    { ...observedBaseEntryToJSON(entries()[0]), names: [{ name: "" }] },
    {
      ...observedBaseEntryToJSON(entries()[0]),
      names: [{ name: "vpc", highWater: 1, removed: [[0, 1]] }],
    },
    { ...observedBaseEntryToJSON(entries()[6]), mark: -1 },
    { ...observedBaseEntryToJSON(entries()[6]), present: "yes" },
    { ...observedBaseEntryToJSON(entries()[5]), to: "" },
  ];
  for (const wire of cases) {
    assertThrows(
      () => observedBaseEntryFromJSON(wire, "ns"),
      Error,
      undefined,
      JSON.stringify(wire),
    );
  }
});
