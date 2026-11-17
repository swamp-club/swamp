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

Deno.test("createStatusWriter: a failed write is tried again with no new status, so a failed serve is not left reading ready", async () => {
  let failures = 2;
  const written: string[] = [];
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    retryMs: 1,
    write: (_name, s) => {
      if (failures-- > 0) return Promise.reject(new Error("disk full"));
      written.push(s.state);
      return Promise.resolve();
    },
  });
  writer.report(status({ observed: "failed" }));
  await writer.drain();
  assertEquals(written, ["failed"]);
});

Deno.test("createStatusWriter: forget ends a retry wait at once", async () => {
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    retryMs: 3_600_000,
    write: () => Promise.reject(new Error("disk full")),
  });
  writer.report(status({ observed: "ready" }));
  await Promise.resolve();
  await writer.forget("edge-dns");
  await writer.drain();
});

Deno.test("createStatusWriter: after markShutDown a failed write is not tried again, so shutdown ends", async () => {
  let attempts = 0;
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    retryMs: 3_600_000,
    write: () => {
      attempts++;
      return Promise.reject(new Error("disk full"));
    },
  });
  writer.report(status({ observed: "ready" }));
  await Promise.resolve();
  writer.markShutDown();
  await writer.drain();
  assertEquals(attempts, 2, "the first try, then one stopped status");
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

Deno.test("createStatusWriter: markShutDown rewrites every file as stopped, a failed serve included", async () => {
  const written: { name: string; status: HostedWorkspaceStatus }[] = [];
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    write: (name, status) => {
      written.push({ name, status });
      return Promise.resolve();
    },
  });
  writer.report(status({ observed: "ready", restarts: 1 }));
  writer.report(status({
    id: workspaceServe("broken"),
    observed: "failed",
    lastExit: { code: 1, stderrTail: ["boom"] },
  }));
  writer.report(status({ id: workspaceServe("gone"), observed: "stopped" }));
  await writer.drain();
  await writer.forget("gone");
  written.length = 0;

  writer.markShutDown();
  writer.report(status({
    observed: "backoff",
    restarts: 1,
    lastExit: { code: 0, stderrTail: [] },
  }));
  await writer.drain();
  const last = new Map(written.map((w) => [w.name, w.status]));
  assertEquals([...last.keys()].sort(), ["broken", "edge-dns"]);
  assertEquals(last.get("edge-dns")?.state, "stopped");
  assertEquals(last.get("edge-dns")?.reason, null);
  assertEquals(last.get("edge-dns")?.restarts, 1);
  assertEquals(last.get("broken")?.state, "stopped");
});

Deno.test("createStatusWriter: a status reported at any moment around the end of a write is written", async () => {
  for (let delay = 0; delay < 12; delay++) {
    const written: string[] = [];
    const writer = createStatusWriter({
      workspacesDir: "/unused",
      write: (_name, s) => {
        written.push(s.state);
        return Promise.resolve();
      },
    });
    writer.report(status({ observed: "backoff" }));
    for (let tick = 0; tick < delay; tick++) await Promise.resolve();
    writer.report(status({ observed: "failed" }));
    await writer.drain();
    assertEquals(
      written.at(-1),
      "failed",
      `reported after ${delay} microtasks`,
    );
  }
});

Deno.test("createStatusWriter: forget during a write that then fails does not wait out a retry", async () => {
  const { promise: failing, reject } = Promise.withResolvers<void>();
  const writer = createStatusWriter({
    workspacesDir: "/unused",
    retryMs: 3_600_000,
    write: () => failing,
  });
  writer.report(status({ observed: "ready" }));
  const forgetting = writer.forget("edge-dns");
  reject(new Error("disk full"));
  await forgetting;
  await writer.drain();
});
