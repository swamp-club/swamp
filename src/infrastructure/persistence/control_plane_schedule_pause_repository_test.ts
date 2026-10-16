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
import { ControlPlaneSchedulePauseRepository } from "./control_plane_schedule_pause_repository.ts";
import {
  type SchedulePause,
  UNREADABLE_PAUSE_REASON,
} from "../../domain/workflows/schedule_pause.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

async function withRepo(
  fn: (
    repo: ControlPlaneSchedulePauseRepository,
    store: FileSystemControlPlaneStore,
    dir: string,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-schedule-pause-" });
  try {
    const store = new FileSystemControlPlaneStore(dir);
    await fn(new ControlPlaneSchedulePauseRepository(store), store, dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

function pause(extra: Partial<SchedulePause> = {}): SchedulePause {
  return {
    workflowId: crypto.randomUUID(),
    workflowName: "nightly-gc",
    pausedBy: "user:ops",
    pausedAt: "2026-10-16T12:00:00.000Z",
    ...extra,
  };
}

Deno.test("ControlPlaneSchedulePauseRepository: saves, reads, lists and deletes a pause", async () => {
  await withRepo(async (repo) => {
    const p = pause({ reason: "incident", until: "2026-10-16T14:00:00.000Z" });
    const id = createWorkflowId(p.workflowId);
    assertEquals(await repo.get(id), null);

    await repo.save(p);
    assertEquals(await repo.get(id), p);
    assertEquals(await repo.list(), [p]);

    await repo.delete(id);
    assertEquals(await repo.get(id), null);
    assertEquals(await repo.list(), []);
  });
});

Deno.test("ControlPlaneSchedulePauseRepository: a second save replaces the pause", async () => {
  await withRepo(async (repo) => {
    const first = pause({ reason: "first" });
    await repo.save(first);
    const second = { ...first, reason: "second" };
    await repo.save(second);
    assertEquals(await repo.get(createWorkflowId(first.workflowId)), second);
    assertEquals((await repo.list()).length, 1);
  });
});

Deno.test("ControlPlaneSchedulePauseRepository: deleting a missing pause is no error", async () => {
  await withRepo(async (repo) => {
    await repo.delete(createWorkflowId(crypto.randomUUID()));
  });
});

Deno.test("ControlPlaneSchedulePauseRepository: an id with path characters stays one key under the prefix", async () => {
  await withRepo(async (repo, store) => {
    const p = pause({ workflowId: "../x/y*z" });
    await repo.save(p);
    assertEquals(await store.list("schedule-pauses"), [
      "schedule-pauses/..%2Fx%2Fy%2Az",
    ]);
    assertEquals(await repo.get(createWorkflowId("../x/y*z")), p);
    assertEquals(await repo.list(), [p]);
  });
});

Deno.test("ControlPlaneSchedulePauseRepository: an unreadable record is reported as an open-ended pause", async () => {
  await withRepo(async (repo, _store, dir) => {
    const id = crypto.randomUUID();
    const path = join(dir, "_control", "schedule-pauses", id);
    await Deno.mkdir(join(dir, "_control", "schedule-pauses"), {
      recursive: true,
    });
    await Deno.writeTextFile(path, "{not json");

    const read = await repo.get(createWorkflowId(id));
    assertEquals(read?.workflowId, id);
    assertEquals(read?.reason, UNREADABLE_PAUSE_REASON);
    assertEquals(read?.until, undefined);

    await repo.delete(createWorkflowId(id));
    assertEquals(await repo.get(createWorkflowId(id)), null);
  });
});

Deno.test("ControlPlaneSchedulePauseRepository: a record naming another workflow is not trusted", async () => {
  await withRepo(async (repo, store) => {
    const id = crypto.randomUUID();
    await store.put(
      `schedule-pauses/${id}`,
      new TextEncoder().encode(JSON.stringify(pause())),
    );
    assertEquals(
      (await repo.get(createWorkflowId(id)))?.reason,
      UNREADABLE_PAUSE_REASON,
    );
  });
});

Deno.test("ControlPlaneSchedulePauseRepository: save refuses an invalid pause", async () => {
  await withRepo(async (repo) => {
    let threw = false;
    try {
      await repo.save(pause({ reason: "two\nlines" }));
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(await repo.list(), []);
  });
});

Deno.test("ControlPlaneSchedulePauseRepository: a record that cannot be read is listed as paused, beside the others", async () => {
  await withRepo(async (_repo, store) => {
    const good = pause();
    const badId = crypto.randomUUID();
    const repo = new ControlPlaneSchedulePauseRepository({
      put: (key, data) => store.put(key, data),
      get: (key) =>
        key.endsWith(badId)
          ? Promise.reject(new Deno.errors.PermissionDenied("denied"))
          : store.get(key),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    });
    await repo.save(good);
    await repo.save(pause({ workflowId: badId }));

    const listed = await repo.list();
    assertEquals(listed.length, 2);
    assertEquals(listed.find((p) => p.workflowId === good.workflowId), good);
    assertEquals(
      listed.find((p) => p.workflowId === badId)?.reason,
      UNREADABLE_PAUSE_REASON,
    );
  });
});

Deno.test("ControlPlaneSchedulePauseRepository: a read that never settles rejects at the deadline and is aborted", async () => {
  let seen: AbortSignal | undefined;
  const repo = new ControlPlaneSchedulePauseRepository(
    {
      put: () => Promise.resolve(),
      get: (_key, options) => {
        seen = options?.signal;
        return new Promise(() => {});
      },
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    },
    20,
  );
  await assertRejects(
    () => repo.get(createWorkflowId(crypto.randomUUID())),
    Error,
    "timed out",
  );
  assertEquals(seen?.aborted, true);
});

Deno.test("ControlPlaneSchedulePauseRepository: a caller's signal cancels the read", async () => {
  let seen: AbortSignal | undefined;
  const repo = new ControlPlaneSchedulePauseRepository({
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
