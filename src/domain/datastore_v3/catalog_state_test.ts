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
import { EMPTY_CATALOG_NAME, foldCatalogActions } from "./catalog_state.ts";
import { versionOp } from "./v3_test_helpers.ts";

function meta(name: string, version: number): DataMetadata {
  return versionOp(name, version).metadata;
}

Deno.test("foldCatalogActions: upserts and removes rows, kept in version order", () => {
  const result = foldCatalogActions([
    { kind: "upsert-version", metadata: meta("a", 3) },
    { kind: "upsert-version", metadata: meta("a", 1) },
    { kind: "upsert-version", metadata: meta("a", 2) },
    { kind: "remove-version", name: "a", version: 2 },
  ], () => EMPTY_CATALOG_NAME);
  assertEquals(result.get("a"), {
    rows: [meta("a", 1), meta("a", 3)],
    forward: undefined,
  });
});

Deno.test("foldCatalogActions: starts from the name's state and replaces a version's row", () => {
  const before = { rows: [meta("a", 1), meta("a", 2)], forward: undefined };
  const replaced = { ...meta("a", 1), size: 42 };
  const result = foldCatalogActions(
    [{ kind: "upsert-version", metadata: replaced }],
    (name) => name === "a" ? before : EMPTY_CATALOG_NAME,
  );
  assertEquals(result.get("a"), {
    rows: [replaced, meta("a", 2)],
    forward: undefined,
  });
});

Deno.test("foldCatalogActions: a rename removes the name's rows and forwards it; an end-forward clears it", () => {
  const result = foldCatalogActions(
    [
      { kind: "remove-name", name: "a" },
      { kind: "forward", name: "a", to: "b" },
      { kind: "upsert-version", metadata: meta("c", 1) },
      { kind: "forward", name: "c", to: "d" },
      { kind: "end-forward", name: "c" },
    ],
    (name) =>
      name === "a"
        ? { rows: [meta("a", 1), meta("a", 2)], forward: undefined }
        : EMPTY_CATALOG_NAME,
  );
  assertEquals(result.get("a"), { rows: [], forward: "b" });
  assertEquals(result.get("c"), { rows: [meta("c", 1)], forward: undefined });
});

Deno.test("foldCatalogActions: an upsert that becomes the latest row ends the name's forward, as the catalog store does", () => {
  const forwarded = { rows: [], forward: "b" };
  assertEquals(
    foldCatalogActions(
      [{ kind: "upsert-version", metadata: meta("a", 1) }],
      () => forwarded,
    ).get("a"),
    { rows: [meta("a", 1)], forward: undefined },
  );
  // Below a higher row it is not the latest, and the forward stays.
  assertEquals(
    foldCatalogActions(
      [{ kind: "upsert-version", metadata: meta("a", 1) }],
      () => ({ rows: [meta("a", 2)], forward: "b" }),
    ).get("a"),
    { rows: [meta("a", 1), meta("a", 2)], forward: "b" },
  );
});

Deno.test("foldCatalogActions: touches only the names its actions name", () => {
  assertEquals(foldCatalogActions([], () => EMPTY_CATALOG_NAME).size, 0);
});
