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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  acceptForeignExportRows,
  parseForeignNamespaces,
} from "./foreign_catalog_export.ts";
import type { CatalogExportRow } from "./datastore_sync_service.ts";
import {
  type Namespace,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../data/namespace.ts";
import { UserError } from "../errors.ts";

const OWN = restoreNamespace("team-a");

function makeExportRow(
  overrides: Partial<CatalogExportRow> = {},
): CatalogExportRow {
  return {
    namespace: "team-b",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "item",
    id: crypto.randomUUID(),
    version: 1,
    is_latest: 1,
    model_name: "m1",
    spec_name: "item",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
    ...overrides,
  };
}

Deno.test("parseForeignNamespaces: trims, drops empty values and removes duplicates", () => {
  assertEquals(
    parseForeignNamespaces([" infra", "security ", "", "  ", "infra"], OWN),
    ["infra", "security"] as Namespace[],
  );
});

Deno.test("parseForeignNamespaces: refuses the reader's own namespace", () => {
  const error = assertThrows(
    () => parseForeignNamespaces(["infra", " team-a "], OWN),
    UserError,
  );
  assertStringIncludes(error.message, '"team-a"');
  assertStringIncludes(error.message, "own namespace");
});

Deno.test("parseForeignNamespaces: refuses a value that is not a namespace, naming it", () => {
  for (
    const value of [
      "Infra",
      "infra/x",
      "..",
      "a/../team-a",
      "-x",
      "x".repeat(65),
    ]
  ) {
    const error = assertThrows(
      () => parseForeignNamespaces([value], OWN),
      UserError,
    );
    assertStringIncludes(error.message, JSON.stringify(value));
  }
});

Deno.test("parseForeignNamespaces: accepts a reserved name", () => {
  assertEquals(parseForeignNamespaces(["data"], OWN), ["data"] as Namespace[]);
});

Deno.test("parseForeignNamespaces: a solo reader accepts every well-formed namespace", () => {
  assertEquals(
    parseForeignNamespaces(["team-a", "team-b"], SOLO_NAMESPACE),
    ["team-a", "team-b"] as Namespace[],
  );
});

Deno.test("acceptForeignExportRows: keeps the rows of the pulled namespace", () => {
  const rows = [
    makeExportRow({ version: 1 }),
    makeExportRow({ version: 2 }),
  ];
  assertEquals(acceptForeignExportRows(restoreNamespace("team-b"), rows), {
    rows,
    rejected: 0,
  });
});

Deno.test("acceptForeignExportRows: drops rows claiming the reader's, the solo or a third namespace", () => {
  const honest = makeExportRow({ data_name: "honest" });
  const result = acceptForeignExportRows(restoreNamespace("team-b"), [
    makeExportRow({ namespace: "team-a", data_name: "forged-own" }),
    honest,
    makeExportRow({ namespace: "", data_name: "forged-solo" }),
    makeExportRow({ namespace: "team-c", data_name: "forged-third" }),
  ]);
  assertEquals(result, { rows: [honest], rejected: 3 });
});
