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
import { Data } from "../../domain/data/data.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { sha256Hex, v3RunArtifactCheck } from "./run_artifact_check.ts";

const CONTENT = new TextEncoder().encode('{"value":1}');

function resolver(engine: "v2" | "v3"): DatastorePathResolver {
  return { engine: () => engine } as unknown as DatastorePathResolver;
}

function fixture() {
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    workflowName: "wf",
    status: "succeeded",
    startedAt: "2026-10-12T10:00:00.000Z",
    completedAt: "2026-10-12T10:05:00.000Z",
    jobs: [],
    tags: {},
  });
  const data = Data.create({
    name: "result",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: "x",
      workflowRunId: run.id,
    },
  });
  const owner = { modelType: ModelType.create("test/check"), modelId: "m" };
  return { run, data, owner };
}

Deno.test("v3RunArtifactCheck: a v2 datastore takes no check", () => {
  assertEquals(
    v3RunArtifactCheck(resolver("v2"), {
      getContent: () => Promise.resolve(CONTENT),
    }),
    undefined,
  );
});

Deno.test("v3RunArtifactCheck: a ref's sha256 decides on v3", async () => {
  const { run, data, owner } = fixture();
  const check = v3RunArtifactCheck(resolver("v3"), {
    getContent: () => Promise.resolve(CONTENT),
  })!;
  const ref = {
    dataId: data.id,
    name: data.name,
    version: data.version,
    tags: {},
  };
  assertEquals(
    await check({ ...ref, sha256: await sha256Hex(CONTENT) }, data, owner, run),
    true,
  );
  assertEquals(
    await check({ ...ref, sha256: "0".repeat(64) }, data, owner, run),
    false,
  );
  // Without a sha256 the version's run decides: this run wrote it.
  assertEquals(await check(ref, data, owner, run), true);
});

Deno.test("v3RunArtifactCheck: missing content is not available", async () => {
  const { run, data, owner } = fixture();
  const check = v3RunArtifactCheck(resolver("v3"), {
    getContent: () => Promise.resolve(null),
  })!;
  assertEquals(
    await check(
      { dataId: data.id, name: data.name, version: data.version, tags: {} },
      data,
      owner,
      run,
    ),
    false,
  );
});
