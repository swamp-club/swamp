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
import { join } from "@std/path";
import { FileSystemControlPlaneStore } from "./fs_control_plane_store.ts";
import { ControlPlaneScheduleStateRepository } from "./control_plane_schedule_state_repository.ts";
import type { ScheduleState } from "../../domain/workflows/schedule_state.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

async function withStore(
  fn: (store: FileSystemControlPlaneStore, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-schedule-state-" });
  try {
    await fn(new FileSystemControlPlaneStore(dir), dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

function state(extra: Partial<ScheduleState> = {}): ScheduleState {
  return {
    workflowId: crypto.randomUUID(),
    workflowName: "monthly-maintenance",
    lastEvaluatedFireTime: "2026-11-01T09:00:00.000Z",
    ...extra,
  };
}

Deno.test("ControlPlaneScheduleStateRepository: saves, reads and lists a state", async () => {
  await withStore(async (store) => {
    const repo = new ControlPlaneScheduleStateRepository(store);
    const s = state({
      lastMissed: {
        fireTime: "2026-11-01T09:00:00.000Z",
        count: 2,
        reason: "serve_down",
        caughtUp: true,
        detectedAt: "2026-11-01T10:00:00.000Z",
      },
    });
    const id = createWorkflowId(s.workflowId);
    assertEquals(await repo.get(id), null);

    await repo.save(s);
    assertEquals(await repo.get(id), s);
    assertEquals(await repo.list(), [s]);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: a second save replaces the state", async () => {
  await withStore(async (store) => {
    const repo = new ControlPlaneScheduleStateRepository(store);
    const first = state();
    await repo.save(first);
    const second = {
      ...first,
      lastEvaluatedFireTime: "2026-12-01T09:00:00.000Z",
    };
    await repo.save(second);
    assertEquals(await repo.get(createWorkflowId(first.workflowId)), second);
    assertEquals((await repo.list()).length, 1);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: an id with path characters stays one key under the prefix", async () => {
  await withStore(async (store) => {
    const repo = new ControlPlaneScheduleStateRepository(store);
    const s = state({ workflowId: "../x/y*z" });
    await repo.save(s);
    assertEquals(await store.list("schedule-states"), [
      "schedule-states/..%2Fx%2Fy%2Az",
    ]);
    assertEquals(await repo.list(), [s]);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: an unparseable record reads as absent", async () => {
  await withStore(async (store, dir) => {
    const repo = new ControlPlaneScheduleStateRepository(store);
    const id = crypto.randomUUID();
    await Deno.mkdir(join(dir, "_control", "schedule-states"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(dir, "_control", "schedule-states", id),
      "{not json",
    );
    assertEquals(await repo.get(createWorkflowId(id)), null);
    assertEquals(await repo.list(), []);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: a record naming another workflow reads as absent", async () => {
  await withStore(async (store) => {
    const repo = new ControlPlaneScheduleStateRepository(store);
    const id = crypto.randomUUID();
    await store.put(
      `schedule-states/${id}`,
      new TextEncoder().encode(JSON.stringify(state())),
    );
    assertEquals(await repo.get(createWorkflowId(id)), null);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: list skips a record whose read fails and keeps the rest", async () => {
  await withStore(async (store) => {
    const good = state();
    const badId = crypto.randomUUID();
    const repo = new ControlPlaneScheduleStateRepository({
      put: (key, data) => store.put(key, data),
      get: (key) =>
        key.endsWith(badId)
          ? Promise.reject(new Deno.errors.PermissionDenied("denied"))
          : store.get(key),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    });
    await repo.save(good);
    await repo.save(state({ workflowId: badId }));

    assertEquals(await repo.list(), [good]);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: save is a no-op until canWrite allows it, read on each save", async () => {
  await withStore(async (store) => {
    let leader = false;
    const repo = new ControlPlaneScheduleStateRepository(store, {
      canWrite: () => leader,
    });
    const s = state();
    const id = createWorkflowId(s.workflowId);

    await repo.save(s);
    assertEquals(await repo.get(id), null);
    assertEquals(await store.list("schedule-states"), []);

    leader = true;
    await repo.save(s);
    assertEquals(await repo.get(id), s);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: save refuses an invalid state", async () => {
  await withStore(async (store) => {
    const repo = new ControlPlaneScheduleStateRepository(store);
    await assertRejects(() =>
      repo.save(state({ lastEvaluatedFireTime: "not a time" }))
    );
    assertEquals(await repo.list(), []);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: a read that never settles rejects at the deadline and is aborted", async () => {
  let seen: AbortSignal | undefined;
  const repo = new ControlPlaneScheduleStateRepository(
    {
      put: () => Promise.resolve(),
      get: (_key, options) => {
        seen = options?.signal;
        return new Promise(() => {});
      },
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    },
    { timeoutMs: 20 },
  );
  await assertRejects(
    () => repo.get(createWorkflowId(crypto.randomUUID())),
    Error,
    "timed out",
  );
  assertEquals(seen?.aborted, true);
});

Deno.test("ControlPlaneScheduleStateRepository: a write that never settles rejects at the deadline", async () => {
  const repo = new ControlPlaneScheduleStateRepository(
    {
      put: () => new Promise(() => {}),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    },
    { timeoutMs: 20 },
  );
  await assertRejects(() => repo.save(state()), Error, "timed out");
});

Deno.test("ControlPlaneScheduleStateRepository: a caller's signal cancels the read", async () => {
  let seen: AbortSignal | undefined;
  const repo = new ControlPlaneScheduleStateRepository({
    put: () => Promise.resolve(),
    get: (_key, options) => {
      seen = options?.signal;
      return Promise.resolve(null);
    },
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  });
  const controller = new AbortController();
  await repo.get(createWorkflowId(crypto.randomUUID()), {
    signal: controller.signal,
  });
  controller.abort();
  assertEquals(seen?.aborted, true);
});

Deno.test("ControlPlaneScheduleStateRepository: a list that never settles rejects at the deadline", async () => {
  const repo = new ControlPlaneScheduleStateRepository(
    {
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      list: () => new Promise(() => {}),
    },
    { timeoutMs: 20 },
  );
  await assertRejects(() => repo.list(), Error, "timed out");
});

Deno.test("ControlPlaneScheduleStateRepository: list skips a record whose read times out and keeps the rest", async () => {
  await withStore(async (store) => {
    const good = state();
    const hungId = crypto.randomUUID();
    const repo = new ControlPlaneScheduleStateRepository({
      put: (key, data) => store.put(key, data),
      get: (key) =>
        key.endsWith(hungId) ? new Promise(() => {}) : store.get(key),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    }, { timeoutMs: 20 });
    await repo.save(good);
    await repo.save(state({ workflowId: hungId }));

    assertEquals(await repo.list(), [good]);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: an aborted caller signal ends the listing", async () => {
  await withStore(async (store) => {
    const controller = new AbortController();
    const read: string[] = [];
    const repo = new ControlPlaneScheduleStateRepository({
      put: (key, data) => store.put(key, data),
      get: (key, options) => {
        read.push(key);
        controller.abort(new Error("serve is shutting down"));
        return new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
          if (options?.signal?.aborted) reject(options.signal.reason);
        });
      },
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    });
    await repo.save(state());
    await repo.save(state());

    await assertRejects(
      () => repo.list({ signal: controller.signal }),
      Error,
      "serve is shutting down",
    );
    assertEquals(read.length, 1);
  });
});

Deno.test("ControlPlaneScheduleStateRepository: an abort ends a list that never settles without waiting for the deadline", async () => {
  const repo = new ControlPlaneScheduleStateRepository(
    {
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      list: () => new Promise(() => {}),
    },
    { timeoutMs: 60_000 },
  );
  const controller = new AbortController();
  const listing = repo.list({ signal: controller.signal });
  controller.abort(new Error("serve is shutting down"));
  await assertRejects(() => listing, Error, "serve is shutting down");
});
