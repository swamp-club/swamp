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
  findMisnamedWorkflow,
  listBrokenWorkflows,
  workflowNotLoadedMessage,
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

const BROKEN_UNKNOWN_KEY_WORKFLOW = `
id: 74ae52ba-5f3f-4937-a4fd-c1de950572e7
name: broken-unknown-key
jobs:
  - name: placed
    environmnet: prod
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
      BROKEN_UNKNOWN_KEY_WORKFLOW,
    );
    // Files without the workflow- prefix are not loaded by the repository
    // and must not be scanned.
    await Deno.writeTextFile(join(dir, "notes.yaml"), "labels: nope");

    const broken = await listBrokenWorkflows(dir);
    assertEquals(broken.length, 1);
    assertEquals(broken[0].name, "broken-unknown-key");
    assertEquals(broken[0].id, "74ae52ba-5f3f-4937-a4fd-c1de950572e7");
    assertStringIncludes(broken[0].error, "Unknown key 'environmnet'");
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
      BROKEN_UNKNOWN_KEY_WORKFLOW,
    );

    const byName = await findBrokenWorkflow(dir, "broken-unknown-key");
    assertEquals(byName?.name, "broken-unknown-key");

    const byId = await findBrokenWorkflow(
      dir,
      "74ae52ba-5f3f-4937-a4fd-c1de950572e7",
    );
    assertEquals(byId?.id, "74ae52ba-5f3f-4937-a4fd-c1de950572e7");

    const miss = await findBrokenWorkflow(dir, "other-workflow");
    assertEquals(miss, null);
  });
});

const BROKEN_TYPES_WORKFLOW = `
id: 4ca56ef7-e5f4-4462-b110-289af8294d4f
name: broken-types
jobs:
  - name: main
    weight: heavy
    steps:
      - name: example
        allowFailure: maybe
        task:
          type: model_method
          modelIdOrName: example-model
          methodName: run
`;

Deno.test("listBrokenWorkflows: reports a schema failure as one readable line", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "workflow-broken-types.yaml"),
      BROKEN_TYPES_WORKFLOW,
    );

    const broken = await listBrokenWorkflows(dir);
    assertEquals(broken.length, 1);
    assertEquals(
      broken[0].error,
      "jobs[0].steps[0].allowFailure: Invalid input: expected boolean, received string; " +
        "jobs[0].weight: Invalid input: expected number, received string",
    );
  });
});

// A well-formed file whose name the loader skips explains a not-found
// lookup (swamp-club#3839).

Deno.test("findMisnamedWorkflow: matches a misnamed file by raw name and by raw id", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "plain.yaml"), VALID_WORKFLOW);

    const byName = await findMisnamedWorkflow(dir, "valid-workflow");
    assertEquals(byName?.file, join(dir, "plain.yaml"));
    assertEquals(byName?.name, "valid-workflow");

    const byId = await findMisnamedWorkflow(
      dir,
      "550e8400-e29b-41d4-a716-446655440000",
    );
    assertEquals(byId?.id, "550e8400-e29b-41d4-a716-446655440000");

    assertEquals(await findMisnamedWorkflow(dir, "other-workflow"), null);
  });
});

Deno.test("findMisnamedWorkflow: names the file by base name only", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "plain.yml"), VALID_WORKFLOW);

    const misnamed = await findMisnamedWorkflow(dir, "valid-workflow");
    assertEquals(
      misnamed?.message,
      "Not loaded: swamp only reads files named workflow-<name>.yaml in " +
        "the workflows directory. Rename plain.yml to workflow-<name>.yaml, " +
        "or remove it if it is a stale copy of a workflow that already loads.",
    );
    assertEquals(misnamed?.message.includes(dir), false);
  });
});

Deno.test("findMisnamedWorkflow: a matching file that is not a workflow is told to move", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "notes.yaml"), "name: notes\n");

    const misnamed = await findMisnamedWorkflow(dir, "notes");
    assertStringIncludes(
      misnamed?.message ?? "",
      "notes.yaml is not a workflow; move it out of that directory",
    );
  });
});

Deno.test("findMisnamedWorkflow: ignores workflow-*.yaml files and unparseable YAML", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "workflow-74ae52ba-5f3f-4937-a4fd-c1de950572e7.yaml"),
      BROKEN_UNKNOWN_KEY_WORKFLOW,
    );
    await Deno.writeTextFile(join(dir, "bad.yaml"), "id: [unclosed");

    assertEquals(await findMisnamedWorkflow(dir, "broken-unknown-key"), null);
    assertEquals(await findMisnamedWorkflow(dir, "[unclosed"), null);
  });
});

Deno.test("findMisnamedWorkflow: picks the first match by file name", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "b.yaml"), VALID_WORKFLOW);
    await Deno.writeTextFile(join(dir, "a.yaml"), VALID_WORKFLOW);

    const misnamed = await findMisnamedWorkflow(dir, "valid-workflow");
    assertEquals(misnamed?.file, join(dir, "a.yaml"));
  });
});

Deno.test("findMisnamedWorkflow: returns null for a missing directory", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await findMisnamedWorkflow(join(dir, "does-not-exist"), "plain"),
      null,
    );
  });
});

Deno.test("workflowNotLoadedMessage: names the file and directory as given", () => {
  assertEquals(
    workflowNotLoadedMessage("/r/workflows/x.yaml", "/r/workflows", {
      jobs: [],
    }),
    "Not loaded: swamp only reads files named workflow-<name>.yaml in " +
      "/r/workflows. Rename /r/workflows/x.yaml to workflow-<name>.yaml, " +
      "or remove it if it is a stale copy of a workflow that already loads.",
  );
});
