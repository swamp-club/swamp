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

// a run record the repository writes reads the same in serve as one an older
// binary wrote, so forwarding and read filtering decide alike for both

import { assert, assertEquals } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import type { TypedChange } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  isGuardedRunRecord,
  WorkflowRun,
  type WorkflowRunInput,
  WorkflowRunSchema,
} from "../src/domain/workflows/workflow_run.ts";
import type { V3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { typedRecordingUnitOfWork } from "../src/infrastructure/persistence/test_helpers/staged_change_helpers.ts";
import { runInUnitOfWork } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { storedRunRecordGuarded } from "../src/serve/commit_read_filter.ts";
import { parseRecord } from "../src/serve/forwarded_content_authorization.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

function storeHolding(key: string, bytes: Uint8Array): V3Datastore {
  return {
    namespace: "ns",
    readModel: {
      liveRecords: () =>
        Promise.resolve([{
          key: RecordKey.create(key),
          sha256: "live",
          content: { kind: "inline" },
        }]),
      recordBytes: () =>
        Promise.resolve({ record: { sha256: "live", writer: null }, bytes }),
    },
  } as unknown as V3Datastore;
}

async function stagedBytes(change: TypedChange): Promise<Uint8Array> {
  assert("put" in change);
  const content = change.put.content;
  return content instanceof Uint8Array
    ? content
    : new Uint8Array(await new Response(await content()).arrayBuffer());
}

const workflow = Workflow.create({
  id: crypto.randomUUID(),
  name: "deploy",
  jobs: [
    Job.create({
      name: "main",
      steps: [
        Step.create({ name: "gate", task: StepTask.model("sh1", "execute") }),
      ],
    }),
  ],
});

function variants(): { name: string; data: WorkflowRunInput }[] {
  const base = WorkflowRun.create(workflow).toPersistedData();
  const step = (extra: Record<string, unknown>) => [{
    jobName: "main",
    status: "succeeded" as const,
    steps: [{
      stepName: "gate",
      status: "succeeded" as const,
      output: { stdout: "yes\nno: 1 # x", code: "0", empty: "" },
      ...extra,
    }],
  }];
  const statuses = [
    "pending",
    "running",
    "suspended",
    "succeeded",
    "failed",
  ] as const;
  return [
    ...statuses.map((status) => ({
      name: status,
      data: {
        ...base,
        id: crypto.randomUUID(),
        status,
        jobs: step({}),
        tags: { on: "off", "a: b": "null" },
      },
    })),
    {
      name: "serve-driven",
      data: {
        ...base,
        id: crypto.randomUUID(),
        status: "running",
        instanceId: "node-1",
        jobs: step({}),
      },
    },
    {
      name: "decided",
      data: {
        ...base,
        id: crypto.randomUUID(),
        status: "running",
        jobs: step({
          approvalDecision: {
            approved: true,
            reason: "true",
            decidedAt: "2026-11-11T14:00:00.000Z",
          },
        }),
      },
    },
  ];
}

Deno.test("run record writer: serve parses and guards a record the repository writes as it does one an older binary wrote", async () => {
  await withTempDir(async (dir) => {
    for (const { name, data } of variants()) {
      const { markDirty, uow, batches } = typedRecordingUnitOfWork();
      const repo = new YamlWorkflowRunRepository(
        dir,
        undefined,
        undefined,
        markDirty,
      );
      const run = WorkflowRun.fromData(data);
      await runInUnitOfWork(uow, () => repo.save(workflow.id, run));

      assertEquals(batches.length, 1, name);
      const [change] = batches[0];
      assert("put" in change, name);
      const written = await stagedBytes(change);
      assertEquals(
        new TextDecoder().decode(written),
        await Deno.readTextFile(repo.getPath(workflow.id, run.id)),
        name,
      );
      const older = new TextEncoder().encode(
        stringifyYaml(JSON.parse(JSON.stringify(run.toPersistedData()))),
      );

      const parsedNew = parseRecord(written);
      const parsedOld = parseRecord(older);
      assert(parsedNew !== undefined, name);
      assertEquals(JSON.stringify(parsedNew), JSON.stringify(parsedOld), name);
      const schema = WorkflowRunSchema.safeParse(parsedNew);
      assert(schema.success, name);
      const expectGuarded = isGuardedRunRecord(schema.data);
      assertEquals(
        expectGuarded,
        name === "serve-driven" || name === "decided",
      );

      const key = change.put.key.toString();
      assertEquals(
        await storedRunRecordGuarded(
          storeHolding(key, written),
          workflow.id,
          run.id,
        ),
        expectGuarded,
        name,
      );
      assertEquals(
        await storedRunRecordGuarded(
          storeHolding(key, older),
          workflow.id,
          run.id,
        ),
        expectGuarded,
        name,
      );
    }
  });
});

Deno.test("run record writer: a cut-short record still fails closed in serve", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlWorkflowRunRepository(dir);
    const run = WorkflowRun.fromData(variants()[1].data);
    await repo.save(workflow.id, run);
    const content = await Deno.readTextFile(repo.getPath(workflow.id, run.id));
    const cut = new TextEncoder().encode(
      content.slice(0, content.indexOf('"yes') + 3),
    );
    assertEquals(parseRecord(cut), undefined);
    const key = `workflow-runs/${workflow.id}/workflow-run-${run.id}.yaml`;
    assert(
      await storedRunRecordGuarded(storeHolding(key, cut), workflow.id, run.id),
    );
  });
});
