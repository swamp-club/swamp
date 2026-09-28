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
import { YamlEvaluatedWorkflowRepository } from "./yaml_evaluated_workflow_repository.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";

Deno.test("findByName returns workflow with matching name", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const repo = new YamlEvaluatedWorkflowRepository(tempDir);

    const workflow = Workflow.fromData({
      id: "a1b2c3d4-e5f6-1a2b-9c3d-4e5f6a7b8c9d",
      name: "test-workflow",
      tags: {},
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

function provenanceWorkflow(): Workflow {
  return Workflow.fromData({
    id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
    name: "provenance-workflow",
    tags: {},
    inputs: undefined,
    version: 1,
    jobs: [
      {
        name: "main",
        dependsOn: [],
        weight: 0,
        steps: [
          {
            name: "step",
            dependsOn: [],
            weight: 0,
            task: {
              type: "model_method",
              modelIdOrName: "test-model",
              methodName: "run",
              inputs: { value: "${{ env.HOME }}" },
            },
          },
        ],
      },
    ],
  });
}

Deno.test("YamlEvaluatedWorkflowRepository: persists provenance and every reader still loads the cache", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workflow = provenanceWorkflow();
    const authoredExpressions = new Set(["${{ env.HOME }}"]);
    await new YamlEvaluatedWorkflowRepository(tempDir).save(
      workflow,
      authoredExpressions,
    );

    // Fresh instances: provenance must come from disk, not memory.
    const repo = new YamlEvaluatedWorkflowRepository(tempDir);
    const cached = await repo.findByNameWithProvenance(workflow.name);
    assertEquals(cached?.authoredExpressions, authoredExpressions);
    assertEquals(cached?.workflow.toData(), workflow.toData());
    assertEquals(
      (await repo.findByName(workflow.name))?.toData(),
      workflow.toData(),
    );
    assertEquals(
      (await new YamlEvaluatedWorkflowRepository(tempDir).findById(
        workflow.id,
      ))?.toData(),
      workflow.toData(),
    );
    assertEquals(
      (await new YamlEvaluatedWorkflowRepository(tempDir).findAll()).map((w) =>
        w.name
      ),
      [workflow.name],
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("YamlEvaluatedWorkflowRepository: a cache saved without provenance yields an empty set", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workflow = provenanceWorkflow();
    const repo = new YamlEvaluatedWorkflowRepository(tempDir);
    await repo.save(workflow, new Set(["${{ env.OLD }}"]));
    await repo.save(workflow);
    const cached = await new YamlEvaluatedWorkflowRepository(tempDir)
      .findByNameWithProvenance(workflow.name);
    assertEquals(cached?.authoredExpressions, new Set());
    assertEquals(cached?.deferredExpressions, []);
    assertEquals(cached?.workflow.name, workflow.name);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("YamlEvaluatedWorkflowRepository: clear calls markDirty with directory path", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new YamlEvaluatedWorkflowRepository(
      tempDir,
      undefined,
      markDirty,
    );

    const workflow = Workflow.fromData({
      id: "a1b2c3d4-e5f6-1a2b-9c3d-4e5f6a7b8c9d",
      name: "dirty-test",
      tags: {},
      inputs: undefined,
      version: 1,
      jobs: [{
        name: "j",
        dependsOn: [],
        weight: 0,
        steps: [{
          name: "s",
          dependsOn: [],
          weight: 0,
          task: { type: "model_method", modelIdOrName: "m", methodName: "run" },
        }],
      }],
    });

    await repo.save(workflow);
    assertEquals(calls.length, 1);

    await repo.clear();
    assertEquals(calls.length, 2);
    assertEquals(
      calls[1],
      join(tempDir, ".swamp", "workflows-evaluated"),
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("YamlEvaluatedWorkflowRepository: listRunSnapshots returns an empty list when no run has a snapshot", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const repo = new YamlEvaluatedWorkflowRepository(tempDir);
    assertEquals(await repo.listRunSnapshots(), []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("YamlEvaluatedWorkflowRepository: listRunSnapshots lists run snapshots and skips files and dot-prefixed entries", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const repo = new YamlEvaluatedWorkflowRepository(tempDir);
    const runId = crypto.randomUUID();
    await repo.saveForRun(runId, provenanceWorkflow());

    const runsDir = join(tempDir, ".swamp", "workflows-evaluated", "runs");
    await Deno.writeTextFile(join(runsDir, "stray.yaml"), "x");
    await Deno.mkdir(join(runsDir, ".tmp-entry"));
    const emptyRunId = crypto.randomUUID();
    await Deno.mkdir(join(runsDir, emptyRunId));
    const old = new Date("2020-01-01T00:00:00Z");
    await Deno.utime(
      join(runsDir, runId, "evaluated-workflow.yaml"),
      old,
      old,
    );

    const snapshots = await repo.listRunSnapshots();
    const byId = new Map(snapshots.map((s) => [s.runId, s]));
    assertEquals([...byId.keys()].sort(), [runId, emptyRunId].sort());
    assertEquals(byId.get(runId)?.modifiedAt.getTime(), old.getTime());
    assertEquals((byId.get(runId)?.sizeBytes ?? 0) > 0, true);
    assertEquals(byId.get(emptyRunId)?.sizeBytes, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("YamlEvaluatedWorkflowRepository: deleteForRun marks the run directory dirty before removing it", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const calls: Array<string | undefined> = [];
    let existedWhenMarked = false;
    const runId = crypto.randomUUID();
    const runDir = join(
      tempDir,
      ".swamp",
      "workflows-evaluated",
      "runs",
      runId,
    );
    const markDirty = async (relPath?: string) => {
      calls.push(relPath);
      if (relPath === runDir) {
        existedWhenMarked = await Deno.stat(runDir).then(
          () => true,
          () => false,
        );
      }
    };
    const repo = new YamlEvaluatedWorkflowRepository(
      tempDir,
      undefined,
      markDirty,
    );
    await repo.saveForRun(runId, provenanceWorkflow());

    await repo.deleteForRun(runId);

    assertEquals(calls.at(-1), runDir);
    assertEquals(existedWhenMarked, true);
    assertEquals(await repo.listRunSnapshots(), []);
    // A missing snapshot is ignored.
    await repo.deleteForRun(runId);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
