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
import { waitFor } from "@swamp-club/swamp-testing";
import { registerShutdownHandler } from "./shutdown_handlers.ts";

Deno.test({
  name:
    "registerShutdownHandler: SIGINT delivery invokes handler and dispose cleans up (POSIX)",
  // a child Deno process raises SIGINT to itself: signalling this process would
  // also wake the test runner's own SIGINT listener and tear the suite down
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const moduleUrl = new URL("./shutdown_handlers.ts", import.meta.url).href;
    const program = `
      import { registerShutdownHandler } from "${moduleUrl}";

      let invocations = 0;
      const handle = registerShutdownHandler({
        handler: () => {
          invocations++;
          // After the first SIGINT is observed, dispose and re-register
          // a fresh handler. A second SIGINT must invoke the *new*
          // handler — proving dispose() actually removed the listener.
          handle.dispose();
          const handle2 = registerShutdownHandler({
            handler: () => {
              console.log(JSON.stringify({
                phase: "second",
                first: invocations,
              }));
              handle2.dispose();
              Deno.exit(0);
            },
            includePosixSignals: false,
          });
          // Re-raise after this callback returns. Delivering a signal while
          // Deno is still dispatching the original one can fall through to
          // the default SIGINT handler during listener teardown.
          setTimeout(() => Deno.kill(Deno.pid, "SIGINT"), 0);
        },
      });

      // First signal: triggers the dispose-and-rewire flow above.
      setTimeout(() => Deno.kill(Deno.pid, "SIGINT"), 50);

      // Block forever — exit happens inside the second handler.
      await new Promise(() => {});
    `;

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(program));
    } finally {
      await writer.close();
    }

    const status = await Promise.race([
      child.status,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("child did not exit within 5s")),
          5_000,
        );
      }),
    ]);

    const stdout = new TextDecoder().decode(
      await new Response(child.stdout).arrayBuffer(),
    );
    await child.stderr.cancel();

    assertEquals(
      status.code,
      0,
      `expected child to exit 0; got ${status.code}; stdout=${stdout}`,
    );
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    assertEquals(
      last,
      '{"phase":"second","first":1}',
      `unexpected child stdout: ${stdout}`,
    );
  },
});

Deno.test({
  name:
    "registerShutdownHandler: registering on Windows does not throw on SIGTERM/SIGHUP",
  // The whole point of this helper. On Windows, naive
  // `Deno.addSignalListener("SIGTERM", ...)` throws. The helper must
  // suppress those registrations and still return a working handle.
  ignore: Deno.build.os !== "windows",
  fn: () => {
    const handle = registerShutdownHandler({
      handler: () => {},
      includePosixSignals: true,
    });
    handle.dispose();
  },
});

function fakeStopRequests() {
  const handlers: (() => void)[] = [];
  let stopped = 0;
  return {
    handlers,
    stopped: () => stopped,
    listenForStopRequests: (handler: () => void) => {
      handlers.push(handler);
      return () => {
        stopped++;
      };
    },
  };
}

Deno.test("registerShutdownHandler: listens for stop requests on Windows, and stops once on dispose", () => {
  const stopRequests = fakeStopRequests();
  let calls = 0;
  const handle = registerShutdownHandler({
    handler: () => {
      calls++;
    },
  }, {
    os: "windows",
    listenForStopRequests: stopRequests.listenForStopRequests,
  });

  assertEquals(stopRequests.handlers.length, 1);
  stopRequests.handlers[0]();
  assertEquals(calls, 1, "a stop request invokes the handler");

  handle.dispose();
  handle.dispose();
  assertEquals(stopRequests.stopped(), 1);
});

Deno.test("registerShutdownHandler: a stop request is a first signal for forceExitOnRepeat", () => {
  const stopRequests = fakeStopRequests();
  let calls = 0;
  const handle = registerShutdownHandler({
    handler: () => {
      calls++;
    },
    forceExitOnRepeat: true,
  }, {
    os: "windows",
    listenForStopRequests: stopRequests.listenForStopRequests,
  });
  try {
    stopRequests.handlers[0]();
    assertEquals(calls, 1);
  } finally {
    handle.dispose();
  }
});

Deno.test("registerShutdownHandler: SIGINT-only mode does not listen for stop requests on Windows", () => {
  const stopRequests = fakeStopRequests();
  const handle = registerShutdownHandler({
    handler: () => {},
    includePosixSignals: false,
  }, {
    os: "windows",
    listenForStopRequests: stopRequests.listenForStopRequests,
  });
  handle.dispose();

  assertEquals(stopRequests.handlers.length, 0);
});

Deno.test({
  name:
    "registerShutdownHandler: does not listen for stop requests on POSIX, where SIGTERM arrives",
  // Registers the real SIGTERM listener, which throws on Windows.
  ignore: Deno.build.os === "windows",
  fn: () => {
    const stopRequests = fakeStopRequests();
    const handle = registerShutdownHandler({ handler: () => {} }, {
      os: "linux",
      listenForStopRequests: stopRequests.listenForStopRequests,
    });
    handle.dispose();

    assertEquals(stopRequests.handlers.length, 0);
  },
});

Deno.test("registerShutdownHandler: dispose is idempotent", () => {
  const handle = registerShutdownHandler({
    handler: () => {},
    // Use the lock-release shape so this runs cleanly on every OS —
    // SIGINT is universally supported and dispose's `removeSignalListener`
    // is silent when the listener is already gone.
    includePosixSignals: false,
  });
  handle.dispose();
  handle.dispose();
});

Deno.test("registerShutdownHandler: SIGINT-only mode registers without throwing", () => {
  const handle = registerShutdownHandler({
    handler: () => {},
    includePosixSignals: false,
  });
  handle.dispose();
});

Deno.test({
  name:
    "registerShutdownHandler: forceExitOnRepeat removes listeners after first signal so second falls through (POSIX)",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const moduleUrl = new URL("./shutdown_handlers.ts", import.meta.url).href;
    const program = `
      import { registerShutdownHandler } from "${moduleUrl}";

      let handlerCalls = 0;
      registerShutdownHandler({
        handler: () => {
          handlerCalls++;
          console.log(JSON.stringify({ handlerCalls }));
        },
        forceExitOnRepeat: true,
        includePosixSignals: false,
      });

      // First SIGINT: handler fires normally.
      setTimeout(() => Deno.kill(Deno.pid, "SIGINT"), 50);

      // Second SIGINT after 150ms: forceExitOnRepeat calls
      // Deno.exit(130) immediately.
      setTimeout(() => Deno.kill(Deno.pid, "SIGINT"), 150);

      // Block forever — exit happens via Deno.exit(130) in the handler.
      await new Promise(() => {});
    `;

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(program));
    } finally {
      await writer.close();
    }

    const status = await Promise.race([
      child.status,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("child did not exit within 5s")),
          5_000,
        );
      }),
    ]);

    const stdout = new TextDecoder().decode(
      await new Response(child.stdout).arrayBuffer(),
    );
    await child.stderr.cancel();

    assertEquals(
      status.code,
      130,
      `expected child to exit 130 (default SIGINT); got ${status.code}; stdout=${stdout}`,
    );

    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    assertEquals(
      lines.length,
      1,
      `handler should fire exactly once: ${stdout}`,
    );
    assertEquals(
      lines[0],
      '{"handlerCalls":1}',
      `unexpected handler output: ${stdout}`,
    );
  },
});

function pendingWrites(count: number) {
  const done = Promise.withResolvers<void>();
  let size = count;
  return {
    get size() {
      return size;
    },
    settled: 0,
    settle(_waitMs: number): Promise<number> {
      this.settled++;
      return done.promise.then(() => size = 0);
    },
    finish: () => done.resolve(),
  };
}

Deno.test("registerShutdownHandler: a second signal waits for started data writes before exiting 130", async () => {
  const stopRequests = fakeStopRequests();
  const exits: number[] = [];
  const writes = pendingWrites(2);
  const handle = registerShutdownHandler({
    handler: () => {},
    forceExitOnRepeat: true,
    dataWrites: writes,
  }, {
    os: "windows",
    listenForStopRequests: stopRequests.listenForStopRequests,
    exit: (code) => exits.push(code),
  });
  try {
    stopRequests.handlers[0]();
    stopRequests.handlers[0]();
    assertEquals(writes.settled, 1);
    assertEquals(exits, []);
    writes.finish();
    await waitFor(() => exits.length === 1, "the delayed exit");
    assertEquals(exits, [130]);
  } finally {
    handle.dispose();
  }
});

Deno.test("registerShutdownHandler: a third signal exits 130 without waiting for data writes", () => {
  const stopRequests = fakeStopRequests();
  const exits: number[] = [];
  const writes = pendingWrites(1);
  const handle = registerShutdownHandler({
    handler: () => {},
    forceExitOnRepeat: true,
    dataWrites: writes,
  }, {
    os: "windows",
    listenForStopRequests: stopRequests.listenForStopRequests,
    exit: (code) => exits.push(code),
  });
  try {
    stopRequests.handlers[0]();
    stopRequests.handlers[0]();
    stopRequests.handlers[0]();
    assertEquals(exits, [130]);
  } finally {
    writes.finish();
    handle.dispose();
  }
});

Deno.test("registerShutdownHandler: a second signal with no data write in flight exits 130 at once", () => {
  const stopRequests = fakeStopRequests();
  const exits: number[] = [];
  const writes = pendingWrites(0);
  const handle = registerShutdownHandler({
    handler: () => {},
    forceExitOnRepeat: true,
    dataWrites: writes,
  }, {
    os: "windows",
    listenForStopRequests: stopRequests.listenForStopRequests,
    exit: (code) => exits.push(code),
  });
  try {
    stopRequests.handlers[0]();
    stopRequests.handlers[0]();
    assertEquals(exits, [130]);
    assertEquals(writes.settled, 0);
  } finally {
    handle.dispose();
  }
});

Deno.test("registerShutdownHandler: a second signal releases through beforeForceExit after the data-write wait, then exits 130", async () => {
  const stopRequests = fakeStopRequests();
  const order: string[] = [];
  const writes = pendingWrites(1);
  const handle = registerShutdownHandler({
    handler: () => {},
    forceExitOnRepeat: true,
    dataWrites: writes,
    beforeForceExit: () => {
      order.push("release");
      return Promise.resolve();
    },
  }, {
    os: "windows",
    listenForStopRequests: stopRequests.listenForStopRequests,
    exit: (code) => order.push(`exit ${code}`),
  });
  try {
    stopRequests.handlers[0]();
    stopRequests.handlers[0]();
    assertEquals(order, []);
    writes.finish();
    await waitFor(() => order.length === 2, "the release and the exit");
    assertEquals(order, ["release", "exit 130"]);
  } finally {
    handle.dispose();
  }
});
