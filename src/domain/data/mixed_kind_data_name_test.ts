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
import {
  type DataVersionKindRow,
  findMixedKindNames,
} from "./mixed_kind_data_name.ts";

function row(
  dataName: string,
  version: number,
  dataType: string,
  lifecycle = "active",
): DataVersionKindRow {
  return {
    modelType: "t/m",
    modelId: "m-1",
    modelName: "fwd",
    dataName,
    version,
    dataType,
    recordKind: "",
    specName: dataType === "file" ? "blob" : "meta",
    lifecycle,
  };
}

Deno.test("findMixedKindNames: reports a name whose versions hold a file and a resource", () => {
  assertEquals(
    findMixedKindNames([row("x", 1, "file"), row("x", 2, "resource")]),
    [{
      modelType: "t/m",
      modelId: "m-1",
      modelName: "fwd",
      dataName: "x",
      versions: [
        { version: 1, kind: "file", specName: "blob" },
        { version: 2, kind: "resource", specName: "meta" },
      ],
    }],
  );
});

Deno.test("findMixedKindNames: a single kind, or a kind change after a delete marker, is clean", () => {
  assertEquals(
    findMixedKindNames([
      row("a", 1, "resource"),
      row("a", 2, "resource"),
      row("b", 1, "file"),
      row("b", 2, "file", "deleted"),
      row("b", 3, "resource"),
    ]),
    [],
  );
});

Deno.test("findMixedKindNames: a type tag naming no kind is skipped", () => {
  assertEquals(
    findMixedKindNames([row("s", 1, "agent-session"), row("s", 2, "file")]),
    [],
  );
});

Deno.test("findMixedKindNames: reports only the mixed history of a name, and each mixed name once", () => {
  const found = findMixedKindNames([
    row("x", 1, "file"),
    row("x", 2, "resource"),
    row("x", 3, "resource", "deleted"),
    row("x", 4, "file"),
    row("y", 1, "resource"),
    row("y", 2, "file"),
  ]);
  assertEquals(found.map((f) => f.dataName), ["x", "y"]);
  assertEquals(found[0].versions.map((v) => v.version), [1, 2]);
});

Deno.test("findMixedKindNames: the stamped kind wins over an overridden type tag", () => {
  assertEquals(
    findMixedKindNames([
      { ...row("s", 1, "agent-session"), recordKind: "resource" },
      { ...row("s", 2, "agent-session"), recordKind: "file" },
    ]).map((f) => f.versions.map((v) => v.kind)),
    [["resource", "file"]],
  );
});
