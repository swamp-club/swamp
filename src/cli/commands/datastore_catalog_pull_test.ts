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
import { exportRowsToCatalogRows } from "./datastore_catalog_pull.ts";
import type { CatalogExportRow } from "../../domain/datastore/datastore_sync_service.ts";

function makeExportRow(
  overrides: Partial<CatalogExportRow> = {},
): CatalogExportRow {
  return {
    namespace: "infra",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "item-b",
    id: crypto.randomUUID(),
    version: 1,
    is_latest: 1,
    model_name: "c1",
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

function flags(
  rows: { version: number; is_latest: number; is_step_latest: number }[],
): string[] {
  return rows.map((r) => `${r.version}:${r.is_latest}:${r.is_step_latest}`);
}

Deno.test("exportRowsToCatalogRows: normalises a legacy export with one latest per step", () => {
  // Written before swamp-club#2520: no is_step_latest, and two workflow
  // steps' versions of one data name both flagged is_latest.
  const rows = exportRowsToCatalogRows([
    makeExportRow({ version: 1, step_name: "s1" }),
    makeExportRow({ version: 2, step_name: "s2" }),
  ]);
  assertEquals(flags(rows), ["1:0:1", "2:1:1"]);
});

Deno.test("exportRowsToCatalogRows: keeps step latests from a current export", () => {
  const rows = exportRowsToCatalogRows([
    makeExportRow({
      version: 1,
      step_name: "s1",
      is_latest: 0,
      is_step_latest: 1,
    }),
    makeExportRow({
      version: 2,
      step_name: "s2",
      is_latest: 1,
      is_step_latest: 1,
    }),
  ]);
  assertEquals(flags(rows), ["1:0:1", "2:1:1"]);
});

Deno.test("exportRowsToCatalogRows: leaves rows the export did not flag unflagged", () => {
  const rows = exportRowsToCatalogRows([
    makeExportRow({ version: 1, is_latest: 1 }),
    makeExportRow({ version: 2, is_latest: 0, is_step_latest: 0 }),
  ]);
  assertEquals(flags(rows), ["1:1:1", "2:0:0"]);
});

Deno.test("exportRowsToCatalogRows: carries garbage_collection from the export", () => {
  const [row] = exportRowsToCatalogRows([
    makeExportRow({ garbage_collection: "7d" }),
  ]);
  assertEquals(row.garbage_collection, "7d");
});

Deno.test("exportRowsToCatalogRows: an export without garbage_collection reads as unknown", () => {
  const [row] = exportRowsToCatalogRows([makeExportRow()]);
  assertEquals(row.garbage_collection, "");
});
