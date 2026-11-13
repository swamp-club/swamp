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

import { assert } from "@std/assert";
import fc from "fast-check";
import {
  decideAutoContinuation,
  MAX_CONSECUTIVE_AUTO_CONTINUATIONS,
} from "./auto_continuation.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import { computeWorkflowFingerprint } from "./workflow_fingerprint.ts";

const arbCase = fc.record({
  guards: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
  // steps finished before the cut; the next one, if any, was running
  finished: fc.nat({ max: 4 }),
  serveDriven: fc.boolean(),
  stamped: fc.boolean(),
  autoContinue: fc.option(fc.boolean(), { nil: undefined }),
  priorContinuations: fc.nat({ max: MAX_CONSECUTIVE_AUTO_CONTINUATIONS + 1 }),
  definitionChanged: fc.boolean(),
});

Deno.test("decideAutoContinuation: never continues a run that is unsafe or opted out", async () => {
  await fc.assert(
    fc.asyncProperty(arbCase, async (c) => {
      const build = (guardSuffix: string) =>
        Workflow.create({
          id: "0b9c8d2e-5a0f-4c1e-9f3a-2b6d7e8f9a02",
          name: "prop",
          autoContinue: c.autoContinue,
          jobs: [
            Job.create({
              name: "job1",
              steps: c.guards.map((guarded, i) =>
                Step.create({
                  name: `s${i}`,
                  task: StepTask.model(`m${guardSuffix}`, "run"),
                  guard: guarded ? 'data.latest("m", "d") == null' : undefined,
                })
              ),
            }),
          ],
        });
      const original = build("");
      const workflow = c.definitionChanged ? build("x") : original;
      const run = WorkflowRun.create(original);
      const fingerprint = await computeWorkflowFingerprint(original);
      run.captureRunPlan(fingerprint, undefined, fingerprint);
      run.start(1, c.serveDriven ? "serve-a" : undefined);
      run.jobs[0].start();
      let t = Date.parse("2026-11-12T10:00:00.000Z");
      for (let k = 0; k < c.priorContinuations; k++) {
        run.jobs[0].steps[0].start(new Date(t + 1));
        run.interrupt("server_crash");
        run.resetUnknownStepsForRecovery({ holder: "h", at: new Date(t + 2) });
        run.resumeFromSuspended({ pid: 1, instanceId: "serve-a" });
        run.jobs[0].start();
        t += 10;
      }
      const steps = run.jobs[0].steps;
      const done = Math.min(c.finished, steps.length);
      for (let i = 0; i < done; i++) {
        steps[i].start(new Date(t + 1));
        steps[i].succeed();
      }
      if (done < steps.length) steps[done].start(new Date(t + 1));
      run.interrupt("server_crash");
      if (c.stamped) run.markContinuable(new Date(t + 5));

      const verdict = await decideAutoContinuation(workflow, run, {
        fanOutPoolAvailable: true,
        nestedRunUnsettled: () => Promise.resolve(undefined),
      });
      if (verdict.kind !== "continue") return;

      assert(c.stamped && c.serveDriven && c.autoContinue !== false);
      assert(!c.definitionChanged);
      const cutStep = done < steps.length ? done : undefined;
      assert(cutStep === undefined || c.guards[cutStep]);
      assert(
        done > 0 || c.priorContinuations < MAX_CONSECUTIVE_AUTO_CONTINUATIONS,
      );
    }),
    { numRuns: 300 },
  );
});
