// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { YamlEvaluatedWorkflowRepository } from "./yaml_evaluated_workflow_repository.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";

Deno.test("findByName returns workflow with matching name", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const repo = new YamlEvaluatedWorkflowRepository(tempDir);

    const workflow = Workflow.fromData({
      id: "a1b2c3d4-e5f6-1a2b-9c3d-4e5f6a7b8c9d",
      name: "test-workflow",
      inputs: undefined,
      version: 1,
      jobs: [
        {
          name: "test-job",
          dependsOn: [],
          weight: 0,
          steps: [
            {
              name: "test-step",
              dependsOn: [],
              weight: 0,
              task: {
                type: "model_method",
                modelIdOrName: "test-model",
                methodName: "run",
              },
            },
          ],
        },
      ],
    });
    await repo.save(workflow);

    const found = await repo.findByName("test-workflow");
    assertEquals(found?.name, "test-workflow");
    assertEquals(found?.id, "a1b2c3d4-e5f6-1a2b-9c3d-4e5f6a7b8c9d");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findByName returns null for non-existent workflow", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const repo = new YamlEvaluatedWorkflowRepository(tempDir);
    const found = await repo.findByName("non-existent");
    assertEquals(found, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
