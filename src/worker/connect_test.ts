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
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  releaseWorkerCacheDir,
  runWorker,
  type WorkerStatusEvent,
} from "./connect.ts";
import {
  ChannelClosedError,
  RpcChannel,
  RpcError,
} from "../domain/remote/rpc_channel.ts";
import { AuthGateBlockedError } from "../domain/auth/auth_gate_blocked_error.ts";
import {
  type EnrollParams,
  GATE_PASS_UNAVAILABLE,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  WorkerMethod,
} from "../domain/remote/protocol.ts";

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly orchestrator: RpcChannel;
  #closed = false;

  constructor(
    configure: (channel: RpcChannel, socket: FakeSocket) => void,
  ) {
    this.orchestrator = new RpcChannel({
      send: (data) =>
        void Promise.resolve().then(() => this.onmessage?.({ data })),
    });
    configure(this.orchestrator, this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    void Promise.resolve().then(() => this.orchestrator.handleRaw(data));
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.orchestrator.close();
    queueMicrotask(() => this.onclose?.());
  }

  drop(): void {
    this.close();
  }
}

function enrollResult(workerId: string) {
  return {
    workerId,
    sessionCredential: "cred-1",
    sessionExpiresAtMs: Date.now() + 60_000,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
  };
}

Deno.test("runWorker: connects, enrolls, and reports status", async () => {
  const events: WorkerStatusEvent[] = [];
  const enrollments: EnrollParams[] = [];
  const controller = new AbortController();
  let socket: FakeSocket | null = null;

  const done = runWorker({
    url: "ws://test:1",
    token: "ci-runner-3.s3cret",
    labels: { region: "us-east" },
    swampVersion: "1.2.3",
    reconnect: false,
    signal: controller.signal,
    onStatus: (event) => {
      events.push(event);
      if (event.kind === "enrolled") {
        queueMicrotask(() => socket!.drop());
      }
    },
    createSocket: () => {
      socket = new FakeSocket((channel) => {
        channel.register(RemoteMethod.enroll, (params) => {
          enrollments.push(params as EnrollParams);
          return Promise.resolve(enrollResult("ci-runner-3"));
        });
      });
      return socket as unknown as WebSocket;
    },
  });

  await done;
  assertEquals(enrollments.length, 1);
  assertEquals(enrollments[0].token, "ci-runner-3.s3cret");
  assertEquals(enrollments[0].labels, { region: "us-east" });
  assertEquals(enrollments[0].protocolVersion, REMOTE_PROTOCOL_VERSION);
  assertEquals(typeof enrollments[0].instanceUuid, "string");
  assertEquals(typeof enrollments[0].machineId, "string");
  const kinds = events.map((e) => e.kind);
  assertEquals(kinds.includes("enrolled"), true);
  assertEquals(kinds.at(-1), "stopped");
});

Deno.test("runWorker: a drain announces itself to the orchestrator before the connection closes (swamp-club#3156)", async () => {
  const order: string[] = [];
  let requestDrain: ((reason: "signal") => void) | null = null;

  const result = await runWorker({
    url: "ws://test:1",
    token: "ci-runner-3.s3cret",
    labels: {},
    swampVersion: "1.2.3",
    onDrainAvailable: (drain) => {
      requestDrain = drain;
    },
    onStatus: (event) => {
      if (event.kind === "enrolled") {
        queueMicrotask(() => requestDrain!("signal"));
      }
    },
    createSocket: () => {
      const socket = new FakeSocket((channel) => {
        channel.register(
          RemoteMethod.enroll,
          () => Promise.resolve(enrollResult("ci-runner-3")),
        );
        channel.register(RemoteMethod.drain, () => {
          order.push("drain");
          return Promise.resolve();
        });
      });
      const close = socket.close.bind(socket);
      socket.close = () => {
        order.push("close");
        close();
      };
      return socket as unknown as WebSocket;
    },
  });

  assertEquals(result.reason, "signal");
  assertEquals(order.slice(0, 3), ["drain", "drain", "close"]);
});

Deno.test("runWorker: a drain waits for the orchestrator to answer a second call before closing (swamp-club#3156)", async () => {
  let requestDrain: ((reason: "signal") => void) | null = null;
  let drainCalls = 0;
  let closed = false;
  const confirm = Promise.withResolvers<void>();

  const done = runWorker({
    url: "ws://test:1",
    token: "ci-runner-3.s3cret",
    labels: {},
    swampVersion: "1.2.3",
    onDrainAvailable: (drain) => {
      requestDrain = drain;
    },
    onStatus: (event) => {
      if (event.kind === "enrolled") {
        queueMicrotask(() => requestDrain!("signal"));
      }
    },
    createSocket: () => {
      const socket = new FakeSocket((channel) => {
        channel.register(
          RemoteMethod.enroll,
          () => Promise.resolve(enrollResult("ci-runner-3")),
        );
        // The announcement is answered at once; the call the worker makes
        // after its work has ended is held open.
        channel.register(RemoteMethod.drain, () => {
          drainCalls++;
          return drainCalls === 1 ? Promise.resolve() : confirm.promise;
        });
      });
      const close = socket.close.bind(socket);
      socket.close = () => {
        closed = true;
        close();
      };
      return socket as unknown as WebSocket;
    },
  });

  await waitFor(() => drainCalls === 2, "second worker.drain call");
  assertEquals(closed, false);
  confirm.resolve();

  assertEquals((await done).reason, "signal");
  assertEquals(closed, true);
});

Deno.test("runWorker: a drain the orchestrator does not acknowledge still stops the worker", async () => {
  let requestDrain: ((reason: "signal") => void) | null = null;

  const result = await runWorker({
    url: "ws://test:1",
    token: "ci-runner-3.s3cret",
    labels: {},
    swampVersion: "1.2.3",
    onDrainAvailable: (drain) => {
      requestDrain = drain;
    },
    onStatus: (event) => {
      if (event.kind === "enrolled") {
        queueMicrotask(() => requestDrain!("signal"));
      }
    },
    createSocket: () =>
      new FakeSocket((channel) => {
        channel.register(
          RemoteMethod.enroll,
          () => Promise.resolve(enrollResult("ci-runner-3")),
        );
        channel.register(
          RemoteMethod.drain,
          () => Promise.reject(new RpcError({ code: "boom", message: "no" })),
        );
      }) as unknown as WebSocket,
  });

  assertEquals(result.reason, "signal");
});

Deno.test("runWorker: reconnects with the same instance uuid after a drop", async () => {
  const enrollments: EnrollParams[] = [];
  const sockets: FakeSocket[] = [];
  const controller = new AbortController();

  const done = runWorker({
    url: "ws://test:1",
    token: "ci.s",
    swampVersion: "1.2.3",
    signal: controller.signal,
    onStatus: (event) => {
      if (event.kind === "enrolled" && enrollments.length === 1) {
        queueMicrotask(() => sockets[0].drop());
      }
      if (event.kind === "enrolled" && enrollments.length === 2) {
        controller.abort();
        queueMicrotask(() => sockets[1].drop());
      }
    },
    createSocket: () => {
      const socket = new FakeSocket((channel) => {
        channel.register(RemoteMethod.enroll, (params) => {
          enrollments.push(params as EnrollParams);
          return Promise.resolve(enrollResult("ci"));
        });
      });
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });

  await done;
  assertEquals(enrollments.length, 2);
  assertEquals(enrollments[0].instanceUuid, enrollments[1].instanceUuid);
  assertEquals(enrollments[0].machineId, enrollments[1].machineId);
});

Deno.test("runWorker: a stable cache directory keeps the machine id across restarts", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "swamp-worker-test-" });
  try {
    const enrollments: EnrollParams[] = [];
    const runOnce = () => {
      let socket: FakeSocket | null = null;
      return runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        reconnect: false,
        cacheDir,
        onStatus: (event) => {
          if (event.kind === "enrolled") {
            queueMicrotask(() => socket!.drop());
          }
        },
        createSocket: () => {
          socket = new FakeSocket((channel) => {
            channel.register(RemoteMethod.enroll, (params) => {
              enrollments.push(params as EnrollParams);
              return Promise.resolve(enrollResult("ci"));
            });
          });
          return socket as unknown as WebSocket;
        },
      });
    };

    await runOnce();
    await runOnce();
    assertEquals(enrollments.length, 2);
    assertEquals(enrollments[0].machineId, enrollments[1].machineId);
    assertEquals(
      enrollments[0].instanceUuid === enrollments[1].instanceUuid,
      false,
    );
    await Deno.stat(join(cacheDir, "machine-id"));
  } finally {
    await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("releaseWorkerCacheDir: removes the worker's own cache once no dispatch is running (swamp-club#3854)", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "swamp-worker-test-" });
  try {
    await Deno.mkdir(join(cacheDir, "bundles"));
    await releaseWorkerCacheDir(cacheDir, 0);
    assertEquals(await exists(cacheDir), false);
  } finally {
    await Deno.remove(cacheDir, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
});

Deno.test("releaseWorkerCacheDir: keeps the cache while a dispatch is still running from it (swamp-club#3854)", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "swamp-worker-test-" });
  try {
    await releaseWorkerCacheDir(cacheDir, 1);
    assertEquals(await exists(cacheDir), true);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

class RejectingSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: CloseEvent | Event | undefined) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly errorMessage?: string) {
    queueMicrotask(() => {
      if (this.errorMessage) {
        const event = new ErrorEvent("error", {
          message: this.errorMessage,
        });
        this.onerror?.(event);
      }
      this.onclose?.(undefined);
    });
  }

  send(_data: string): void {}
  close(): void {}
}

const restarting = () => Promise.resolve(true);

function fakeClock() {
  const clock = {
    nowMs: 0,
    sleeps: [] as number[],
    now: () => clock.nowMs,
    sleep: (ms: number) => {
      clock.sleeps.push(ms);
      clock.nowMs += ms;
      return Promise.resolve();
    },
  };
  return clock;
}

Deno.test("runWorker: pre-enrollment failures give up once the retry budget is spent", async () => {
  const events: WorkerStatusEvent[] = [];
  const clock = fakeClock();
  let socketCount = 0;
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        preEnrollRetryBudgetMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
        isServeRestarting: restarting,
        onStatus: (event) => events.push(event),
        createSocket: () => {
          socketCount++;
          return new RejectingSocket() as unknown as WebSocket;
        },
      }),
    Error,
  );
  assertStringIncludes(
    error.message,
    "connection failed before enrollment for 10s — giving up",
  );
  assertEquals(clock.sleeps, [1_000, 2_000, 4_000, 3_000]);
  assertEquals(socketCount, 5);
  assertEquals(events.at(-1)?.kind, "stopped");
});

Deno.test("runWorker: HTTP 401 stops after 3 consecutive attempts", async () => {
  const events: WorkerStatusEvent[] = [];
  const clock = fakeClock();
  let socketCount = 0;
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        now: clock.now,
        sleep: clock.sleep,
        onStatus: (event) => events.push(event),
        createSocket: () => {
          socketCount++;
          return new RejectingSocket(
            "failed to connect to WebSocket: Invalid status code: 401",
          ) as unknown as WebSocket;
        },
      }),
    Error,
  );
  assertStringIncludes(
    error.message,
    "connection failed 3 consecutive times before enrollment — giving up",
  );
  assertStringIncludes(error.message, "401");
  assertEquals(socketCount, 3);
  assertEquals(clock.sleeps, [1_000, 2_000]);
  assertEquals(events.at(-1)?.kind, "stopped");
});

Deno.test("runWorker: a failure serve is not restarting, such as a DNS failure, stops after 3 consecutive attempts", async () => {
  const clock = fakeClock();
  const probed: string[] = [];
  let socketCount = 0;
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        now: clock.now,
        sleep: clock.sleep,
        isServeRestarting: (failure) => {
          probed.push(failure);
          return Promise.resolve(false);
        },
        createSocket: () => {
          socketCount++;
          return new RejectingSocket(
            "NetworkError: failed to connect to WebSocket: dns error",
          ) as unknown as WebSocket;
        },
      }),
    Error,
  );
  assertStringIncludes(error.message, "3 consecutive times");
  assertStringIncludes(error.message, "dns error");
  assertEquals(socketCount, 3);
  assertEquals(probed.length, 3);
  assertStringIncludes(probed[0], "dns error");
});

Deno.test("runWorker: a 503 at the upgrade retries until the retry budget is spent", async () => {
  const clock = fakeClock();
  let socketCount = 0;
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        preEnrollRetryBudgetMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
        createSocket: () => {
          socketCount++;
          return new RejectingSocket(
            "failed to connect to WebSocket: Invalid status code: 503",
          ) as unknown as WebSocket;
        },
      }),
    Error,
  );
  assertStringIncludes(error.message, "for 10s — giving up");
  assertStringIncludes(error.message, "503");
  assertEquals(socketCount, 5);
});

Deno.test("runWorker: the default retry budget names minutes when it gives up", async () => {
  const clock = fakeClock();
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        now: clock.now,
        sleep: clock.sleep,
        isServeRestarting: restarting,
        createSocket: () => new RejectingSocket() as unknown as WebSocket,
      }),
    Error,
  );
  assertStringIncludes(
    error.message,
    "connection failed before enrollment for 5m0s — giving up",
  );
  assertEquals(Math.max(...clock.sleeps), 30_000);
});

Deno.test("runWorker: an enrolled worker rides out a serve restart longer than a few seconds", async () => {
  const events: WorkerStatusEvent[] = [];
  const clock = fakeClock();
  const controller = new AbortController();
  const sockets: FakeSocket[] = [];
  let socketCount = 0;
  let enrolled = 0;

  const done = runWorker({
    url: "ws://test:1",
    token: "ci.s",
    swampVersion: "1.2.3",
    signal: controller.signal,
    now: clock.now,
    sleep: clock.sleep,
    isServeRestarting: restarting,
    onStatus: (event) => {
      events.push(event);
      if (event.kind !== "enrolled") return;
      enrolled++;
      const socket = sockets.at(-1)!;
      if (enrolled === 2) controller.abort();
      queueMicrotask(() => socket.drop());
    },
    createSocket: () => {
      socketCount++;
      if (socketCount > 1 && socketCount < 8) {
        return new RejectingSocket() as unknown as WebSocket;
      }
      const socket = new FakeSocket((channel) => {
        channel.register(
          RemoteMethod.enroll,
          () => Promise.resolve(enrollResult("ci")),
        );
      });
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });

  const result = await done;
  assertEquals(result.reason, "shutdown");
  assertEquals(enrolled, 2);
  assertEquals(socketCount, 8);
  assertEquals(clock.sleeps, [
    1_000,
    2_000,
    4_000,
    8_000,
    16_000,
    30_000,
    30_000,
  ]);
});

Deno.test("runWorker: 'does not exist' enrollment failure stops immediately", async () => {
  const events: WorkerStatusEvent[] = [];
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "dead.token",
        swampVersion: "1.2.3",
        onStatus: (event) => events.push(event),
        createSocket: () =>
          new FakeSocket((channel) => {
            channel.register(RemoteMethod.enroll, () =>
              Promise.reject(
                new RpcError({
                  code: "invalid_token",
                  message: "Enrollment token 'dead' does not exist",
                }),
              ));
          }) as unknown as WebSocket,
      }),
    Error,
  );
  assertStringIncludes(error.message, "does not exist");
  assertEquals(events.at(-1)?.kind, "stopped");
});

Deno.test("runWorker: the retry budget restarts after a successful enrollment", async () => {
  const events: WorkerStatusEvent[] = [];
  const clock = fakeClock();
  const controller = new AbortController();
  const sockets: FakeSocket[] = [];
  let socketCount = 0;
  let enrolled = 0;

  const done = runWorker({
    url: "ws://test:1",
    token: "ci.s",
    swampVersion: "1.2.3",
    signal: controller.signal,
    preEnrollRetryBudgetMs: 10_000,
    now: clock.now,
    sleep: clock.sleep,
    isServeRestarting: restarting,
    onStatus: (event) => {
      events.push(event);
      if (event.kind !== "enrolled") return;
      enrolled++;
      const socket = sockets.at(-1)!;
      if (enrolled === 2) controller.abort();
      queueMicrotask(() => socket.drop());
    },
    createSocket: () => {
      socketCount++;
      if (socketCount !== 5 && socketCount !== 9) {
        return new RejectingSocket() as unknown as WebSocket;
      }
      const socket = new FakeSocket((channel) => {
        channel.register(
          RemoteMethod.enroll,
          () => Promise.resolve(enrollResult("ci")),
        );
      });
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });

  // without the reset, the refusal after the drop exhausts the budget
  await done;
  assertEquals(socketCount, 9);
  assertEquals(enrolled, 2);
  const kinds = events.map((e) => e.kind);
  assertEquals(kinds.at(-1), "stopped");
});

Deno.test("runWorker: permanent enrollment failures stop the loop", async () => {
  const events: WorkerStatusEvent[] = [];
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "dead.token",
        swampVersion: "1.2.3",
        onStatus: (event) => events.push(event),
        createSocket: () =>
          new FakeSocket((channel) => {
            channel.register(RemoteMethod.enroll, () =>
              Promise.reject(
                new RpcError({
                  code: "invalid_token",
                  message: "Enrollment token 'dead' has been revoked",
                }),
              ));
          }) as unknown as WebSocket,
      }),
    Error,
  );
  assertStringIncludes(error.message, "revoked");
  assertEquals(events.at(-1)?.kind, "stopped");
});

function rejectingEnroll(error: Error): WebSocket {
  return new FakeSocket((channel) => {
    channel.register(RemoteMethod.enroll, () => Promise.reject(error));
  }) as unknown as WebSocket;
}

Deno.test("runWorker: a coded permanent rejection stops the loop", async () => {
  const events: WorkerStatusEvent[] = [];
  await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        onStatus: (event) => events.push(event),
        createSocket: () =>
          rejectingEnroll(
            new RpcError({
              code: "token_revoked",
              message: "Enrollment token 'ci' has been revoked",
            }),
          ),
      }),
    Error,
  );
  assertEquals(events.at(-1)?.kind, "stopped");
});

Deno.test("runWorker: a token name that reads like a reason does not make a retryable rejection permanent", async () => {
  for (
    const error of [
      new RpcError({
        code: "token_unreadable",
        message:
          "Enrollment token 'expired-runners' could not be read after redemption; retry the connection",
      }),
      new RpcError({
        code: "handler_failed",
        message:
          "Enrollment token 'revoked-fleet' could not be read after redemption",
      }),
    ]
  ) {
    const events: WorkerStatusEvent[] = [];
    const controller = new AbortController();
    await runWorker({
      url: "ws://test:1",
      token: "expired-runners.s",
      swampVersion: "1.2.3",
      signal: controller.signal,
      onStatus: (event) => {
        events.push(event);
        if (event.kind === "retrying") controller.abort();
      },
      createSocket: () => rejectingEnroll(error),
    });
    assertEquals(events.some((e) => e.kind === "retrying"), true);
  }
});

Deno.test("runWorker: an uncoded revoke from an older orchestrator still stops the loop", async () => {
  const events: WorkerStatusEvent[] = [];
  await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        onStatus: (event) => events.push(event),
        createSocket: () =>
          rejectingEnroll(
            new RpcError({
              code: "handler_failed",
              message: "Enrollment token 'ci' has been revoked",
            }),
          ),
      }),
    Error,
  );
  assertEquals(events.at(-1)?.kind, "stopped");
});

Deno.test("runWorker: a worker that passes the gate itself asks for no pass", async () => {
  const enrollments: EnrollParams[] = [];
  let socket: FakeSocket | null = null;
  await runWorker({
    url: "ws://test:1",
    token: "ci.s",
    swampVersion: "1.2.3",
    reconnect: false,
    onStatus: (event) => {
      if (event.kind === "enrolled") queueMicrotask(() => socket!.drop());
    },
    createSocket: () => {
      socket = new FakeSocket((channel) => {
        channel.register(RemoteMethod.enroll, (params) => {
          enrollments.push(params as EnrollParams);
          return Promise.resolve(enrollResult("ci"));
        });
      });
      return socket as unknown as WebSocket;
    },
  });
  assertEquals("needsGatePass" in enrollments[0], false);
});

Deno.test("runWorker: a worker without a credential is admitted on the orchestrator's pass once", async () => {
  const enrollments: EnrollParams[] = [];
  const admitted: (string | undefined)[] = [];
  const order: string[] = [];
  const sockets: FakeSocket[] = [];
  const controller = new AbortController();

  await runWorker({
    url: "ws://test:1",
    token: "ci.s",
    swampVersion: "1.2.3",
    signal: controller.signal,
    admitGatePass: (pass) => {
      admitted.push(pass);
      order.push("admitted");
      return Promise.resolve();
    },
    onStatus: (event) => {
      if (event.kind !== "enrolled") return;
      order.push("enrolled");
      if (enrollments.length === 1) {
        queueMicrotask(() => sockets[0].drop());
      } else {
        controller.abort();
        queueMicrotask(() => sockets[1].drop());
      }
    },
    createSocket: () => {
      const socket = new FakeSocket((channel) => {
        channel.register(RemoteMethod.enroll, (params) => {
          enrollments.push(params as EnrollParams);
          return Promise.resolve({
            ...enrollResult("ci"),
            gatePass: "cHJvb2Y.c2ln",
          });
        });
      });
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });

  assertEquals(enrollments.length, 2);
  assertEquals(enrollments[0].needsGatePass, true);
  assertEquals("needsGatePass" in enrollments[1], false);
  assertEquals(admitted, ["cHJvb2Y.c2ln"]);
  assertEquals(order, ["admitted", "enrolled", "enrolled"]);
});

Deno.test("runWorker: a worker the gate blocks at enrollment stops with the gate's error", async () => {
  const events: WorkerStatusEvent[] = [];
  let attempts = 0;
  const blocked = new AuthGateBlockedError(
    { kind: "no_credential" },
    "not vouched for",
  );
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        admitGatePass: () => Promise.reject(blocked),
        onStatus: (event) => events.push(event),
        createSocket: () => {
          attempts++;
          return new FakeSocket((channel) => {
            channel.register(
              RemoteMethod.enroll,
              () => Promise.resolve(enrollResult("ci")),
            );
          }) as unknown as WebSocket;
        },
      }),
    AuthGateBlockedError,
  );
  assertEquals(error, blocked);
  assertEquals(attempts, 1);
  assertEquals(events.some((e) => e.kind === "enrolled"), false);
  assertEquals(events.at(-1)?.kind, "stopped");
});

Deno.test("runWorker: an orchestrator with no pass to give stops the worker with the gate's error", async () => {
  const admitted: [string | undefined, boolean | undefined][] = [];
  await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        admitGatePass: (pass, serveRefused) => {
          admitted.push([pass, serveRefused]);
          return Promise.reject(
            new AuthGateBlockedError({ kind: "no_credential" }, "no pass"),
          );
        },
        createSocket: () =>
          rejectingEnroll(
            new RpcError({
              code: GATE_PASS_UNAVAILABLE,
              message: "no pass to give",
            }),
          ),
      }),
    AuthGateBlockedError,
    "no pass",
  );
  assertEquals(admitted, [[undefined, true]]);
});

Deno.test("runWorker: admission that settles after the socket closed does not report enrollment", async () => {
  const events: WorkerStatusEvent[] = [];
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => release = resolve);
  let admitCalled: () => void = () => {};
  const admitSeen = new Promise<void>((resolve) => admitCalled = resolve);
  let socket: FakeSocket | null = null;

  const done = runWorker({
    url: "ws://test:1",
    token: "ci.s",
    swampVersion: "1.2.3",
    reconnect: false,
    admitGatePass: () => {
      admitCalled();
      return pending;
    },
    onStatus: (event) => events.push(event),
    createSocket: () => {
      socket = new FakeSocket((channel) => {
        channel.register(
          RemoteMethod.enroll,
          () => Promise.resolve(enrollResult("ci")),
        );
      });
      return socket as unknown as WebSocket;
    },
  });

  await admitSeen;
  socket!.drop();
  await done.catch(() => {});
  release();
  await pending;
  // One macrotask turn drains every microtask the admission chain queues.
  // waitFor cannot express this: the assertion is that nothing happens.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assertEquals(events.some((e) => e.kind === "enrolled"), false);
});

Deno.test("runWorker: a reconnect while admission is pending shares the check", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => release = resolve);
  let admitCalls = 0;
  let enrollCount = 0;
  const sockets: FakeSocket[] = [];
  const controller = new AbortController();
  let secondEnroll: () => void = () => {};
  const secondEnrollSeen = new Promise<void>((r) => secondEnroll = r);
  let firstAdmit: () => void = () => {};
  const firstAdmitSeen = new Promise<void>((r) => firstAdmit = r);

  const done = runWorker({
    url: "ws://test:1",
    token: "ci.s",
    swampVersion: "1.2.3",
    signal: controller.signal,
    admitGatePass: () => {
      admitCalls++;
      firstAdmit();
      return pending;
    },
    onStatus: (event) => {
      if (event.kind === "enrolled") {
        controller.abort();
        queueMicrotask(() => sockets.at(-1)!.drop());
      }
    },
    createSocket: () => {
      const socket = new FakeSocket((channel) => {
        channel.register(RemoteMethod.enroll, () => {
          enrollCount++;
          if (enrollCount === 2) secondEnroll();
          return Promise.resolve({
            ...enrollResult("ci"),
            gatePass: "cHJvb2Y.c2ln",
          });
        });
      });
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });

  await firstAdmitSeen;
  sockets[0].drop();
  await secondEnrollSeen;
  // Let the second enrolled reply arrive while the first check still runs.
  // waitFor cannot express this: the assertion is that no second check starts.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  release();
  await done;
  assertEquals(admitCalls, 1);
});

// The orchestrator lists a worker as idle before its enroll reply arrives, so
// a dispatch can reach the worker first. Empty params fail at parsing, which
// shows whether the dispatch got past admission.
function earlyDispatchSocket(
  onAnswer: (outcome: unknown) => void,
  enroll: () => Promise<unknown>,
): FakeSocket {
  return new FakeSocket((channel) => {
    channel.register(RemoteMethod.enroll, () => {
      channel.call(WorkerMethod.dispatch, {}).then(onAnswer, onAnswer);
      return enroll();
    });
  });
}

function codeOf(outcome: unknown): string | undefined {
  return outcome instanceof RpcError ? outcome.code : undefined;
}

Deno.test("runWorker: a dispatch sent before the enroll reply waits for enrollment instead of failing as an unknown method", async () => {
  const order: string[] = [];
  let outcome: unknown;
  let answered = false;
  let socket: FakeSocket | null = null;

  const done = runWorker({
    url: "ws://test:1",
    token: "ci.s",
    swampVersion: "1.2.3",
    reconnect: false,
    onStatus: (event) => {
      if (event.kind === "enrolled") order.push("enrolled");
    },
    createSocket: () => {
      socket = earlyDispatchSocket((result) => {
        outcome = result;
        answered = true;
        order.push("dispatch answered");
      }, () => Promise.resolve(enrollResult("ci")));
      return socket as unknown as WebSocket;
    },
  });

  await waitFor(() => answered, "early dispatch answered");
  socket!.drop();
  await done;
  assertEquals(codeOf(outcome), "handler_failed");
  assertEquals(order, ["enrolled", "dispatch answered"]);
});

Deno.test("runWorker: a dispatch sent before a refused enroll reply is never run", async () => {
  let outcome: unknown;
  let answered = false;

  await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        createSocket: () =>
          earlyDispatchSocket((result) => {
            outcome = result;
            answered = true;
          }, () =>
            Promise.reject(
              new RpcError({
                code: "token_revoked",
                message: "Enrollment token 'ci' has been revoked",
              }),
            )) as unknown as WebSocket,
      }),
    Error,
    "revoked",
  );

  await waitFor(() => answered, "early dispatch answered");
  // the worker drops the connection as it stops, so serve gets no step result
  assertInstanceOf(outcome, ChannelClosedError);
});

Deno.test("runWorker: a dispatch sent before the enroll reply is never run when the gate refuses the worker", async () => {
  let outcome: unknown;
  let answered = false;
  const blocked = new AuthGateBlockedError(
    { kind: "no_credential" },
    "not vouched for",
  );

  await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        admitGatePass: () => Promise.reject(blocked),
        createSocket: () =>
          earlyDispatchSocket((result) => {
            outcome = result;
            answered = true;
          }, () => Promise.resolve(enrollResult("ci"))) as unknown as WebSocket,
      }),
    AuthGateBlockedError,
  );

  await waitFor(() => answered, "early dispatch answered");
  // the worker drops the connection as it stops, so serve gets no step result
  assertInstanceOf(outcome, ChannelClosedError);
});
