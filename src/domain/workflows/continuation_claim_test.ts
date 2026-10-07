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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import { SignalWait } from "./signal_wait.ts";
import {
  acquireContinuation,
  type ContinuationClaim,
  continuationClaimKey,
  ContinuationHeldError,
  continuationRunPrefix,
  decodeContinuationClaim,
  encodeContinuationClaim,
  generationFromKey,
  localHolder,
  serveHolder,
  serveInstanceOf,
  suspensionKeyOf,
} from "./continuation_claim.ts";
import {
  claimsFor,
  InMemoryContinuationClaimStore,
} from "./continuation_claim_test_helpers.ts";

const RUN = "11111111-1111-4111-8111-111111111111";
const KEY = "a".repeat(64);
const NOW = new Date("2026-01-01T00:00:00.000Z");
const SUSPENSION = { runId: RUN, suspensionKey: KEY };
const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};
const A = serveHolder("a");
const B = serveHolder("b");

function claim(generation = 1, holder = A): ContinuationClaim {
  return { ...SUSPENSION, generation, holder, claimedAt: NOW.toISOString() };
}

function waitingRun(): WorkflowRun {
  const run = WorkflowRun.create(
    Workflow.create({
      name: "release",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "review",
              task: StepTask.waitForSignal(60, SCHEMA),
            }),
          ],
        }),
      ],
    }),
  );
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("review")!;
  step.start();
  step.waitForSignal(SignalWait.open(SCHEMA, 60, NOW));
  run.suspend();
  return run;
}

Deno.test("continuationClaimKey: names the run, the suspension and the generation", () => {
  assertEquals(
    continuationClaimKey(claim(3)),
    `continuations/${RUN}/${KEY}/3`,
  );
  assertEquals(generationFromKey(continuationClaimKey(claim(3))), 3);
});

Deno.test("continuationClaimKey: refuses anything that is not a run id, a digest and a generation", () => {
  assertThrows(() => continuationRunPrefix("../other"));
  assertThrows(() =>
    continuationClaimKey({ ...claim(), suspensionKey: "../x" })
  );
  assertThrows(() => continuationClaimKey(claim(0)));
  for (
    const key of ["continuations/x/y/0", "continuations/x/y/1.tmp", "a/-1"]
  ) {
    assertEquals(generationFromKey(key), undefined, key);
  }
});

Deno.test("decodeContinuationClaim: a claim survives its stored form, and anything else is not a claim", () => {
  const stored = encodeContinuationClaim(claim(2));
  assertEquals(decodeContinuationClaim(stored, claim(2)), claim(2));
  // Stored under another generation's key.
  assertEquals(decodeContinuationClaim(stored, claim(1)), undefined);
  assertEquals(decodeContinuationClaim(null, claim(2)), undefined);
  assertEquals(
    decodeContinuationClaim(new TextEncoder().encode("{"), claim(2)),
    undefined,
  );
  assertEquals(
    decodeContinuationClaim(
      new TextEncoder().encode(JSON.stringify({ ...claim(2), holder: "" })),
      claim(2),
    ),
    undefined,
  );
});

Deno.test("serveInstanceOf: only a serve holder names an instance", () => {
  assertEquals(serveInstanceOf(serveHolder("abc")), "abc");
  assertEquals(serveInstanceOf(localHolder()), undefined);
  assertEquals(serveInstanceOf("serve:"), undefined);
});

Deno.test("suspensionKeyOf: the same record gives the same key, and a signal does not change it", async () => {
  const run = waitingRun();
  const key = await suspensionKeyOf(run);
  assert(/^[0-9a-f]{64}$/.test(key));
  assertEquals(await suspensionKeyOf(WorkflowRun.fromData(run.toData())), key);
});

Deno.test("suspensionKeyOf: a run that moved on gives another key", async () => {
  const run = waitingRun();
  const before = await suspensionKeyOf(run);
  run.getJob("main")!.getStep("review")!.succeed();
  assert(await suspensionKeyOf(run) !== before);
  // Another run suspended on a wait of its own.
  assert(await suspensionKeyOf(waitingRun()) !== before);
});

Deno.test("acquireContinuation: the first holder takes generation 1", async () => {
  const store = new InMemoryContinuationClaimStore();
  const acquired = await acquireContinuation(
    claimsFor(store, A),
    SUSPENSION,
    { kind: "manual" },
    NOW,
  );
  assertEquals(acquired, { kind: "acquired", claim: claim(1, A) });
  assertEquals(store.claims, [claim(1, A)]);
});

Deno.test("acquireContinuation: a holder's own claim is still its own", async () => {
  const store = new InMemoryContinuationClaimStore();
  await store.create(claim(1, A));
  const again = await acquireContinuation(
    claimsFor(store, A),
    SUSPENSION,
    { kind: "automatic", takeover: false },
    NOW,
  );
  assertEquals(again.kind, "acquired");
  assertEquals(store.claims.length, 1);
});

Deno.test("acquireContinuation: a claim held by a live holder refuses everyone", async () => {
  const store = new InMemoryContinuationClaimStore();
  await store.create(claim(1, A));
  for (
    const mode of [
      { kind: "manual" },
      { kind: "automatic", takeover: true },
    ] as const
  ) {
    const refused = await acquireContinuation(
      claimsFor(store, B, { [A]: "alive" }),
      SUSPENSION,
      mode,
      NOW,
    );
    assertEquals(refused, {
      kind: "held",
      claim: claim(1, A),
      liveness: "alive",
    });
  }
  assertEquals(store.claims.length, 1);
});

Deno.test("acquireContinuation: serve takes over a dead holder only when told its copy is current", async () => {
  const store = new InMemoryContinuationClaimStore();
  await store.create(claim(1, A));
  const claims = claimsFor(store, B, { [A]: "dead" });

  const stale = await acquireContinuation(
    claims,
    SUSPENSION,
    { kind: "automatic", takeover: false },
    NOW,
  );
  assertEquals(stale.kind, "held");

  const current = await acquireContinuation(
    claims,
    SUSPENSION,
    { kind: "automatic", takeover: true },
    NOW,
  );
  assertEquals(current, { kind: "acquired", claim: claim(2, B) });
  // The dead holder's claim stays: a takeover adds a generation.
  assertEquals(store.claims.length, 2);
});

Deno.test("acquireContinuation: serve never takes over a holder it knows nothing of", async () => {
  const store = new InMemoryContinuationClaimStore();
  const local = localHolder();
  await store.create(claim(1, local));
  const refused = await acquireContinuation(
    claimsFor(store, B),
    SUSPENSION,
    { kind: "automatic", takeover: true },
    NOW,
  );
  assertEquals(refused.kind, "held");
});

Deno.test("acquireContinuation: a manual resume replaces any holder not known to be alive", async () => {
  for (const liveness of ["dead", "unknown"] as const) {
    const store = new InMemoryContinuationClaimStore();
    await store.create(claim(1, A));
    const acquired = await acquireContinuation(
      claimsFor(store, B, { [A]: liveness }),
      SUSPENSION,
      { kind: "manual" },
      NOW,
    );
    assertEquals(acquired, { kind: "acquired", claim: claim(2, B) });
  }
});

Deno.test("ContinuationHeldError: names a serve instance, and no other holder", () => {
  const serve = new ContinuationHeldError(RUN, serveHolder("abc"), "alive");
  assert(serve.message.includes("swamp serve instance abc"));
  const local = new ContinuationHeldError(RUN, localHolder(), "unknown");
  assert(local.message.includes("another swamp command"));
  assert(!local.message.includes("local:"));
});
