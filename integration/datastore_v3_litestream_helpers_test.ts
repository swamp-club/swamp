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
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import {
  killSidecarAtTeardown,
  runThenTearDown,
  type SidecarProbe,
  type SidecarState,
  stopSidecarsAtTeardown,
} from "./datastore_v3_litestream_helpers.ts";

function withSignalGroup(
  signalGroup: typeof hostLitestreamProcesses.signalGroup,
  fn: (sent: string[]) => void,
): void {
  const original = hostLitestreamProcesses.signalGroup;
  const originalSignal = hostLitestreamProcesses.signal;
  const sent: string[] = [];
  Object.assign(hostLitestreamProcesses, {
    signal: (pid: number, signal: Deno.Signal) => sent.push(`${signal} ${pid}`),
    signalGroup: (pgid: number, signal: Deno.Signal) => {
      sent.push(`${signal} -${pgid}`);
      signalGroup(pgid, signal);
    },
  });
  try {
    fn(sent);
  } finally {
    Object.assign(hostLitestreamProcesses, {
      signal: originalSignal,
      signalGroup: original,
    });
  }
}

Deno.test("killSidecarAtTeardown: a group that already exited (EPERM on macOS) is not a teardown failure (swamp-club#4148)", () => {
  withSignalGroup(() => {
    throw new Deno.errors.PermissionDenied("EPERM: Operation not permitted");
  }, (sent) => {
    killSidecarAtTeardown(4242);
    assertEquals(sent, ["SIGCONT 4242", "SIGKILL -4242"]);
  });
});

Deno.test("killSidecarAtTeardown: any other failure still fails the teardown", () => {
  withSignalGroup(() => {
    throw new Error("unexpected");
  }, () => {
    assertThrows(() => killSidecarAtTeardown(4242), Error, "unexpected");
  });
});

function probeOf(
  states: Record<number, SidecarState>,
  killed: number[] = [],
): SidecarProbe {
  return {
    kill: (pid) => killed.push(pid),
    state: (pid) => states[pid],
    commandLine: (pid) => Promise.resolve(`litestream replicate ${pid}`),
    timeoutMs: 50,
  };
}

Deno.test("stopSidecarsAtTeardown: kills every pid and counts a gone or zombie sidecar as stopped", async () => {
  const killed: number[] = [];
  await stopSidecarsAtTeardown(
    [11, 12],
    probeOf({ 11: "gone", 12: "zombie" }, killed),
  );
  assertEquals(killed, [11, 12]);
});

Deno.test("stopSidecarsAtTeardown: a sidecar still running names its pid, state and command line", async () => {
  const error = await assertRejects(
    () =>
      stopSidecarsAtTeardown(
        [11, 12, 13],
        probeOf({ 11: "gone", 12: "running", 13: "unknown" }),
      ),
    Error,
  );
  assertStringIncludes(error.message, "every sidecar to stop");
  assertStringIncludes(
    error.message,
    "still running: 12 running: litestream replicate 12; 13 unknown: litestream replicate 13",
  );
});

Deno.test("stopSidecarsAtTeardown: a sidecar that stops while it is waited for is not a failure", async () => {
  let checks = 0;
  await stopSidecarsAtTeardown([11], {
    ...probeOf({}),
    state: () => ++checks < 3 ? "running" : "gone",
  });
});

Deno.test("runThenTearDown: returns the body's result after the teardown runs", async () => {
  const ran: string[] = [];
  const result = await runThenTearDown(
    () => {
      ran.push("body");
      return Promise.resolve(7);
    },
    () => {
      ran.push("teardown");
      return Promise.resolve();
    },
  );
  assertEquals([result, ran], [7, ["body", "teardown"]]);
});

Deno.test("runThenTearDown: a body failure is rethrown unchanged once the teardown has run", async () => {
  const bodyError = new Error("body failed");
  let tornDown = false;
  const error = await assertRejects(() =>
    runThenTearDown(() => Promise.reject(bodyError), () => {
      tornDown = true;
      return Promise.resolve();
    })
  );
  assertStrictEquals(error, bodyError);
  assertEquals(tornDown, true);
});

Deno.test("runThenTearDown: a teardown failure after a passing body is thrown", async () => {
  const teardownError = new Error("teardown failed");
  const error = await assertRejects(() =>
    runThenTearDown(
      () => Promise.resolve(),
      () => Promise.reject(teardownError),
    )
  );
  assertStrictEquals(error, teardownError);
});

Deno.test("runThenTearDown: when both fail the body's failure leads and the teardown's is kept", async () => {
  const bodyError = new Error("body failed");
  const teardownError = new Error("teardown failed");
  const error = await assertRejects(
    () =>
      runThenTearDown(
        () => Promise.reject(bodyError),
        () => Promise.reject(teardownError),
      ),
    Error,
  );
  assertEquals(
    error.message,
    "body failed (teardown also failed: teardown failed)",
  );
  assertInstanceOf(error.cause, AggregateError);
  assertEquals(error.cause.errors, [bodyError, teardownError]);
});

Deno.test("runThenTearDown: a body that throws a non-Error still leads when the teardown fails", async () => {
  const error = await assertRejects(
    () =>
      runThenTearDown(
        () => Promise.reject("plain string"),
        () => Promise.reject(new Error("teardown failed")),
      ),
    Error,
  );
  assertEquals(
    error.message,
    "plain string (teardown also failed: teardown failed)",
  );
});
