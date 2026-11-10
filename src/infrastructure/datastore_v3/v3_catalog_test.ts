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
import { join } from "@std/path";
import { DataMetadataSchema } from "../../domain/data/data_metadata.ts";
import {
  metadata,
  MODEL_ID,
  MODEL_TYPE,
  modelPartition,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { catalogRow, V3Catalog } from "./v3_catalog.ts";

const RUN_ID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";

Deno.test("catalogRow: maps a workflow-step version field for field", () => {
  const metadata = DataMetadataSchema.parse({
    name: "vpc",
    id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    version: 3,
    contentType: "application/json",
    lifetime: "7d",
    garbageCollection: "30d",
    streaming: true,
    tags: { type: "resource", modelName: "net", specName: "main" },
    ownerDefinition: {
      ownerType: "workflow-step",
      ownerRef: "deploy",
      workflowRunId: RUN_ID,
      workflowName: "deploy",
      jobName: "build",
      stepName: "create",
      source: "cli",
    },
    createdAt: "2026-10-11T12:00:00Z",
    size: 42,
  });
  assertEquals(catalogRow("infra", "@swamp/aws-ec2", "m-1", metadata), {
    namespace: "infra",
    type_normalized: "@swamp/aws-ec2",
    model_id: "m-1",
    data_name: "vpc",
    id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    version: 3,
    is_latest: 1,
    is_step_latest: 1,
    model_name: "net",
    spec_name: "main",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "7d",
    garbage_collection: "30d",
    lifecycle: "active",
    owner_type: "workflow-step",
    streaming: 1,
    size: 42,
    // Normalised as v2 writes it: through Data and toISOString.
    created_at: "2026-10-11T12:00:00.000Z",
    tags: JSON.stringify({
      type: "resource",
      modelName: "net",
      specName: "main",
    }),
    owner_ref: "deploy",
    workflow_run_id: RUN_ID,
    workflow_name: "deploy",
    job_name: "build",
    step_name: "create",
    source: "cli",
  });
});

Deno.test("catalogRow: fills absent fields as v2 does", () => {
  const metadata = DataMetadataSchema.parse({
    name: "log",
    id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    version: 1,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "file" },
    ownerDefinition: { ownerType: "manual", ownerRef: "me" },
    createdAt: "2026-10-11T12:00:00.000Z",
  });
  const row = catalogRow("", "t", "m", metadata);
  assertEquals(
    [
      row.model_name,
      row.spec_name,
      row.streaming,
      row.size,
      row.garbage_collection,
      row.workflow_run_id,
      row.workflow_name,
      row.job_name,
      row.step_name,
      row.source,
    ],
    ["", "", 0, 0, "5", "", "", "", "", ""],
  );
});

Deno.test("catalogRow: a deletion marker's row carries lifecycle deleted (swamp-club#3706)", () => {
  const metadata = DataMetadataSchema.parse({
    name: "vpc",
    id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    version: 2,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "me" },
    createdAt: "2026-10-11T12:00:00.000Z",
    lifecycle: "deleted",
  });
  assertEquals(catalogRow("", "t", "m", metadata).lifecycle, "deleted");
});

Deno.test("V3Catalog: applying committed work, batched or not, never marks a name dirty nor hides a writer's dirty one, and a batch clears and forgets names in order (swamp-club#4581)", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-v3-catalog-" });
  try {
    const catalog = V3Catalog.open(join(dir, "_catalog_v3.db"));
    try {
      catalog.ensureDirtyTracking(1_000);
      const name = (n: string) => ({
        namespace: "",
        type: MODEL_TYPE.normalized,
        modelId: MODEL_ID,
        name: n,
      });
      const upsert = (n: string, version: number) => ({
        kind: "upsert-version" as const,
        metadata: DataMetadataSchema.parse(metadata(n, version)),
      });
      catalog.store.upsertNewVersion(
        catalogRow(
          "",
          MODEL_TYPE.normalized,
          MODEL_ID,
          DataMetadataSchema.parse(metadata("w", 9)),
        ),
      );
      catalog.apply("", modelPartition(), [upsert("a", 1), upsert("w", 1)]);
      catalog.beginBatch();
      catalog.apply("", modelPartition(), [upsert("b", 1)]);
      catalog.commitBatch();
      assertEquals(catalog.dirtyNames().map((n) => n.name), ["w"]);
      catalog.beginBatch();
      catalog.clearNames([name("w")], () => true);
      catalog.apply("", modelPartition(), [upsert("w", 1)]);
      catalog.forgetDirty([name("w")]);
      catalog.commitBatch();
      assertEquals(catalog.dirtyNames(), []);
      assertEquals(
        [...catalog.store.iterate()].map((r) => `${r.data_name}@${r.version}`)
          .sort(),
        ["a@1", "b@1", "w@1"],
      );
    } finally {
      catalog.close();
    }
  } finally {
    removeTempDir(dir);
  }
});

function removeTempDir(dir: string): void {
  try {
    Deno.removeSync(dir, { recursive: true });
  } catch (error) {
    // Windows refuses while V8 still holds the SQLite handle.
    if (Deno.build.os !== "windows") throw error;
  }
}
