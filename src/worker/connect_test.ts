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
import {
  type EnrollParams,
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
