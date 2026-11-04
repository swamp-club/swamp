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

import { assertEquals, assertRejects } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Fleet } from "./fleet_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const WEB = { fleet: "web" };

Deno.test({
  name:
    "fleet fan-out guard: a run of a workflow with a fan-out job fails at run start through serve's run entry, and no step dispatches (swamp-club#4379)",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: WEB });
    await fleet.addWorker("w-b", { labels: WEB });
    // passes every fan-out refusal, so only the run-start guard can stop it
    const workflow = await fleet.saveWorkflow({
      name: "patch-all",
      inputs: {},
      jobs: [{
        name: "patch",
        fanOut: "all",
        labels: WEB,
        steps: [{
          name: "apply",
          task: {
            type: "model_method",
            modelType: fleet.modelType.normalized,
            modelName: "patch",
            methodName: "run",
          },
        }],
      }],
    });

    await assertRejects(
      () => fleet.runWorkflow("patch-all"),
      Error,
      "fan-out jobs are not available in this version of swamp",
    );
    assertEquals(fleet.dispatchCounts(), { "w-a": 0, "w-b": 0 });
    assertEquals(
      await fleet.repoContext.workflowRunRepo.findAllByWorkflowId(workflow.id),
      [],
    );
  },
});
