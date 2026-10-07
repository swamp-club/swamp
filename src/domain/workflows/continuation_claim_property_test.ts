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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  acquireContinuation,
  type ContinuationClaim,
  continuationClaimKey,
  type ContinuationMode,
  decodeContinuationClaim,
  encodeContinuationClaim,
  generationFromKey,
  type HolderLiveness,
  serveHolder,
  suspensionKeyOf,
} from "./continuation_claim.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import {
  claimsFor,
  InMemoryContinuationClaimStore,
} from "./continuation_claim_test_helpers.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const claimArb: fc.Arbitrary<ContinuationClaim> = fc.record({
  runId: fc.uuid(),
  suspensionKey: fc.stringMatching(/^[0-9a-f]{64}$/),
  generation: fc.integer({ min: 1, max: 1_000_000 }),
  holder: fc.string({ minLength: 1, maxLength: 64 }),
  claimedAt: fc.constant(NOW.toISOString()),
});

Deno.test("continuation claim: any claim survives its stored form and is found only under its own key (property)", () => {
  fc.assert(
    fc.property(claimArb, (claim) => {
      assertEquals(
        decodeContinuationClaim(encodeContinuationClaim(claim), claim),
        claim,
      );
      assertEquals(
        generationFromKey(continuationClaimKey(claim)),
        claim.generation,
      );
      assertEquals(
        decodeContinuationClaim(encodeContinuationClaim(claim), {
          ...claim,
          generation: claim.generation + 1,
        }),
        undefined,
      );
    }),
  );
});

const HOLDERS = ["a", "b", "c", "d"].map(serveHolder);
const attemptArb = fc.record({
  holder: fc.constantFrom(...HOLDERS),
  mode: fc.constantFrom<ContinuationMode>(
    { kind: "manual" },
    { kind: "automatic", takeover: true },
    { kind: "automatic", takeover: false },
  ),
});
const livenessArb = fc.record(
  Object.fromEntries(
    HOLDERS.map((h) => [
      h,
      fc.constantFrom<HolderLiveness>("alive", "dead", "unknown"),
    ]),
  ),
) as fc.Arbitrary<Record<string, HolderLiveness>>;

Deno.test("acquireContinuation: no generation ever has two holders, and a live holder is never replaced (property)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(attemptArb, { minLength: 1, maxLength: 12 }),
      livenessArb,
      async (attempts, liveness) => {
        const store = new InMemoryContinuationClaimStore();
        const suspension = {
          runId: "11111111-1111-4111-8111-111111111111",
          suspensionKey: "b".repeat(64),
        };
        for (const { holder, mode } of attempts) {
          const before = await store.find(
            suspension.runId,
            suspension.suspensionKey,
          );
          const result = await acquireContinuation(
            claimsFor(store, holder, liveness),
            suspension,
            mode,
            NOW,
          );
          if (
            before && before.holder !== holder &&
            liveness[before.holder] === "alive"
          ) {
            assertEquals(result.kind, "held");
          }
          if (result.kind === "acquired") {
            assertEquals(result.claim.holder, holder);
          }
        }
        const generations = store.claims.map((c) => c.generation);
        assertEquals(new Set(generations).size, generations.length);
        // Generations are taken in order, with none skipped.
        assert(
          generations.sort((a, b) => a - b).every((g, i) => g === i + 1),
        );
      },
    ),
  );
});

Deno.test("suspensionKeyOf: every change a resume makes to a run gives a key not seen before, and a copy keeps its key (property)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.array(fc.nat(), { minLength: 1, maxLength: 5 }),
      async (stepCount, picks) => {
        const run = WorkflowRun.create(
          Workflow.create({
            name: "release",
            jobs: [
              Job.create({
                name: "main",
                steps: Array.from({ length: stepCount }, (_, i) =>
                  Step.create({
                    name: `s${i}`,
                    task: StepTask.manualApproval("ok?"),
                  })),
              }),
            ],
          }),
        );
        run.start();
        const job = run.getJob("main")!;
        job.start();
        for (const step of job.steps) {
          step.start();
          step.waitForApproval();
        }
        run.suspend();

        const seen = new Set([await suspensionKeyOf(run)]);
        // Each pick advances one step by one stage: decided, then done.
        const stage = new Map<number, number>();
        for (const pick of picks) {
          const index = pick % stepCount;
          const step = job.getStep(`s${index}`)!;
          const at = stage.get(index) ?? 0;
          if (at === 0) {
            step.recordApprovalDecision({
              approved: true,
              decidedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seen.size))
                .toISOString(),
            });
          } else if (at === 1) {
            step.succeed();
          } else {
            continue;
          }
          stage.set(index, at + 1);
          const key = await suspensionKeyOf(run);
          assertEquals(seen.has(key), false);
          seen.add(key);
          assertEquals(
            await suspensionKeyOf(WorkflowRun.fromData(run.toData())),
            key,
          );
        }
      },
    ),
  );
});
