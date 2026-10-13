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

// Extension metadata reads a behavior-spelled workflow step as the
// model_method step it stands for (swamp-club#3334).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  extractContentMetadata,
  extractModelType,
} from "./extension_content_extractor.ts";

async function stepsOf(tasks: Record<string, unknown>[]) {
  const tmpDir = await Deno.makeTempDir();
  try {
    const wfFile = join(tmpDir, "workflow.yaml");
    await Deno.writeTextFile(
      wfFile,
      stringifyYaml({
        id: "abc-123",
        name: "spelled",
        jobs: [{
          name: "main",
          steps: tasks.map((task, i) => ({ name: `s${i}`, task })),
        }],
      }),
    );
    const result = await extractContentMetadata([], tmpDir, [
      { sourcePath: wfFile, archiveName: "workflow.yaml" },
    ]);
    return result.workflows[0].jobs[0].steps.map((s) => ({
      taskType: s.taskType,
      modelIdOrName: s.modelIdOrName,
      methodName: s.methodName,
    }));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("extractContentMetadata: a behavior-spelled step reads as its model_method step", async () => {
  const behavior = await stepsOf([
    { type: "behavior", behavior: "my-model", methodName: "execute" },
    {
      type: "behavior",
      behaviorType: "@acme/x",
      behaviorName: "x",
      methodName: "create",
    },
  ]);
  const model = await stepsOf([
    { type: "model_method", modelIdOrName: "my-model", methodName: "execute" },
    {
      type: "model_method",
      modelType: "@acme/x",
      modelName: "x",
      methodName: "create",
    },
  ]);
  assertEquals(behavior, model);
  assertEquals(behavior[0], {
    taskType: "model_method",
    modelIdOrName: "my-model",
    methodName: "execute",
  });
});

Deno.test("extractContentMetadata: a mixed-spelling step is read as written, best-effort", async () => {
  const steps = await stepsOf([
    {
      type: "behavior",
      behavior: "a",
      modelIdOrName: "b",
      methodName: "run",
    },
    "not a task" as unknown as Record<string, unknown>,
  ]);
  assertEquals(steps, [
    { taskType: "behavior", modelIdOrName: "b", methodName: "run" },
    { taskType: "", modelIdOrName: "", methodName: "" },
  ]);
});

Deno.test("extractModelType: a behavior object counts only when it declares methods", () => {
  assertEquals(
    extractModelType('export const behavior = { type: "retry" };\n'),
    null,
  );
  assertEquals(
    extractModelType(
      'export const behavior = { type: "@acme/x", methods: {} };\n',
    ),
    "@acme/x",
  );
});
