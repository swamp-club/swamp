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
 * differential test: reconciling names must leave every row and forward that
 * clearing them and applying the same writes leaves, including flags on rows
 * the clear keeps and names it never touches
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { computeLatestFlags } from "../../domain/data/data_query_service.ts";
import {
  type CatalogDataName,
  type CatalogRow,
  CatalogStore,
  type CatalogWriter,
} from "./catalog_store.ts";

const NAMES = ["one", "two", "other"] as const;
const STEPS = ["", "a", "b"] as const;

function rowOf(
  dataName: string,
  version: number,
  stepName: string,
  pending: boolean,
): CatalogRow {
  return {
    namespace: "",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: dataName,
    id: `id-${dataName}-${version}-${stepName}`,
    version,
    is_latest: 0,
    is_step_latest: 0,
    model_name: "m",
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    garbage_collection: "10",
    lifecycle: "active",
    owner_type: stepName === "" ? "model-method" : "workflow-step",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: stepName,
    source: "",
    streaming: 0,
    size: version,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    is_pending: pending ? 1 : 0,
    pending_pid: pending ? 42 : 0,
    pending_host: pending ? "h" : "",
  };
}

type Write =
  | { kind: "upsert"; name: number; version: number; step: number }
  | { kind: "remove-version"; name: number; version: number }
  | { kind: "remove"; name: number }
  | { kind: "forward"; name: number; to: number }
  | { kind: "end-forward"; name: number };

const nameIndex = fc.integer({ min: 0, max: NAMES.length - 1 });
const touchedIndex = fc.integer({ min: 0, max: 1 });
const version = fc.integer({ min: 1, max: 12 });
const step = fc.integer({ min: 0, max: STEPS.length - 1 });

function writeOf(name: fc.Arbitrary<number>): fc.Arbitrary<Write> {
  return fc.oneof(
    fc.record({ kind: fc.constant("upsert" as const), name, version, step }),
    fc.record({
      kind: fc.constant("remove-version" as const),
      name,
      version,
    }),
    fc.record({ kind: fc.constant("remove" as const), name }),
    fc.record({
      kind: fc.constant("forward" as const),
      name,
      to: nameIndex,
    }),
    fc.record({ kind: fc.constant("end-forward" as const), name }),
  );
}

function apply(writer: CatalogWriter, write: Write): void {
  const name = NAMES[write.name];
  switch (write.kind) {
    case "upsert":
      writer.upsertNewVersion(
        rowOf(name, write.version, STEPS[write.step], false),
      );
      break;
    case "remove-version":
      writer.removeVersion(
        "",
        "test-model",
        "model-001",
        name,
        write.version,
        computeLatestFlags,
      );
      break;
    case "remove":
      writer.remove("", "test-model", "model-001", name);
      break;
    case "forward":
      writer.recordRename({
        namespace: "",
        type_normalized: "test-model",
        model_id: "model-001",
        data_name: name,
        renamed_to: NAMES[write.to],
      });
      break;
    case "end-forward":
      writer.removeRename("", "test-model", "model-001", name);
      break;
  }
}

function dump(store: CatalogStore): unknown {
  const db = (store as unknown as { db: DatabaseSync }).db;
  return {
    rows: db.prepare(
      "SELECT * FROM catalog ORDER BY data_name, version",
    ).all().map((row) => ({ ...row })),
    renames: db.prepare(
      "SELECT * FROM catalog_renames ORDER BY data_name",
    ).all().map((row) => ({ ...row })),
  };
}

const TOUCHED: CatalogDataName[] = [NAMES[0], NAMES[1]].map((data_name) => ({
  namespace: "",
  type_normalized: "test-model",
  model_id: "model-001",
  data_name,
}));

Deno.test("CatalogStore.reconcileNames: leaves exactly what clearing the names and applying the same writes leaves", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-catalog-reconcile-" });
  try {
    fc.assert(
      fc.property(
        fc.array(writeOf(nameIndex), { maxLength: 25 }),
        fc.array(fc.integer({ min: 1, max: 12 }), { maxLength: 6 }),
        fc.array(writeOf(touchedIndex), { maxLength: 25 }),
        fc.boolean(),
        (seed, kept, writes, pendingSeed) => {
          const id = crypto.randomUUID();
          const cleared = new CatalogStore(join(dir, `${id}-cleared.db`));
          const reconciled = new CatalogStore(
            join(dir, `${id}-reconciled.db`),
          );
          try {
            for (const store of [cleared, reconciled]) {
              store.applyInTransaction((writer) => {
                for (const write of seed) apply(writer, write);
                if (pendingSeed) {
                  writer.upsertNewVersion(rowOf(NAMES[0], 13, "a", true));
                }
              });
            }
            const keeps = new Set(kept);
            const clears = (row: { version?: number }) =>
              row.version === undefined || !keeps.has(row.version);
            cleared.applyInTransaction((writer) => {
              writer.clearNames(TOUCHED, clears);
              for (const write of writes) apply(writer, write);
            }, { committed: true });
            reconciled.applyInTransaction((writer) => {
              writer.reconcileNames(TOUCHED, clears, (scratch) => {
                for (const write of writes) apply(scratch, write);
              });
            }, { committed: true });
            assertEquals(dump(reconciled), dump(cleared));
          } finally {
            cleared.close();
            reconciled.close();
          }
        },
      ),
      { numRuns: 300 },
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
