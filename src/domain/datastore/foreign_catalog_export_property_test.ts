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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { acceptForeignExportRows } from "./foreign_catalog_export.ts";
import type { CatalogExportRow } from "./datastore_sync_service.ts";
import { restoreNamespace } from "../data/namespace.ts";

const PULLED = restoreNamespace("team-b");

/** A row whose namespace field is anything an export could carry. */
const arbRow: fc.Arbitrary<CatalogExportRow> = fc.record({
  namespace: fc.oneof(
    fc.constantFrom("team-b", "team-a", "", "team-c", "TEAM-B", " team-b"),
    fc.string(),
  ),
  type_normalized: fc.constant("test-model"),
  model_id: fc.constant("model-001"),
  data_name: fc.constantFrom("a", "b", "c"),
  id: fc.uuid(),
  version: fc.integer({ min: 1, max: 5 }),
  is_latest: fc.constantFrom(0, 1),
  model_name: fc.constant("m1"),
  spec_name: fc.constant("item"),
  data_type: fc.constant("resource"),
  content_type: fc.constant("application/json"),
  lifetime: fc.constant("infinite"),
  owner_type: fc.constant("model-method"),
  streaming: fc.constant(0),
  size: fc.constant(0),
  created_at: fc.constant("2026-01-01T00:00:00.000Z"),
  tags: fc.constant("{}"),
  owner_ref: fc.constant(""),
  workflow_run_id: fc.constant(""),
  workflow_name: fc.constant(""),
  job_name: fc.constant(""),
  step_name: fc.constant(""),
  source: fc.constant(""),
});

Deno.test("acceptForeignExportRows property: every accepted row belongs to the pulled namespace", () => {
  fc.assert(
    fc.property(fc.array(arbRow, { maxLength: 30 }), (rows) => {
      const { rows: accepted } = acceptForeignExportRows(PULLED, rows);
      assert(accepted.every((row) => row.namespace === PULLED));
    }),
  );
});

Deno.test("acceptForeignExportRows property: accepted and rejected rows account for every input row", () => {
  fc.assert(
    fc.property(fc.array(arbRow, { maxLength: 30 }), (rows) => {
      const { rows: accepted, rejected } = acceptForeignExportRows(
        PULLED,
        rows,
      );
      assertEquals(accepted.length + rejected, rows.length);
    }),
  );
});

Deno.test("acceptForeignExportRows property: an export of only the pulled namespace's rows is kept whole, in order", () => {
  fc.assert(
    fc.property(fc.array(arbRow, { maxLength: 30 }), (generated) => {
      const rows = generated.map((row) => ({ ...row, namespace: PULLED }));
      assertEquals(acceptForeignExportRows(PULLED, rows), {
        rows,
        rejected: 0,
      });
    }),
  );
});
