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

import { assertEquals, assertThrows } from "@std/assert";
import {
  fanOutJobFailed,
  laneFailed,
  laneStepName,
  laneStepOf,
  laneWorkerScope,
  perWorkerBehaviorName,
  planLaneSteps,
  refusedPlanMessage,
} from "./fan_out_lanes.ts";

Deno.test("planLaneSteps: names one step per authored step and worker, mapped back to both", () => {
  const steps = planLaneSteps("patch", ["apply", "verify"], ["w-a", "w-b"]);
  assertEquals([...steps.keys()], [
    "apply[w-a]",
    "verify[w-a]",
    "apply[w-b]",
    "verify[w-b]",
  ]);
  assertEquals(steps.get("verify[w-b]"), { worker: "w-b", authored: "verify" });
});

Deno.test("planLaneSteps: refuses two lanes that would share a step name", () => {
  assertThrows(
    () => planLaneSteps("patch", ["a", "a[b]"], ["b][c", "c"]),
    Error,
    "which step 'a' on worker 'b][c' also gives",
  );
});

Deno.test("planLaneSteps: refuses a lane step named like an authored step", () => {
  assertThrows(
    () => planLaneSteps("patch", ["apply", "apply[w-a]"], ["w-a"]),
    Error,
    "is already a step of the job",
  );
});

Deno.test("laneStepName: the step name followed by the worker in brackets", () => {
  assertEquals(laneStepName("apply", "web-01"), "apply[web-01]");
});

Deno.test("perWorkerBehaviorName: suffixes the worker unless the name is built from self.worker.name", () => {
  assertEquals(
    perWorkerBehaviorName("host-patch", "web-01"),
    "host-patch-web-01",
  );
  assertEquals(
    perWorkerBehaviorName(
      "patch-web-01",
      "web-01",
      "patch-${{ self.worker.name }}",
    ),
    "patch-web-01",
  );
  assertEquals(
    perWorkerBehaviorName(
      "patch-linux",
      "web-01",
      "patch-${{ self.worker.platform }}",
    ),
    "patch-linux-web-01",
  );
});

Deno.test("laneWorkerScope: exposes name, labels, platform and arch only", () => {
  assertEquals(
    laneWorkerScope({
      name: "w-a",
      instanceUuid: "u",
      labels: { role: "web" },
      platform: "linux",
      arch: "x86_64",
      status: "idle",
      connected: true,
    }),
    { name: "w-a", labels: { role: "web" }, platform: "linux", arch: "x86_64" },
  );
});

Deno.test("laneFailed: only a failure that was not allowed fails the lane", () => {
  assertEquals(
    laneFailed([{ status: "failed", allowedFailure: true }, {
      status: "succeeded",
      allowedFailure: false,
    }]),
    false,
  );
  assertEquals(laneFailed([{ status: "failed", allowedFailure: false }]), true);
  assertEquals(
    laneFailed([{ status: "skipped", allowedFailure: false }]),
    false,
  );
});

Deno.test("fanOutJobFailed: a failed lane or a member failed at plan time fails the job; skipped and excluded do not", () => {
  assertEquals(
    fanOutJobFailed(
      [{ disposition: "skipped" }, { disposition: "excluded" }],
      0,
    ),
    false,
  );
  assertEquals(fanOutJobFailed([{ disposition: "dispatch" }], 1), true);
  assertEquals(fanOutJobFailed([{ disposition: "failed" }], 0), true);
});

Deno.test("refusedPlanMessage: names the job, the selector and the live count", () => {
  assertEquals(
    refusedPlanMessage("patch", { labels: { role: "web" } }, 0, 1),
    "Fan-out job 'patch' needs at least 1 worker matching labels role=web that is connected or waiting, and 0 are; nothing was sent.",
  );
  assertEquals(
    refusedPlanMessage("patch", { platform: "linux" }, 1, 3),
    "Fan-out job 'patch' needs at least 3 workers matching platform 'linux' that are connected or waiting, and 1 is; nothing was sent.",
  );
});

Deno.test("laneStepOf: maps a lane step back to its authored step and worker, and leaves other names alone", () => {
  const lanes = [{ worker: "w-a" }, { worker: "b]" }];
  assertEquals(laneStepOf("apply[w-a]", lanes), {
    worker: "w-a",
    authored: "apply",
  });
  assertEquals(laneStepOf("a[b]]", lanes), { worker: "b]", authored: "a" });
  assertEquals(laneStepOf("apply", lanes), undefined);
  assertEquals(laneStepOf("[w-a]", lanes), undefined);
  assertEquals(laneStepOf("apply[w-a]", undefined), undefined);
});
