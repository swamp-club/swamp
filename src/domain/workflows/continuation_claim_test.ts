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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import { SignalWait } from "./signal_wait.ts";
import { acceptedOutcomeFor } from "./signal_wait_store_test_helpers.ts";
import {
  abortCancelled,
  CancelIntentRecorder,
  claimForOperatorRecover,
  continuationCancelKey,
  decodeCancelIntent,
  encodeCancelIntent,
  OPERATOR_CLAIM_STALE_MS,
} from "./continuation_claim.ts";
import { UserError } from "../errors.ts";
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
  removeClaimsOfRuns,
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
  const signalled = waitingRun();
  const waiting = await suspensionKeyOf(signalled);
  const step = signalled.getJob("main")!.getStep("review")!;
  assert(
    step.applyWaitOutcome(
      acceptedOutcomeFor(step.signalWait!, { verdict: "ship" }, {
        runId: signalled.id,
      }),
    ),
  );
  assert(await suspensionKeyOf(signalled) !== waiting);
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

Deno.test("removeClaimsOfRuns: one run whose claims cannot be removed does not keep the others, and an id that is no run id is passed over", async () => {
  const [a, bad, b] = [0, 1, 2].map(() => crypto.randomUUID());
  const removed: string[] = [];
  const store = {
    removeForRun: (runId: string) => {
      if (runId === bad) return Promise.reject(new Error("store down"));
      removed.push(runId);
      return Promise.resolve();
    },
  };
  await assertRejects(
    () => removeClaimsOfRuns(store, [a, "legacy-run", bad, b]),
    Error,
    "store down",
  );
  assertEquals(removed, [a, b]);
  await removeClaimsOfRuns(undefined, [a]);
});

function interruptedRunForClaims(): WorkflowRun {
  const run = WorkflowRun.create(
    Workflow.create({
      name: "claimed",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({ name: "a", task: StepTask.model("m", "run") })],
      })],
    }),
  );
  run.start(1, "serve-a");
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  run.interrupt("server_crash");
  return run;
}

Deno.test("decodeCancelIntent: round-trips a cancel and refuses another run's or a damaged one", () => {
  const runId = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const intent = {
    runId,
    requestedAt: "2026-11-14T10:00:00.000Z",
    reason: "cancelled by user",
  };
  assertEquals(decodeCancelIntent(encodeCancelIntent(intent), runId), intent);
  assertEquals(
    decodeCancelIntent(
      encodeCancelIntent(intent),
      "7a2d3b4c-5e6f-4a70-9b8c-0d1e2f3a4b5c",
    ),
    undefined,
  );
  assertEquals(
    decodeCancelIntent(new TextEncoder().encode("{"), runId),
    undefined,
  );
  assertEquals(decodeCancelIntent(null, runId), undefined);
  assertEquals(
    continuationCancelKey(runId),
    `${continuationRunPrefix(runId)}cancel`,
  );
});

Deno.test("CancelIntentRecorder: aborts at once, records the cancel beside it, and reports a failed write", async () => {
  const written: string[] = [];
  const write = Promise.withResolvers<void>();
  const recorder = new CancelIntentRecorder(
    async (runId) => {
      await write.promise;
      written.push(runId);
    },
    () => {},
  );
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  abortCancelled(recorder, runId, controller, "cancelled by user");
  assert(controller.signal.aborted, "the cancel waited on the write");
  assertEquals(
    (controller.signal.reason as Error).message,
    "cancelled by user",
  );
  write.resolve();
  await recorder.settled();
  assertEquals(written, [runId]);

  const failures: string[] = [];
  const failing = new CancelIntentRecorder(
    () => Promise.reject(new Error("store down")),
    (id) => failures.push(id),
  );
  const other = new AbortController();
  abortCancelled(failing, runId, other, "cancelled by user");
  assert(other.signal.aborted);
  await failing.settled();
  assertEquals(failures, [runId]);
});

Deno.test("CancelIntentRecorder: a write that hangs is dropped at its deadline, so nothing waits on it longer", async () => {
  const failures: unknown[] = [];
  let sawDeadline = false;
  const recorder = new CancelIntentRecorder(
    (_runId, _reason, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          sawDeadline = true;
          resolve();
        });
      }),
    (_id, error) => failures.push(error),
    20,
  );
  const controller = new AbortController();
  abortCancelled(recorder, crypto.randomUUID(), controller, "why");
  assert(controller.signal.aborted);
  await recorder.settled();
  assert(sawDeadline, "the write was not told its deadline passed");
  assertEquals(failures.length, 1);
  assertStringIncludes(String(failures[0]), "longer than 20ms");
});

Deno.test("abortCancelled: without a recorder, or for an id no record can name, aborts at once", () => {
  const plain = new AbortController();
  abortCancelled(undefined, crypto.randomUUID(), plain, "why");
  assert(plain.signal.aborted);
  let wrote = false;
  const recorder = new CancelIntentRecorder(() => {
    wrote = true;
    return Promise.resolve();
  }, () => {});
  const unstarted = new AbortController();
  abortCancelled(recorder, "", unstarted, "why");
  assert(unstarted.signal.aborted);
  assertEquals(wrote, false);
});

Deno.test("claimForOperatorRecover: takes a free claim, refuses a fresh one held elsewhere, replaces a stale one", async () => {
  const run = interruptedRunForClaims();
  const key = await suspensionKeyOf(run);
  const now = new Date("2026-11-14T10:00:00.000Z");
  assertEquals(await claimForOperatorRecover(undefined, run, now), undefined);

  const free = new InMemoryContinuationClaimStore();
  const operator = claimsFor(free, localHolder());
  const taken = await claimForOperatorRecover(operator, run, now);
  assertEquals(taken?.claim.generation, 1);
  assertEquals(taken?.replaced, undefined);
  assertEquals(
    (await claimForOperatorRecover(operator, run, now))?.claim.generation,
    1,
  );

  const store = new InMemoryContinuationClaimStore();
  const serve = serveHolder("a");
  await store.create({
    runId: run.id,
    suspensionKey: key,
    generation: 1,
    holder: serve,
    claimedAt: new Date(now.getTime() - 5_000).toISOString(),
  });
  const cli = claimsFor(store, localHolder());
  await assertRejects(
    () => claimForOperatorRecover(cli, run, now),
    UserError,
    "retry in 295s",
  );
  const later = new Date(now.getTime() + OPERATOR_CLAIM_STALE_MS);
  const replaced = await claimForOperatorRecover(cli, run, later);
  assertEquals(replaced?.claim.generation, 2);
  assertEquals(replaced?.replaced, serve);
});

Deno.test("claimForOperatorRecover: never takes over a holder known alive, however old its claim, and takes over a dead or unknown one once stale", async () => {
  const run = interruptedRunForClaims();
  const key = await suspensionKeyOf(run);
  const now = new Date("2026-11-14T10:00:00.000Z");
  const serve = serveHolder("a");
  const old = {
    runId: run.id,
    suspensionKey: key,
    generation: 1,
    holder: serve,
    claimedAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
  };

  const continuing = new InMemoryContinuationClaimStore();
  await continuing.create(old);
  await assertRejects(
    () =>
      claimForOperatorRecover(
        claimsFor(continuing, localHolder(), { [serve]: "alive" }),
        run,
        now,
      ),
    UserError,
    "holds it until that run ends",
  );
  assertEquals(continuing.claims.length, 1);

  for (const liveness of ["dead", "unknown"] as const) {
    const store = new InMemoryContinuationClaimStore();
    await store.create(old);
    const replaced = await claimForOperatorRecover(
      claimsFor(store, localHolder(), { [serve]: liveness }),
      run,
      now,
    );
    assertEquals(replaced?.claim.generation, 2, liveness);
    assertEquals(replaced?.replaced, serve, liveness);
  }
});

Deno.test("CancelIntentRecorder: an error reporter that throws still lets settled() resolve", async () => {
  const recorder = new CancelIntentRecorder(
    () => Promise.reject(new Error("store down")),
    () => {
      throw new Error("reporter broke");
    },
  );
  const controller = new AbortController();
  abortCancelled(recorder, crypto.randomUUID(), controller, "why");
  assert(controller.signal.aborted);
  await recorder.settled();
});
