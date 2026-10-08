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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { runWorker, type WorkerStatusEvent } from "./connect.ts";
import { RpcChannel, RpcError } from "../domain/remote/rpc_channel.ts";
import { AuthGateBlockedError } from "../domain/auth/auth_gate_blocked_error.ts";
import {
  type EnrollParams,
  GATE_PASS_UNAVAILABLE,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
} from "../domain/remote/protocol.ts";

/**
 * A scripted in-memory WebSocket wired to an orchestrator-side RpcChannel.
 */
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

  /** Server-initiated drop. */
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
        // Drop the socket so the (reconnect: false) loop exits.
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

    // Two process lifetimes: fresh instance uuids, one machine identity.
    await runOnce();
    await runOnce();
    assertEquals(enrollments.length, 2);
    assertEquals(enrollments[0].machineId, enrollments[1].machineId);
    assertEquals(
      enrollments[0].instanceUuid === enrollments[1].instanceUuid,
      false,
    );
  } finally {
    await Deno.remove(cacheDir, { recursive: true }).catch(() => {});
  }
});

/**
 * A socket that immediately closes without calling onopen — simulates
 * an HTTP-level rejection (401, 403, 429) where the WebSocket upgrade
 * never completes.
 */
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

Deno.test("runWorker: pre-enrollment failures stop after 3 consecutive attempts", async () => {
  const events: WorkerStatusEvent[] = [];
  let socketCount = 0;
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
        onStatus: (event) => events.push(event),
        createSocket: () => {
          socketCount++;
          return new RejectingSocket() as unknown as WebSocket;
        },
      }),
    Error,
  );
  assertStringIncludes(error.message, "3 consecutive times");
  assertEquals(socketCount, 3);
  assertEquals(events.at(-1)?.kind, "stopped");
});

Deno.test("runWorker: HTTP 401 stops after 3 consecutive attempts", async () => {
  const events: WorkerStatusEvent[] = [];
  let socketCount = 0;
  const error = await assertRejects(
    () =>
      runWorker({
        url: "ws://test:1",
        token: "ci.s",
        swampVersion: "1.2.3",
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
  assertStringIncludes(error.message, "3 consecutive times");
  assertEquals(socketCount, 3);
  assertEquals(events.at(-1)?.kind, "stopped");
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

Deno.test("runWorker: pre-enrollment failure counter resets after successful enrollment", async () => {
  const events: WorkerStatusEvent[] = [];
  let socketCount = 0;
  const controller = new AbortController();

  const done = runWorker({
    url: "ws://test:1",
    token: "ci.s",
    swampVersion: "1.2.3",
    signal: controller.signal,
    onStatus: (event) => {
      events.push(event);
      if (event.kind === "enrolled") {
        controller.abort();
      }
    },
    createSocket: () => {
      socketCount++;
      // First two attempts fail before enrollment, third succeeds.
      if (socketCount <= 2) {
        return new RejectingSocket() as unknown as WebSocket;
      }
      const socket = new FakeSocket((channel) => {
        channel.register(
          RemoteMethod.enroll,
          () => Promise.resolve(enrollResult("ci")),
        );
      });
      return socket as unknown as WebSocket;
    },
  });

  await done;
  assertEquals(socketCount, 3);
  const kinds = events.map((e) => e.kind);
  assertEquals(kinds.includes("enrolled"), true);
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
      // Coded and retryable.
      new RpcError({
        code: "token_unreadable",
        message:
          "Enrollment token 'expired-runners' could not be read after redemption; retry the connection",
      }),
      // Uncoded, as an orchestrator without codes sends it.
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
  // Admitted once per process: a reconnect neither asks nor checks again.
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

  // The socket drops while admission is still pending.
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
