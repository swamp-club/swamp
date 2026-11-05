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

import { assertEquals, assertRejects } from "@std/assert";
import { UserError } from "../src/domain/errors.ts";
import type { HubRecord } from "../src/infrastructure/persistence/hub_record.ts";
import type { HubLiveness } from "../src/infrastructure/process/hub_probe.ts";
import {
  findOrLaunchHub,
  hubLaunchArgs,
  type HubLauncherDeps,
} from "../src/infrastructure/process/hub_launcher.ts";

const ENGINE = "/opt/swamp/bin/swamp";

function hubRecord(overrides: Partial<HubRecord> = {}): HubRecord {
  return {
    pid: 100,
    port: 40100,
    adminToken: "admin",
    version: "1",
    gitSha: "go",
    engine: ENGINE,
    engineVersion: "1",
    engineGitSha: "build-1",
    autoExit: true,
    ...overrides,
  };
}

/** a machine with at most one hub, whose record and liveness tests set */
function machine(initial: HubRecord | null, liveness: HubLiveness = "live") {
  const state = {
    record: initial,
    alive: new Set(initial ? [initial.pid] : []),
    liveness: new Map<number, HubLiveness>(
      initial ? [[initial.pid, liveness]] : [],
    ),
    spawned: [] as string[][],
    shutdowns: 0,
    shutdownAccepted: true,
    writesRecord: true,
    locks: 0,
  };
  const deps: HubLauncherDeps = {
    dataDir: "/data",
    binaries: { hub: "/opt/swamp/bin/swampd", engine: ENGINE },
    gitSha: "build-1",
    readRecord: () => Promise.resolve(state.record),
    probe: (record) =>
      Promise.resolve(state.liveness.get(record.pid) ?? "dead"),
    shutdown: () => {
      state.shutdowns++;
      if (state.shutdownAccepted && state.record) {
        state.alive.delete(state.record.pid);
      }
      return Promise.resolve(state.shutdownAccepted);
    },
    isAlive: (pid) => state.alive.has(pid),
    spawn: (_binary, args) => {
      state.spawned.push(args);
      const pid = 200 + state.spawned.length;
      state.alive.add(pid);
      state.liveness.set(pid, "live");
      if (state.writesRecord) {
        state.record = hubRecord({ pid, port: 40000 + pid });
      }
      return pid;
    },
    withLock: async (run) => {
      state.locks++;
      return await run();
    },
    startDeadlineMs: 50,
    pollMs: 1,
  };
  return { state, deps };
}

Deno.test("findOrLaunchHub: reuses the running hub of this swamp build", async () => {
  const { state, deps } = machine(hubRecord());
  const record = await findOrLaunchHub(deps);
  assertEquals(record.pid, 100);
  assertEquals(state.spawned, []);
  assertEquals(state.locks, 1);
});

Deno.test("findOrLaunchHub: an inconclusive probe still reuses the hub", async () => {
  const { state, deps } = machine(hubRecord(), "unknown");
  assertEquals((await findOrLaunchHub(deps)).pid, 100);
  assertEquals(state.spawned, []);
});

Deno.test("findOrLaunchHub: with no hub or a dead one, launches one that exits when idle", async () => {
  for (const initial of [null, hubRecord()]) {
    const { state, deps } = machine(initial, "dead");
    const record = await findOrLaunchHub(deps);
    assertEquals(record.pid, 201);
    assertEquals(state.spawned, [hubLaunchArgs("/data", ENGINE)]);
    assertEquals(state.spawned[0].slice(0, 5), [
      "hub",
      "--engine",
      ENGINE,
      "--bind",
      "127.0.0.1:0",
    ]);
    assertEquals(state.spawned[0].includes("--exit-when-idle"), true);
  }
});

Deno.test("findOrLaunchHub: replaces a launched hub of another build once it stops", async () => {
  const { state, deps } = machine(hubRecord({ engineGitSha: "build-0" }));
  const record = await findOrLaunchHub(deps);
  assertEquals(state.shutdowns, 1);
  assertEquals(record.pid, 201);
});

Deno.test("findOrLaunchHub: never replaces a hub service or a hub with pages open", async () => {
  const daemon = machine(
    hubRecord({ engineGitSha: "build-0", autoExit: false }),
  );
  await assertRejects(
    () => findOrLaunchHub(daemon.deps),
    UserError,
    "swamp hub daemon enable",
  );
  assertEquals(daemon.state.shutdowns, 0);
  const busy = machine(hubRecord({ engine: "/old/swamp" }));
  busy.state.shutdownAccepted = false;
  await assertRejects(
    () => findOrLaunchHub(busy.deps),
    UserError,
    "still has pages open",
  );
  assertEquals(busy.state.spawned, []);
});

Deno.test("findOrLaunchHub: a hub that never comes up points at its log", async () => {
  const { state, deps } = machine(null);
  state.writesRecord = false;
  await assertRejects(() => findOrLaunchHub(deps), UserError, "hub.log");
});
