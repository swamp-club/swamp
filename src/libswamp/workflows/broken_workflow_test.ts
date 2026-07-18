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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  findBrokenWorkflow,
  listBrokenWorkflows,
  workflowsDirFor,
} from "./broken_workflow.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native handles
      // yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const VALID_WORKFLOW = `
id: 550e8400-e29b-41d4-a716-446655440000
name: valid-workflow
jobs:
  - name: job1
    steps:
      - name: step1
        task:
          type: model_method
          modelIdOrName: my-model
          methodName: run
`;

const JOB_LABELS_WORKFLOW = `
id: 74ae52ba-5f3f-4937-a4fd-c1de950572e7
name: variant-a-job-labels
jobs:
  - name: placed
    labels:
      fb28: probe
    steps:
      - name: echo
        task:
          type: model_method
          modelIdOrName: fb28-probe
          methodName: execute
          inputs:
            run: echo "hello"
`;

Deno.test("workflowsDirFor: appends workflows to the repo dir", () => {
  assertEquals(workflowsDirFor("/repo"), join("/repo", "workflows"));
});

Deno.test("listBrokenWorkflows: returns empty for a missing directory", async () => {
  await withTempDir(async (dir) => {
    const broken = await listBrokenWorkflows(join(dir, "does-not-exist"));
    assertEquals(broken, []);
  });
});

Deno.test("listBrokenWorkflows: skips valid files and reports schema-rejected ones", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "workflow-550e8400-e29b-41d4-a716-446655440000.yaml"),
      VALID_WORKFLOW,
    );
    await Deno.writeTextFile(
      join(dir, "workflow-74ae52ba-5f3f-4937-a4fd-c1de950572e7.yaml"),
      JOB_LABELS_WORKFLOW,
    );
    // Files without the workflow- prefix are not loaded by the repository
    // and must not be scanned.
    await Deno.writeTextFile(join(dir, "notes.yaml"), "labels: nope");

    const broken = await listBrokenWorkflows(dir);
    assertEquals(broken.length, 1);
    assertEquals(broken[0].name, "variant-a-job-labels");
    assertEquals(broken[0].id, "74ae52ba-5f3f-4937-a4fd-c1de950572e7");
    assertStringIncludes(broken[0].error, "'labels' is a step property");
  });
});

Deno.test("listBrokenWorkflows: reports files with invalid YAML", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "workflow-bad.yaml"),
      "id: [unclosed",
    );
    const broken = await listBrokenWorkflows(dir);
    assertEquals(broken.length, 1);
    assertEquals(broken[0].name, null);
  });
});

Deno.test("findBrokenWorkflow: matches by raw name and by raw id", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "workflow-74ae52ba-5f3f-4937-a4fd-c1de950572e7.yaml"),
      JOB_LABELS_WORKFLOW,
    );

    const byName = await findBrokenWorkflow(dir, "variant-a-job-labels");
    assertEquals(byName?.name, "variant-a-job-labels");

    const byId = await findBrokenWorkflow(
      dir,
      "74ae52ba-5f3f-4937-a4fd-c1de950572e7",
    );
    assertEquals(byId?.id, "74ae52ba-5f3f-4937-a4fd-c1de950572e7");

    const miss = await findBrokenWorkflow(dir, "other-workflow");
    assertEquals(miss, null);
  });
});
