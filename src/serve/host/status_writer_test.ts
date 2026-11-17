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
import {
  ROOT_SERVE,
  workspaceServe,
} from "../../domain/serve/managed_serve.ts";
import type { HostedWorkspaceStatus } from "../../infrastructure/persistence/hosted_workspace_status_file.ts";
import { createStatusWriter } from "./status_writer.ts";
import type { ServeStatus } from "./supervisor.ts";

const NOW = new Date("2026-11-17T10:00:00.000Z");

function status(extra: Partial<ServeStatus> = {}): ServeStatus {
  return {
    id: workspaceServe("edge-dns"),
    wanted: "running",
    observed: "starting",
    port: null,
    authMode: null,
    refusal: null,
    crashCount: 0,
    restarts: 0,
    lastExit: null,
    ...extra,
  };
}

/** a write that waits until the test lets it finish */
class GatedWrites {
  readonly written: { name: string; status: HostedWorkspaceStatus }[] = [];
  readonly #gates: (() => void)[] = [];
  failNext = false;

  write = (name: string, status: HostedWorkspaceStatus): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#gates.push(() => {
      if (this.failNext) {
        this.failNext = false;
        resolve(Promise.reject(new Error("disk full")));
        return;
      }
      this.written.push({ name, status });
      resolve();
    });
    return promise;
  };

  get waiting(): number {
    return this.#gates.length;
  }

  release(): void {
    this.#gates.shift()?.();
  }
}

Deno.test("createStatusWriter: writes the state, the wanted word of the file and restarts", async () => {
  const writes = new GatedWrites();
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    now: () => NOW,
    write: writes.write,
  });
  writer.report(status({ observed: "ready", restarts: 2 }));
  writes.release();
  await writer.drain();
  assertEquals(writes.written, [{
    name: "edge-dns",
    status: {
      state: "ready",
      wanted: "active",
      restarts: 2,
      reason: null,
      updatedAt: NOW.toISOString(),
    },
  }]);
});

Deno.test("createStatusWriter: the root has no status file", async () => {
  const writes = new GatedWrites();
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    write: writes.write,
  });
  writer.report(status({ id: ROOT_SERVE }));
  await writer.drain();
  assertEquals(writes.waiting, 0);
});

Deno.test("createStatusWriter: a burst during a write coalesces into the last status", async () => {
  const writes = new GatedWrites();
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    write: writes.write,
  });
  writer.report(status({ observed: "starting" }));
  writer.report(status({ observed: "ready" }));
  writer.report(status({ observed: "backoff" }));
  assertEquals(writes.waiting, 1, "one write in flight");
  writes.release();
  await waitFor(() => writes.waiting === 1, "the second write");
  writes.release();
  await writer.drain();
  assertEquals(writes.written.map((w) => w.status.state), [
    "starting",
    "backoff",
  ]);
});

Deno.test("createStatusWriter: the reason is the wanted file problem, then the refusal, then the exit", async () => {
  const written: HostedWorkspaceStatus[] = [];
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    write: (_name, status) => {
      written.push(status);
      return Promise.resolve();
    },
  });
  const reasons: (string | null)[] = [];
  const settle = async () => {
    await writer.drain();
    reasons.push(written.at(-1)!.reason);
  };
  writer.report(status({
    observed: "failed",
    lastExit: { code: 1, stderrTail: ["boom", "bang"] },
  }));
  await settle();
  writer.report(status({
    observed: "failed",
    lastExit: { code: 1, stderrTail: [] },
    refusal: "auth mode none off loopback",
  }));
  await settle();
  writer.setProblem("edge-dns", "The wanted file cannot be read");
  await settle();
  writer.setProblem("edge-dns", null);
  writer.report(status({
    observed: "backoff",
    lastExit: { code: 3, stderrTail: [] },
  }));
  await settle();
  writer.report(status({ observed: "stopped", wanted: "suspended" }));
  await settle();
  assertEquals(reasons, [
    "boom\nbang",
    "auth mode none off loopback",
    "The wanted file cannot be read",
    "The serve exited with code 3.",
    null,
  ]);
});

Deno.test("createStatusWriter: a failed write is logged and the next status is written", async () => {
  const writes = new GatedWrites();
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    write: writes.write,
  });
  writes.failNext = true;
  writer.report(status({ observed: "starting" }));
  writes.release();
  await writer.drain();
  writer.report(status({ observed: "ready" }));
  writes.release();
  await writer.drain();
  assertEquals(writes.written.map((w) => w.status.state), ["ready"]);
});

Deno.test("createStatusWriter: forget waits for the write in flight and drops every later status until track", async () => {
  const writes = new GatedWrites();
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    write: writes.write,
  });
  writer.report(status({ observed: "ready" }));
  writer.report(status({ observed: "stopped", wanted: "deleted" }));
  let forgotten = false;
  const forgetting = writer.forget("edge-dns").then(() => forgotten = true);
  await Promise.resolve();
  assertEquals(forgotten, false, "the write in flight has not landed");
  writes.release();
  await forgetting;
  writer.report(status({ observed: "stopped", wanted: "deleted" }));
  writer.setProblem("edge-dns", "unreadable");
  await writer.drain();
  assertEquals(writes.waiting, 0, "nothing is written after forget");
  assertEquals(writes.written.map((w) => w.status.state), ["ready"]);

  writer.track("edge-dns");
  writer.report(status({ observed: "starting" }));
  writes.release();
  await writer.drain();
  assertEquals(writes.written.at(-1)?.status.state, "starting");
});

Deno.test("createStatusWriter: after beginShutdown a serve the shutdown stopped is written as stopped", async () => {
  const written: HostedWorkspaceStatus[] = [];
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    write: (_name, status) => {
      written.push(status);
      return Promise.resolve();
    },
  });
  writer.report(status({ observed: "ready", restarts: 1 }));
  await writer.drain();
  writer.beginShutdown();
  writer.report(status({
    observed: "backoff",
    restarts: 1,
    lastExit: { code: 0, stderrTail: [] },
  }));
  await writer.drain();
  assertEquals(written.at(-1)?.state, "stopped");
  assertEquals(written.at(-1)?.reason, null);
  assertEquals(written.at(-1)?.restarts, 1);
});
