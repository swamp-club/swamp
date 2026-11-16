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
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { createWorkflowRunId } from "../domain/workflows/workflow_id.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import {
  findParkedRun,
  forgetParkedRun,
  listParkedRuns,
  parkedRunHandled,
  parkedRunKey,
  parkerAsOwner,
  ServeHandover,
} from "./serve_handover.ts";

function memoryStore(): ControlPlaneStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    put: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(data.get(key) ?? null),
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve([...data.keys()].filter((k) => k.startsWith(prefix))),
  };
}

Deno.test("ServeHandover: a parked run is listed with its parker until it is forgotten", async () => {
  const store = memoryStore();
  const handover = new ServeHandover("serve-a");
  handover.useMarkerStore(store);

  await handover.forRun().parked!({
    id: createWorkflowRunId("run-1"),
    workflowId: "wf-1",
  });

  const [marker] = await listParkedRuns(store);
  assertEquals(marker.runId, "run-1");
  assertEquals(marker.workflowId, "wf-1");
  assertEquals(marker.parker.instanceId, "serve-a");
  assertEquals(marker.parker.pid, Deno.pid);
  assertEquals((await findParkedRun(store, "run-1"))?.runId, "run-1");

  await forgetParkedRun(store, "run-1");
  assertEquals(await listParkedRuns(store), []);
  assertEquals(await findParkedRun(store, "run-1"), undefined);
});

Deno.test("listParkedRuns: a marker that names another run, or cannot be read, is skipped", async () => {
  const store = memoryStore();
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  store.data.set(
    parkedRunKey("run-a"),
    encode({ runId: "run-b", workflowId: "wf", parker: {} }),
  );
  store.data.set(parkedRunKey("run-c"), new TextEncoder().encode("{not json"));

  assertEquals(await listParkedRuns(store), []);
});

Deno.test("ServeHandover: without a marker store a parked run is found only at a boot pass, and parking still succeeds", async () => {
  const handover = new ServeHandover("serve-a");

  await handover.forRun().parked!({
    id: createWorkflowRunId("run-1"),
    workflowId: "wf-1",
  });

  assertEquals(handover.markerStore, undefined);
});

Deno.test("ServeHandover: the handover fires once begun and names this process as the parker", () => {
  const handover = new ServeHandover("serve-a");
  const run = handover.forRun(() => 17);
  assertEquals(run.signal.aborted, false);

  handover.begin();

  assertEquals(run.signal.aborted, true);
  const parker = run.parker("run-1");
  assertEquals(parker.instanceId, "serve-a");
  assertEquals(parker.pid, Deno.pid);
  assertEquals(parker.eventSeq, 17);
});

Deno.test("parkerAsOwner: a parker missing its instance or pid cannot be judged and counts as gone", () => {
  assertEquals(parkerAsOwner({ pid: 1 }), undefined);
  assertEquals(parkerAsOwner({ instanceId: "a" }), undefined);
  assertEquals(parkerAsOwner({ instanceId: "a", pid: 1, host: "h" }), {
    instanceId: "a",
    pid: 1,
    host: "h",
  });
});

function parkedRun(): WorkflowRun {
  const run = WorkflowRun.create(
    Workflow.create({
      name: "marker-wf",
      jobs: [
        Job.create({
          name: "main",
          steps: [Step.create({ name: "a", task: StepTask.model("m", "run") })],
        }),
      ],
    }),
  );
  run.start(4242, "serve-old");
  run.park({ instanceId: "serve-old", pid: 4242 }, new Date());
  return run;
}

Deno.test("parkedRunHandled: a marker is kept while its run still waits to be continued", () => {
  assertEquals(parkedRunHandled(parkedRun()), false);
});

Deno.test("parkedRunHandled: a marker goes once the run is gone, continued, or refused for good", () => {
  assertEquals(parkedRunHandled(null), true);

  const continued = parkedRun();
  continued.resetUnknownStepsForRecovery({ holder: "serve:b", at: new Date() });
  assertEquals(parkedRunHandled(continued), true);

  const optedOut = parkedRun();
  optedOut.recordAutoContinuationRefusal({
    reason: "opted_out",
    steps: [],
    message: "The workflow sets autoContinue: false.",
  }, new Date());
  assertEquals(parkedRunHandled(optedOut), true);
});

Deno.test("parkedRunHandled: a refusal that is judged again keeps the marker", () => {
  const waiting = parkedRun();
  waiting.recordAutoContinuationRefusal({
    reason: "nested_run_unsettled",
    steps: [],
    message: "A nested run is still open.",
  }, new Date());

  assertEquals(parkedRunHandled(waiting), false);
});

Deno.test("findParkedRun: a run id that could name another key is never read", async () => {
  const store = memoryStore();
  const reads: string[] = [];
  const watched: ControlPlaneStore = {
    ...store,
    get: (key) => {
      reads.push(key);
      return store.get(key);
    },
  };

  assertEquals(await findParkedRun(watched, "../active-runs/x"), undefined);
  assertEquals(reads, []);
});
