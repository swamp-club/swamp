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

/**
 * Remote-secrets baseline, path 5: the per-dispatch credential
 * (swamp-club#3512).
 *
 * Pins how the credential a runner presents to the data plane is issued,
 * how its expiry slides, and when it stops verifying: completion, failure,
 * a dropped worker, a revoked token and reassignment. Also pins the
 * off-loopback TLS and auth rule serve enforces at bind time, and that the
 * worker derives its data-plane URL from the connect URL without enforcing
 * one. Typed-secrets Phase 5 binds secret handles to this credential
 * (design/enablers/typed-secrets.md §9).
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { defineModel, modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { SessionCredentialService } from "../src/domain/remote/session_credential.ts";
import {
  type DispatchParams,
  type DispatchResult,
  WorkerMethod,
} from "../src/domain/remote/protocol.ts";
import type { RemoteStepRequest } from "../src/domain/remote/remote_dispatch.ts";
import { assertOffLoopbackSecurity } from "../src/cli/commands/serve.ts";
import { dataPlaneUrlFromConnectUrl } from "../src/worker/data_plane_client.ts";
import { UserError } from "../src/domain/errors.ts";
import {
  type BaselineOrchestrator,
  connectInMemoryWorker,
  type InMemoryWorker,
  startBaselineOrchestrator,
  withTempDir,
} from "./remote_secrets_baseline_harness.ts";

await initializeLogging({});

const CREDENTIAL_TYPE = ModelType.create("swamp/secrets-baseline-credential");
const CREDENTIAL_DEFINITION_ID = "3512c0de-0005-4000-8000-000000000005";

defineModel({
  type: CREDENTIAL_TYPE,
  version: "2026.10.15.1",
  methods: {
    run: {
      description: "never runs; the in-memory worker answers the dispatch",
      kind: "action",
      arguments: z.object({}),
      execute: () => Promise.resolve({}),
    },
  },
});

function stepRequest(signal?: AbortSignal): RemoteStepRequest {
  return {
    placeArguments: (args) => args,
    placement: { labels: { tier: "baseline" } },
    modelDef: modelRegistry.get(CREDENTIAL_TYPE)!,
    modelType: CREDENTIAL_TYPE,
    modelId: CREDENTIAL_DEFINITION_ID,
    methodName: "run",
    definitionName: "credential-baseline",
    definitionTags: {},
    definitionMeta: {
      id: CREDENTIAL_DEFINITION_ID,
      name: "credential-baseline",
      version: 1,
      tags: {},
    },
    globalArgs: {},
    methodArgs: {},
    workflowName: "credential-baseline-workflow",
    stepName: "credential-baseline-step",
    signal,
  };
}

const SUCCESS: DispatchResult = {
  status: "success",
  outputs: [],
  logs: [],
  durationMs: 1,
};

/** One dispatch as the in-memory worker saw it, held open until settled. */
interface HeldDispatch {
  dispatchId: string;
  /** The out-of-schema field the gateway adds to the raw params. */
  credential: string;
  settle: (result: DispatchResult) => void;
}

/**
 * Registers a dispatch handler that records each dispatch and holds it
 * open until the test settles it.
 */
function holdDispatches(worker: InMemoryWorker): HeldDispatch[] {
  const held: HeldDispatch[] = [];
  worker.channel.register(WorkerMethod.dispatch, (raw) => {
    const params = raw as DispatchParams & { dispatchCredential: string };
    return new Promise<DispatchResult>((resolve) => {
      held.push({
        dispatchId: params.dispatchId,
        credential: params.dispatchCredential,
        settle: resolve,
      });
    });
  });
  return held;
}

/**
 * The status the data plane answers with for `credential` on a route that
 * exists only past authentication: 404 means the credential verified, 401
 * means it did not.
 */
async function dataPlaneStatus(
  o: BaselineOrchestrator,
  credential: string,
): Promise<number> {
  const response = await fetch(`${o.dataPlaneUrl}/data/baseline-probe`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  });
  await response.body?.cancel();
  return response.status;
}

const AUTHENTICATED = 404;
const REJECTED = 401;

/**
 * Waits out the control-plane bookkeeping serve writes after a step has
 * settled, so it lands before the temp repo is removed. The gateway
 * records worker status (busy, idle, disconnected) and the dispatch service
 * records pending-dispatch queue ends on transition tails nobody awaits.
 * Each call below is queued behind them and awaited: a revoke of a token no
 * worker holds is a no-op, and a first-write mark for an unknown lease
 * fails once it runs.
 */
async function drainBookkeeping(o: BaselineOrchestrator): Promise<void> {
  await o.gateway.revokeToken(`drain-${crypto.randomUUID()}`, "revoked");
  const id = crypto.randomUUID();
  await o.dispatchService.recordFirstWrite({
    workerName: "drain",
    dispatchId: id,
    leaseId: id,
    modelDef: modelRegistry.get(CREDENTIAL_TYPE)!,
    modelType: CREDENTIAL_TYPE,
    modelId: CREDENTIAL_DEFINITION_ID,
    methodName: "run",
    definitionName: "credential-baseline",
    definitionTags: {},
  }).catch(() => {});
}

async function withOrchestrator(
  fn: (o: BaselineOrchestrator) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const o = await startBaselineOrchestrator(dir);
    try {
      await fn(o);
      await drainBookkeeping(o);
    } finally {
      await o.shutdown();
    }
  });
}

/** A controllable interval: `fire()` runs every registered callback. */
function manualIntervals() {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval: (cb: () => void, _ms: number) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    clearInterval: (id: number) => {
      callbacks.delete(id);
    },
    fire: () => {
      for (const cb of [...callbacks.values()]) cb();
    },
    get active() {
      return callbacks.size;
    },
  };
}

// ── SessionCredentialService ────────────────────────────────────────────

Deno.test("remote secrets baseline: dispatch credential: issueForDispatch scopes the credential to its worker and dispatch with the TTL", () => {
  const timers = manualIntervals();
  const sessions = new SessionCredentialService({
    ttlMs: 60_000,
    now: () => 1_000_000,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  const record = sessions.issueForDispatch("w1", "d1");
  assertEquals(record.workerId, "w1");
  assertEquals(record.dispatchId, "d1");
  assertEquals(record.expiresAtMs, 1_060_000);
  assertEquals(sessions.verify(record.credential), {
    workerId: "w1",
    dispatchId: "d1",
  });
  // A control credential for the same worker is a separate record; issuing
  // one leaves the dispatch credential alone.
  const control = sessions.issue("w1");
  assert(control.credential !== record.credential);
  assertEquals(sessions.verify(record.credential)?.dispatchId, "d1");
  assertEquals(timers.active, 1);
});

Deno.test("remote secrets baseline: dispatch credential: without a refresh the credential stops verifying at expiry and is deleted", () => {
  let now = 1_000_000;
  const timers = manualIntervals();
  const sessions = new SessionCredentialService({
    ttlMs: 60_000,
    now: () => now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  const record = sessions.issueForDispatch("w1", "d1");
  now = record.expiresAtMs - 1;
  assert(sessions.verify(record.credential) !== null);
  now = record.expiresAtMs;
  assertEquals(sessions.verify(record.credential), null);
  // Deleted, not just expired: the refresh timer goes with it, and moving
  // the clock back does not bring the credential back.
  assertEquals(timers.active, 0);
  now = 1_000_000;
  assertEquals(sessions.verify(record.credential), null);
});

Deno.test("remote secrets baseline: dispatch credential: the refresh timer slides the expiry by a full TTL from now, at 2/3 of the TTL", () => {
  let now = 1_000_000;
  const intervals: number[] = [];
  const timers = manualIntervals();
  const sessions = new SessionCredentialService({
    ttlMs: 60_000,
    now: () => now,
    setInterval: (cb, ms) => {
      intervals.push(ms);
      return timers.setInterval(cb, ms);
    },
    clearInterval: timers.clearInterval,
  });
  const record = sessions.issueForDispatch("w1", "d1");
  assertEquals(intervals, [40_000]);
  now = 1_050_000;
  timers.fire();
  assertEquals(record.expiresAtMs, 1_110_000);
  now = 1_100_000;
  assert(sessions.verify(record.credential) !== null);
  // The string never changes, so a runner holding it needs no update.
  assertEquals(
    sessions.verify(record.credential)?.dispatchId,
    "d1",
  );
});

Deno.test("remote secrets baseline: dispatch credential: the default TTL is 15 minutes and the refresh interval never drops below one second", () => {
  const intervals: number[] = [];
  const timers = manualIntervals();
  const defaults = new SessionCredentialService({
    now: () => 0,
    setInterval: (cb, ms) => {
      intervals.push(ms);
      return timers.setInterval(cb, ms);
    },
    clearInterval: timers.clearInterval,
  });
  assertEquals(defaults.issueForDispatch("w1", "d1").expiresAtMs, 900_000);
  const short = new SessionCredentialService({
    ttlMs: 10,
    now: () => 0,
    setInterval: (cb, ms) => {
      intervals.push(ms);
      return timers.setInterval(cb, ms);
    },
    clearInterval: timers.clearInterval,
  });
  short.issueForDispatch("w1", "d2");
  assertEquals(intervals, [600_000, 1_000]);
});

Deno.test("remote secrets baseline: dispatch credential: refresh() returns null for a dispatch credential and leaves it valid", () => {
  const timers = manualIntervals();
  const sessions = new SessionCredentialService({
    now: () => 0,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  const record = sessions.issueForDispatch("w1", "d1");
  assertEquals(sessions.refresh(record.credential), null);
  assertEquals(sessions.verify(record.credential)?.dispatchId, "d1");
});

Deno.test("remote secrets baseline: dispatch credential: revokeDispatch is a no-op for another worker's id and revokes for the owner", () => {
  const timers = manualIntervals();
  const sessions = new SessionCredentialService({
    now: () => 0,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  const record = sessions.issueForDispatch("w1", "d1");
  sessions.revokeDispatch("w2", "d1");
  assertEquals(sessions.verify(record.credential)?.workerId, "w1");
  sessions.revokeDispatch("w1", "d1");
  assertEquals(sessions.verify(record.credential), null);
  assertEquals(timers.active, 0);
});

Deno.test("remote secrets baseline: dispatch credential: revokeAllForWorker revokes the worker's control and dispatch credentials only", () => {
  const timers = manualIntervals();
  const sessions = new SessionCredentialService({
    now: () => 0,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  const control = sessions.issue("w1");
  const first = sessions.issueForDispatch("w1", "d1");
  const second = sessions.issueForDispatch("w1", "d2");
  const other = sessions.issueForDispatch("w2", "d3");
  sessions.revokeAllForWorker("w1");
  assertEquals(sessions.verify(control.credential), null);
  assertEquals(sessions.verify(first.credential), null);
  assertEquals(sessions.verify(second.credential), null);
  assertEquals(sessions.verify(other.credential)?.workerId, "w2");
  assertEquals(timers.active, 1);
});

// ── Through the gateway and data plane ──────────────────────────────────

Deno.test({
  name:
    "remote secrets baseline: dispatch credential: the gateway sends a fresh credential that the data plane accepts until the dispatch succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withOrchestrator(async (o) => {
      const worker = await connectInMemoryWorker(o, "cred-success");
      const held = holdDispatches(worker);

      const step = o.dispatchService.executeRemote(stepRequest());
      await waitFor(() => held.length === 1, "the dispatch reached the worker");
      const [dispatch] = held;

      // A per-dispatch credential, distinct from the enrollment credential.
      assert(dispatch.credential.length > 0);
      assert(dispatch.credential !== worker.enrollResult.sessionCredential);
      assertEquals(o.gateway.sessions.verify(dispatch.credential), {
        workerId: "cred-success",
        dispatchId: dispatch.dispatchId,
      });
      assertEquals(
        await dataPlaneStatus(o, dispatch.credential),
        AUTHENTICATED,
      );

      dispatch.settle(SUCCESS);
      await step;

      assertEquals(o.gateway.sessions.verify(dispatch.credential), null);
      assertEquals(await dataPlaneStatus(o, dispatch.credential), REJECTED);
      // The control credential outlives the dispatch.
      assertEquals(
        await dataPlaneStatus(o, worker.enrollResult.sessionCredential),
        AUTHENTICATED,
      );
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: dispatch credential: a failed dispatch revokes its credential",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withOrchestrator(async (o) => {
      const worker = await connectInMemoryWorker(o, "cred-failed");
      const held = holdDispatches(worker);

      const step = o.dispatchService.executeRemote(stepRequest());
      await waitFor(() => held.length === 1, "the dispatch reached the worker");
      const [dispatch] = held;
      assertEquals(
        await dataPlaneStatus(o, dispatch.credential),
        AUTHENTICATED,
      );

      dispatch.settle({
        status: "error",
        error: "method failed",
        outputs: [],
        logs: [],
        durationMs: 1,
      });
      await assertRejects(() => step, Error, "method failed");

      assertEquals(await dataPlaneStatus(o, dispatch.credential), REJECTED);
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: dispatch credential: a revoked enrollment token revokes the in-flight dispatch's credential",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withOrchestrator(async (o) => {
      const worker = await connectInMemoryWorker(o, "cred-revoked");
      const held = holdDispatches(worker);

      const step = o.dispatchService.executeRemote(stepRequest());
      await waitFor(() => held.length === 1, "the dispatch reached the worker");
      const [dispatch] = held;
      assertEquals(
        await dataPlaneStatus(o, dispatch.credential),
        AUTHENTICATED,
      );

      await o.gateway.revokeToken("cred-revoked", "revoked");

      // Rejected as soon as the revoke returns, before the step settles.
      assertEquals(o.gateway.sessions.verify(dispatch.credential), null);
      assertEquals(await dataPlaneStatus(o, dispatch.credential), REJECTED);
      assertEquals(
        await dataPlaneStatus(o, worker.enrollResult.sessionCredential),
        REJECTED,
      );
      // The attempt wrote nothing, so serve re-queues the step rather than
      // failing it, and the next worker to enroll takes it.
      const next = await connectInMemoryWorker(o, "cred-revoked-next");
      const nextHeld = holdDispatches(next);
      await waitFor(
        () => nextHeld.length === 1,
        "the re-queued step reached the next worker",
      );
      assertEquals(held.length, 1);
      assert(nextHeld[0].credential !== dispatch.credential);
      nextHeld[0].settle(SUCCESS);
      await step;
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: dispatch credential: a dropped worker loses its dispatch credential at once, and the reassigned attempt gets a fresh dispatch id and credential",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withOrchestrator(async (o) => {
      const workers = [
        await connectInMemoryWorker(o, "cred-drop-a"),
        await connectInMemoryWorker(o, "cred-drop-b"),
      ];
      const held = workers.map(holdDispatches);
      const names = ["cred-drop-a", "cred-drop-b"];

      const step = o.dispatchService.executeRemote(stepRequest());
      await waitFor(
        () => held[0].length + held[1].length === 1,
        "the dispatch reached a worker",
      );
      const first = held[0].length === 1 ? 0 : 1;
      const second = 1 - first;
      const old = held[first][0];
      assertEquals(await dataPlaneStatus(o, old.credential), AUTHENTICATED);
      assert(o.dispatches.forDispatch(names[first], old.dispatchId) !== null);

      workers[first].dropSocket();

      // The gateway's dispatch ends on the closed channel and revokes the
      // credential in its finally.
      await waitFor(
        () => o.gateway.sessions.verify(old.credential) === null,
        "the dropped attempt's credential was revoked",
      );
      assertEquals(await dataPlaneStatus(o, old.credential), REJECTED);
      // The old attempt's dispatch stays registered while serve waits out
      // the dropped worker's grace window: capability verbs keyed by its
      // dispatchId still resolve, though its data-plane credential no
      // longer verifies.
      assert(o.dispatches.forDispatch(names[first], old.dispatchId) !== null);

      // The grace window expires, the attempt is unregistered and the step
      // is dispatched again, to the other worker.
      await waitFor(
        () => held[second].length === 1,
        "the step was dispatched again to the other worker",
        { timeoutMs: 15_000 },
      );
      const retry = held[second][0];
      assertEquals(
        o.dispatches.forDispatch(names[first], old.dispatchId),
        null,
      );
      assert(retry.dispatchId !== old.dispatchId);
      assert(retry.credential !== old.credential);
      assertEquals(await dataPlaneStatus(o, retry.credential), AUTHENTICATED);
      assertEquals(await dataPlaneStatus(o, old.credential), REJECTED);

      retry.settle(SUCCESS);
      await step;
      assertEquals(await dataPlaneStatus(o, retry.credential), REJECTED);
    });
  },
});

// ── Off-loopback rule and the worker's data-plane URL ───────────────────

Deno.test("remote secrets baseline: dispatch credential: an off-loopback bind needs TLS first, then an auth mode other than none", () => {
  assertThrows(
    () => assertOffLoopbackSecurity("0.0.0.0", false, "token"),
    UserError,
    "Off-loopback binding requires TLS",
  );
  assertThrows(
    () => assertOffLoopbackSecurity("10.0.0.5", false, "none"),
    UserError,
    "Off-loopback binding requires TLS",
  );
  assertThrows(
    () => assertOffLoopbackSecurity("0.0.0.0", true, "none"),
    UserError,
    "Off-loopback binding requires authentication",
  );
  assertOffLoopbackSecurity("0.0.0.0", true, "token");
  assertOffLoopbackSecurity("0.0.0.0", true, "oauth");
});

Deno.test("remote secrets baseline: dispatch credential: a loopback bind needs neither TLS nor auth", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assertOffLoopbackSecurity(host, false, "none");
  }
});

Deno.test("remote secrets baseline: dispatch credential: the worker derives a plain-HTTP data-plane URL from a non-loopback ws:// connect URL without refusing", () => {
  // The worker side does not require TLS: a ws:// connect URL to another
  // host gives an http:// data plane, over which the per-dispatch
  // credential (and any secret the runner reads) travels unencrypted.
  // Serve's own off-loopback rule above is what refuses this today.
  assertEquals(
    dataPlaneUrlFromConnectUrl("ws://orchestrator.example:9090/ws?x=1"),
    "http://orchestrator.example:9090/",
  );
  assertEquals(
    dataPlaneUrlFromConnectUrl("wss://orchestrator.example:9090/ws"),
    "https://orchestrator.example:9090/",
  );
});
