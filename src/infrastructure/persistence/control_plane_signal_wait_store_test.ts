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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { SignalWait } from "../../domain/workflows/signal_wait.ts";
import {
  cancelledOutcome,
  decideSignal,
  registrationOf,
  timedOutOutcome,
  type WaitRegistration,
} from "../../domain/workflows/signal_wait_records.ts";
import { settledBy } from "../../domain/workflows/signal_wait_store.ts";
import {
  type AtomicControlPlaneStore,
  ControlPlaneSignalWaitStore,
  isAtomicControlPlaneStore,
} from "./control_plane_signal_wait_store.ts";
import { FileSystemControlPlaneStore } from "./fs_control_plane_store.ts";

const OPENED = new Date("2026-01-01T00:00:00.000Z");
const SCHEMA = {
  type: "object" as const,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const } },
};

function registration(runId = crypto.randomUUID()): WaitRegistration {
  return registrationOf(
    {
      workflowId: "wf-1",
      workflowName: "release",
      runId,
      jobName: "main",
      stepName: "review",
    },
    SignalWait.open(SCHEMA, 60, OPENED),
    OPENED,
  );
}

function accepted(reg: WaitRegistration, verdict: string) {
  const decision = decideSignal(reg, { verdict }, "ada", OPENED);
  assert(decision.accepted);
  return decision.outcome;
}

/** An in-memory control-plane store that records the keys it is asked for. */
function memoryStore(): AtomicControlPlaneStore & {
  data: Map<string, Uint8Array>;
} {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    put: (key, bytes) => {
      data.set(key, bytes);
      return Promise.resolve();
    },
    putIfAbsent: (key, bytes) => {
      if (data.has(key)) return Promise.resolve(false);
      data.set(key, bytes);
      return Promise.resolve(true);
    },
    get: (key) => Promise.resolve(data.get(key) ?? null),
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve([...data.keys()].filter((k) => k.startsWith(prefix))),
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-wait-store-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("isAtomicControlPlaneStore: only a store with putIfAbsent qualifies", () => {
  const { putIfAbsent: _dropped, ...withoutCreate } = memoryStore();
  assertEquals(isAtomicControlPlaneStore(memoryStore()), true);
  assertEquals(
    isAtomicControlPlaneStore(withoutCreate as ControlPlaneStore),
    false,
  );
});

Deno.test("ControlPlaneSignalWaitStore: keeps registrations under waits/ and outcomes under wait-outcomes/", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  const reg = registration();

  await store.register(reg);
  await store.settle(accepted(reg, "ship"));

  assertEquals([...backing.data.keys()].sort(), [
    `wait-outcomes/${reg.waitId}`,
    `waits/${reg.waitId}`,
  ]);
  assertEquals(await store.findRegistration(reg.waitId), {
    kind: "found",
    record: reg,
  });
  assertEquals(await store.listRegistrations(), [reg]);
  assertEquals((await store.listOutcomes()).map((o) => o.kind), ["accepted"]);
});

Deno.test("ControlPlaneSignalWaitStore: a registration is written once and never replaced", async () => {
  const store = new ControlPlaneSignalWaitStore(memoryStore());
  const reg = registration();

  await store.register(reg);
  await store.register({
    ...reg,
    stepName: "other",
    deadline: reg.registeredAt,
  });

  assertEquals(await store.findRegistration(reg.waitId), {
    kind: "found",
    record: reg,
  });
});

Deno.test("ControlPlaneSignalWaitStore: the first outcome holds, and every later settle is handed it", async () => {
  const store = new ControlPlaneSignalWaitStore(memoryStore());
  const reg = registration();
  const first = accepted(reg, "ship");

  const won = await store.settle(first);
  assertEquals(won, { kind: "found", record: first });
  assertEquals(settledBy(won, first), true);

  const late = new Date("2026-01-01T00:02:00.000Z");
  for (
    const loser of [
      accepted(reg, "fix"),
      timedOutOutcome(reg, late),
      cancelledOutcome(reg, late),
    ]
  ) {
    const stored = await store.settle(loser);
    assertEquals(stored, { kind: "found", record: first });
    assertEquals(settledBy(stored, loser), false);
  }
  assertEquals(await store.listOutcomes(), [first]);
});

Deno.test("ControlPlaneSignalWaitStore: a create reported as lost after it landed is still told it won", async () => {
  // What a retried conditional write looks like when its first reply was
  // lost: the record is this writer's, and the create answers false.
  const backing = memoryStore();
  const lossy: AtomicControlPlaneStore = {
    ...backing,
    putIfAbsent: async (key, bytes) => {
      await backing.putIfAbsent(key, bytes);
      return false;
    },
  };
  const store = new ControlPlaneSignalWaitStore(lossy);
  const reg = registration();
  const outcome = accepted(reg, "ship");

  const stored = await store.settle(outcome);

  assertEquals(settledBy(stored, outcome), true);
});

Deno.test("ControlPlaneSignalWaitStore: a damaged record reads unreadable, is not listed, and is never replaced by a settle", async () => {
  const backing = memoryStore();
  const store = new ControlPlaneSignalWaitStore(backing);
  const reg = registration();
  const garbage = new TextEncoder().encode("{");
  backing.data.set(`waits/${reg.waitId}`, garbage);
  backing.data.set(`wait-outcomes/${reg.waitId}`, garbage);
  // A key in the family that names no wait is skipped.
  backing.data.set("waits/README", garbage);

  assertEquals(await store.findRegistration(reg.waitId), {
    kind: "unreadable",
  });
  assertEquals(await store.listRegistrations(), []);
  assertEquals(await store.listOutcomes(), []);
  assertEquals(await store.settle(accepted(reg, "ship")), {
    kind: "unreadable",
  });
  assertEquals(backing.data.get(`wait-outcomes/${reg.waitId}`), garbage);
});

Deno.test("ControlPlaneSignalWaitStore: removing a record leaves the other, and a missing one is no error", async () => {
  const store = new ControlPlaneSignalWaitStore(memoryStore());
  const reg = registration();
  await store.register(reg);
  await store.settle(accepted(reg, "ship"));

  await store.removeRegistration(reg.waitId);
  await store.removeRegistration(reg.waitId);
  assertEquals((await store.findRegistration(reg.waitId)).kind, "absent");
  assertEquals((await store.findOutcome(reg.waitId)).kind, "found");

  await store.removeOutcome(reg.waitId);
  assertEquals((await store.findOutcome(reg.waitId)).kind, "absent");
});

Deno.test("ControlPlaneSignalWaitStore: two stores on one directory see each other's records at once", async () => {
  await withTempDir(async (dir) => {
    const one = new ControlPlaneSignalWaitStore(
      new FileSystemControlPlaneStore(dir),
    );
    const two = new ControlPlaneSignalWaitStore(
      new FileSystemControlPlaneStore(dir),
    );
    const reg = registration();

    await one.register(reg);
    assertEquals(await two.listRegistrations(), [reg]);

    const outcome = accepted(reg, "ship");
    assertEquals(settledBy(await two.settle(outcome), outcome), true);
    const loser = accepted(reg, "fix");
    assertEquals(settledBy(await one.settle(loser), loser), false);
    assertEquals(await one.findOutcome(reg.waitId), {
      kind: "found",
      record: outcome,
    });
    // On disk under the store's root, in the two key families.
    assertEquals(
      (await Deno.stat(join(dir, "_control", "waits", reg.waitId))).isFile,
      true,
    );
    assertEquals(
      (await Deno.stat(join(dir, "_control", "wait-outcomes", reg.waitId)))
        .isFile,
      true,
    );
  });
});

Deno.test("ControlPlaneSignalWaitStore: of many concurrent settles on a real directory exactly one wins, and all are handed the same outcome", async () => {
  await withTempDir(async (dir) => {
    const reg = registration();
    const outcomes = Array.from(
      { length: 12 },
      (_, i) => accepted(reg, `v${i}`),
    );

    const results = await Promise.all(
      outcomes.map((outcome) =>
        new ControlPlaneSignalWaitStore(new FileSystemControlPlaneStore(dir))
          .settle(outcome)
      ),
    );

    const winners = results.filter((stored, i) =>
      settledBy(stored, outcomes[i])
    );
    assertEquals(winners.length, 1);
    for (const stored of results) assertEquals(stored, winners[0]);
  });
});
