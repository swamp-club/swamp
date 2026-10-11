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

import { assertEquals } from "@std/assert";
import type { DataMetadata } from "../data/data_metadata.ts";
import { type LiveDataVersion, projectCatalog } from "./catalog_projection.ts";
import { dataVersionOp, leaseOp, tombstoneOp } from "./op.ts";
import { RecordKey } from "./record_key.ts";
import {
  dataKey,
  metadata,
  modelIntent,
  savePut,
  versionOp,
} from "./v3_test_helpers.ts";

function live(name: string, version: number): LiveDataVersion {
  return { version, metadata: versionOp(name, version).metadata };
}

function markerMetadata(name: string, version: number, to: string) {
  return {
    ...(metadata(name, version) as Record<string, unknown>),
    lifecycle: "deleted",
    renamedTo: to,
  };
}

function marker(name: string, version: number, to: string) {
  return dataVersionOp({
    key: RecordKey.create(`data/m/${name}/${version}/metadata.yaml`),
    metadata: markerMetadata(name, version, to),
  });
}

function liveMarker(name: string, version: number, to: string) {
  return { version, metadata: marker(name, version, to).metadata };
}

function deleteOp(name: string, version?: number) {
  return tombstoneOp({
    intent: modelIntent(
      version === undefined
        ? { kind: "data.delete", name }
        : { kind: "data.delete", name, version },
    ),
    key: version === undefined
      ? RecordKey.create(`data/m/${name}/latest`)
      : dataKey(name, version),
  });
}

function gcOp(name: string, version?: number) {
  return tombstoneOp({
    intent: modelIntent(
      version === undefined
        ? { kind: "data.gc", name }
        : { kind: "data.gc", name, version },
    ),
    key: version === undefined
      ? RecordKey.create(`data/m/${name}/latest`)
      : dataKey(name, version),
  });
}

const none = () => [];

function versions(
  map: ReadonlyMap<string, readonly LiveDataVersion[]>,
): Record<string, number[]> {
  return Object.fromEntries(
    [...map].map(([name, list]) => [name, list.map((v) => v.version)]),
  );
}

function meta(version: number, name = "a"): DataMetadata {
  return versionOp(name, version).metadata;
}

Deno.test("projectCatalog: a save upserts its version's row", async () => {
  const projection = projectCatalog(
    [await savePut("a", 1), versionOp("a", 1)],
    none,
  );
  assertEquals(projection.actions, [
    { kind: "upsert-version", metadata: meta(1) },
  ]);
  assertEquals(versions(projection.live), { a: [1] });
});

Deno.test("projectCatalog: a versioned delete upserts the new latest, as v2 delete(version) does", () => {
  const projection = projectCatalog(
    [deleteOp("a", 3)],
    () => [live("a", 1), live("a", 2), live("a", 3)],
  );
  assertEquals(projection.actions, [
    { kind: "remove-version", name: "a", version: 3 },
    { kind: "upsert-version", metadata: meta(2) },
  ]);
  assertEquals(versions(projection.live), { a: [1, 2] });
});

Deno.test("projectCatalog: deleting every version removes the name and its forward", () => {
  const projection = projectCatalog(
    [deleteOp("a", 1), deleteOp("a", 2), deleteOp("a")],
    () => [live("a", 1), live("a", 2)],
  );
  assertEquals(projection.actions, [
    { kind: "remove-version", name: "a", version: 1 },
    { kind: "remove-version", name: "a", version: 2 },
    { kind: "remove-name", name: "a" },
    { kind: "end-forward", name: "a" },
  ]);
  assertEquals(versions(projection.live), { a: [] });
});

Deno.test("projectCatalog: a rename marker removes the old name and forwards it", async () => {
  const projection = projectCatalog(
    [
      await savePut("b", 1),
      versionOp("b", 1),
      marker("a", 3, "b"),
    ],
    (name) => name === "a" ? [live("a", 1), live("a", 2)] : [],
  );
  assertEquals(projection.actions, [
    { kind: "upsert-version", metadata: meta(1, "b") },
    { kind: "remove-name", name: "a" },
    { kind: "forward", name: "a", to: "b" },
  ]);
  assertEquals(versions(projection.live), { b: [1], a: [1, 2, 3] });
});

Deno.test("projectCatalog: a delete that leaves a rename marker on top keeps the name forwarded", () => {
  const projection = projectCatalog(
    [deleteOp("a", 4)],
    () => [live("a", 1), liveMarker("a", 2, "b"), live("a", 4)],
  );
  assertEquals(projection.actions, [
    { kind: "remove-version", name: "a", version: 4 },
    { kind: "remove-name", name: "a" },
    { kind: "forward", name: "a", to: "b" },
  ]);
});

Deno.test("projectCatalog: a delete that exposes a pre-rename version restores its row", () => {
  // a@1 saved, renamed (marker a@2), a@3 saved, then a@3 and the marker
  // deleted: v2 re-upserts a@1, the row the rename removed.
  const projection = projectCatalog(
    [deleteOp("a", 3), deleteOp("a", 2)],
    () => [live("a", 1), liveMarker("a", 2, "b"), live("a", 3)],
  );
  assertEquals(projection.actions, [
    { kind: "remove-version", name: "a", version: 3 },
    { kind: "remove-version", name: "a", version: 2 },
    { kind: "upsert-version", metadata: meta(1) },
  ]);
});

Deno.test("projectCatalog: gc removes old versions and upserts the latest", () => {
  const projection = projectCatalog(
    [gcOp("a", 1), gcOp("a", 2)],
    () => [live("a", 1), live("a", 2), live("a", 3)],
  );
  assertEquals(projection.actions, [
    { kind: "remove-version", name: "a", version: 1 },
    { kind: "remove-version", name: "a", version: 2 },
    { kind: "upsert-version", metadata: meta(3) },
  ]);
});

Deno.test("projectCatalog: a version-less gc expires the name; its versions stay live", () => {
  const projection = projectCatalog([gcOp("a")], () => [live("a", 1)]);
  assertEquals(projection.actions, [
    { kind: "remove-name", name: "a" },
    { kind: "end-forward", name: "a" },
  ]);
  assertEquals(versions(projection.live), {});
});

Deno.test("projectCatalog: a version-less delete alone changes nothing", () => {
  const projection = projectCatalog([deleteOp("a")], () => [live("a", 1)]);
  assertEquals(projection.actions, []);
  assertEquals(versions(projection.live), {});
});

Deno.test("projectCatalog: a lease and a plain put change nothing", async () => {
  const projection = projectCatalog(
    [leaseOp({ holder: "serve", fence: 1 }), await savePut("a", 1)],
    none,
  );
  assertEquals(projection.actions, []);
  assertEquals(projection.live.size, 0);
});

Deno.test("projectCatalog: an expiry after a versioned gc in one commit stays expired", () => {
  const projection = projectCatalog(
    [gcOp("a", 1), gcOp("a")],
    () => [live("a", 1), live("a", 2)],
  );
  assertEquals(projection.actions, [
    { kind: "remove-version", name: "a", version: 1 },
    { kind: "remove-name", name: "a" },
    { kind: "end-forward", name: "a" },
  ]);
});

Deno.test("projectCatalog: a versioned delete after an expiry in one commit upserts the latest, as v2 does", () => {
  const projection = projectCatalog(
    [gcOp("a"), deleteOp("a", 1)],
    () => [live("a", 1), live("a", 2)],
  );
  assertEquals(projection.actions, [
    { kind: "remove-name", name: "a" },
    { kind: "end-forward", name: "a" },
    { kind: "remove-version", name: "a", version: 1 },
    { kind: "upsert-version", metadata: meta(2) },
  ]);
});
