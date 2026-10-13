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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { renderBrief } from "../../domain/start/brief.ts";
import { join } from "@std/path";
import { StartSession } from "../../domain/start/start_session.ts";
import { StartTask } from "../../domain/start/start_task.ts";
import {
  briefPath,
  refuseSymlinks,
  startDir,
  StartSessionFileRepository,
} from "./start_session_file_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { assertPathEquals } from "./path_test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-start-tasks-" });
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

const CREATED = new Date("2026-10-03T10:00:00.000Z");

function launchedTask(workspacePath: string, id = crypto.randomUUID()) {
  const session = StartSession.create(id, workspacePath, CREATED);
  session.saveTask(StartTask.create("list my pods\nin prod"));
  session.assignBriefFile("tasks/2026-10-03-list-my-pods.md");
  session.chooseHarness("codex");
  session.confirmTrustAndRecordLaunch(
    { method: "copy_command", command: "cd '/w' && 'codex'", opened: false },
    new Date("2026-10-03T10:01:00.000Z"),
  );
  return session;
}

const recordPath = (ws: string, id: string) =>
  join(startDir(ws), "tasks", `${id}.json`);

async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false);
}

/** Writes an old-style `state.json` (one session, `session` key). */
async function writeLegacyState(
  path: string,
  session: StartSession,
): Promise<void> {
  const { briefFile: _drop, ...data } = session.toData();
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify({ schemaVersion: 1, session: data }),
  );
}

/** A brief exactly as swamp start rendered it for `text`. */
function briefFor(ws: string, text: string): string {
  return renderBrief({
    task: StartTask.create(text),
    workspacePath: ws,
    harnessDisplayName: "Codex",
  });
}

function legacyTask(ws: string, text: string, created: string) {
  const session = StartSession.create(
    crypto.randomUUID(),
    ws,
    new Date(created),
  );
  session.saveTask(StartTask.create(text));
  return session;
}

Deno.test("startDir: is .swamp/start under the workspace", () => {
  assertPathEquals(startDir("/w"), join("/w", ".swamp", "start"));
});

Deno.test("briefPath: resolves a brief path under the workspace, refusing others", () => {
  assertPathEquals(
    briefPath("/w", "tasks/2026-10-03-x.md"),
    join("/w", "tasks", "2026-10-03-x.md"),
  );
  let threw = false;
  try {
    briefPath("/w", "tasks/../TASK.md");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("StartSessionFileRepository: a workspace with no tasks lists none", async () => {
  await withTempDir(async (dir) => {
    const repo = new StartSessionFileRepository();
    assertEquals(await repo.list(dir), []);
    assertEquals(await repo.load(dir, "nope"), null);
  });
});

Deno.test("StartSessionFileRepository: round-trips each task through its own record", async () => {
  await withTempDir(async (dir) => {
    const repo = new StartSessionFileRepository();
    const a = launchedTask(dir);
    const b = launchedTask(dir);
    await repo.save(a);
    await repo.save(b);
    assertEquals((await repo.load(dir, a.id))?.toData(), a.toData());
    assertEquals(
      (await repo.list(dir)).map((t) => t.id).sort(),
      [a.id, b.id].sort(),
    );
    const raw = JSON.parse(await Deno.readTextFile(recordPath(dir, a.id)));
    assertEquals(raw.schemaVersion, 1);
    assertEquals(raw.task.briefFile, "tasks/2026-10-03-list-my-pods.md");
    const leftovers = [];
    for await (const e of Deno.readDir(join(startDir(dir), "tasks"))) {
      leftovers.push(e.name);
    }
    assertEquals(leftovers.sort(), [`${a.id}.json`, `${b.id}.json`].sort());
  });
});

Deno.test({
  name: "StartSessionFileRepository.save: writes the record with mode 0600",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const task = launchedTask(dir);
      await new StartSessionFileRepository().save(task);
      const mode = (await Deno.stat(recordPath(dir, task.id))).mode!;
      assertEquals(mode & 0o777, 0o600);
    });
  },
});

Deno.test("StartSessionFileRepository: a moved workspace's tasks carry the folder they were read from", async () => {
  await withTempDir(async (dir) => {
    const repo = new StartSessionFileRepository();
    const task = launchedTask(join(dir, "old"));
    await repo.save(task);
    await Deno.rename(join(dir, "old"), join(dir, "new"));
    const [read] = await repo.list(join(dir, "new"));
    assertPathEquals(read.workspacePath, join(dir, "new"));
  });
});

Deno.test("StartSessionFileRepository: an unreadable record is listed as none and kept when saved over", async () => {
  await withTempDir(async (dir) => {
    const repo = new StartSessionFileRepository();
    const task = launchedTask(dir);
    await repo.save(task);
    const good = launchedTask(dir);
    await repo.save(good);
    await Deno.writeTextFile(recordPath(dir, task.id), "{ damaged");
    assertEquals((await repo.list(dir)).map((t) => t.id), [good.id]);
    assertEquals(await repo.load(dir, task.id), null);

    await repo.save(task);
    const kept = [];
    for await (const e of Deno.readDir(join(startDir(dir), "tasks"))) {
      if (e.name.startsWith(`${task.id}.json.unreadable-`)) kept.push(e.name);
    }
    assertEquals(kept.length, 1);
    assertEquals(
      await Deno.readTextFile(join(startDir(dir), "tasks", kept[0])),
      "{ damaged",
    );
  });
});

Deno.test("StartSessionFileRepository: a record naming another id, a bad id or another version is none", async () => {
  await withTempDir(async (dir) => {
    const repo = new StartSessionFileRepository();
    const task = launchedTask(dir);
    await repo.save(task);
    const raw = JSON.parse(await Deno.readTextFile(recordPath(dir, task.id)));
    const other = crypto.randomUUID();
    await Deno.writeTextFile(recordPath(dir, other), JSON.stringify(raw));
    raw.schemaVersion = 2;
    const future = crypto.randomUUID();
    raw.task.id = future;
    await Deno.writeTextFile(recordPath(dir, future), JSON.stringify(raw));
    assertEquals((await repo.list(dir)).map((t) => t.id), [task.id]);
    assertEquals(await repo.load(dir, "../escape"), null);
  });
});

Deno.test("StartSessionFileRepository.reserveBriefFile: dates and slugs, skipping names taken by files or tasks", async () => {
  await withTempDir(async (dir) => {
    const repo = new StartSessionFileRepository();
    const first = await repo.reserveBriefFile(
      dir,
      "2026-10-03T10:00:00.000Z",
      "List my pods",
    );
    assertEquals(first, "tasks/2026-10-03-list-my-pods.md");
    // Taken by a task's record, before its brief is written.
    await repo.save(launchedTask(dir));
    assertEquals(
      await repo.reserveBriefFile(dir, "2026-10-03T11:00:00Z", "List my pods"),
      "tasks/2026-10-03-list-my-pods-2.md",
    );
    // Taken by a file in tasks/.
    await Deno.mkdir(join(dir, "tasks"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "tasks", "2026-10-03-list-my-pods-2.md"),
      "x",
    );
    assertEquals(
      await repo.reserveBriefFile(dir, "2026-10-03T11:00:00Z", "List my pods"),
      "tasks/2026-10-03-list-my-pods-3.md",
    );
  });
});

Deno.test({
  name:
    "StartSessionFileRepository.save: refuses to write through a symlinked .swamp/start or tasks folder",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const ws = join(dir, "ws");
      const outside = join(dir, "outside");
      await Deno.mkdir(join(ws, ".swamp"), { recursive: true });
      await Deno.mkdir(outside);
      await Deno.symlink(outside, startDir(ws), { type: "dir" });
      const repo = new StartSessionFileRepository();
      const error = await assertRejects(
        () => repo.save(launchedTask(ws)),
        UserError,
      );
      assertEquals(error.code, "unsafe_path");
      assertEquals([...Deno.readDirSync(outside)], []);

      await Deno.remove(startDir(ws));
      await Deno.mkdir(join(startDir(ws), "tasks"), { recursive: true });
      await Deno.remove(join(startDir(ws), "tasks"));
      await Deno.symlink(outside, join(startDir(ws), "tasks"), {
        type: "dir",
      });
      await assertRejects(() => repo.save(launchedTask(ws)), UserError);
      assertEquals([...Deno.readDirSync(outside)], []);
    });
  },
});

Deno.test({
  name:
    "refuseSymlinks: refuses a symlinked file, allows missing and real paths",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, "real");
      const link = join(dir, "link");
      await Deno.writeTextFile(real, "x");
      await Deno.symlink(real, link, { type: "file" });
      await refuseSymlinks([real, join(dir, "missing")]);
      await assertRejects(() => refuseSymlinks([link]), UserError);
    });
  },
});

// ---------------------------------------------------------------------------
// Migration from the one-current-task layout
// ---------------------------------------------------------------------------

Deno.test("migrateLegacy: the current task and filed ones become task records with their briefs", async () => {
  await withTempDir(async (ws) => {
    const repo = new StartSessionFileRepository();
    const start = startDir(ws);
    // The old current task, launched, its brief at TASK.md.
    const current = launchedTask(ws);
    await writeLegacyState(join(start, "state.json"), current);
    await Deno.writeTextFile(
      join(ws, "TASK.md"),
      briefFor(ws, "list my pods\nin prod"),
    );
    // A filed task, its brief already in tasks/.
    const filed = legacyTask(ws, "List my VPCs", "2026-10-01T09:00:00Z");
    await writeLegacyState(
      join(start, "history", filed.id, "state.json"),
      filed,
    );
    await Deno.mkdir(join(ws, "tasks"), { recursive: true });
    await Deno.writeTextFile(
      join(ws, "tasks", "2026-10-01-list-my-vpcs.md"),
      briefFor(ws, "List my VPCs"),
    );
    await Deno.writeTextFile(
      join(start, "history", filed.id, "brief.json"),
      JSON.stringify({ file: "tasks/2026-10-01-list-my-vpcs.md" }),
    );

    // Listed read-only before migrating.
    assertEquals(
      (await repo.list(ws)).map((t) => t.id).sort(),
      [current.id, filed.id].sort(),
    );

    assertEquals(await repo.migrateLegacy(ws), { migrated: 2, kept: [] });

    const migratedCurrent = await repo.load(ws, current.id);
    assertEquals(migratedCurrent?.step, "launched");
    assertEquals(
      migratedCurrent?.briefFile,
      "tasks/2026-10-03-list-my-pods.md",
    );
    assertEquals(
      await Deno.readTextFile(join(ws, "tasks", "2026-10-03-list-my-pods.md")),
      briefFor(ws, "list my pods\nin prod"),
    );
    assertEquals(
      (await repo.load(ws, filed.id))?.briefFile,
      "tasks/2026-10-01-list-my-vpcs.md",
    );
    assert(!await exists(join(ws, "TASK.md")));
    assert(!await exists(join(start, "state.json")));
    assert(!await exists(join(start, "history")));

    // Running it again changes nothing.
    assertEquals(await repo.migrateLegacy(ws), { migrated: 0, kept: [] });
    assertEquals((await repo.list(ws)).length, 2);
  });
});

Deno.test("migrateLegacy: a TASK.md written for another task is never given to the current one", async () => {
  await withTempDir(async (ws) => {
    const repo = new StartSessionFileRepository();
    const start = startDir(ws);
    // The current task was reopened while another task's brief sat at
    // TASK.md; its own brief is the one filed in tasks/.
    const current = launchedTask(ws);
    await writeLegacyState(join(start, "state.json"), current);
    const otherBrief = briefFor(ws, "List my VPCs");
    await Deno.writeTextFile(join(ws, "TASK.md"), otherBrief);
    await Deno.mkdir(join(ws, "tasks"), { recursive: true });
    await Deno.writeTextFile(
      join(ws, "tasks", "2026-10-03-list-my-pods.md"),
      briefFor(ws, "list my pods\nin prod"),
    );

    assertEquals(await repo.migrateLegacy(ws), { migrated: 1, kept: [] });
    assertEquals(
      (await repo.load(ws, current.id))?.briefFile,
      "tasks/2026-10-03-list-my-pods.md",
    );
    // The unmatched TASK.md is left exactly where it was.
    assertEquals(await Deno.readTextFile(join(ws, "TASK.md")), otherBrief);
    assertEquals(
      [...Deno.readDirSync(join(ws, "tasks"))].map((e) => e.name),
      ["2026-10-03-list-my-pods.md"],
    );
  });
});

Deno.test("migrateLegacy: an unlaunched current task keeps no brief; an empty one is dropped", async () => {
  await withTempDir(async (ws) => {
    const repo = new StartSessionFileRepository();
    const start = startDir(ws);
    const draft = legacyTask(ws, "Watch my queues", "2026-10-02T09:00:00Z");
    await writeLegacyState(join(start, "state.json"), draft);
    assertEquals(await repo.migrateLegacy(ws), { migrated: 1, kept: [] });
    const task = await repo.load(ws, draft.id);
    assertEquals(task?.step, "agent");
    assertEquals(task?.briefFile, undefined);

    const empty = StartSession.create(crypto.randomUUID(), ws, CREATED);
    await writeLegacyState(join(start, "state.json"), empty);
    assertEquals(await repo.migrateLegacy(ws), { migrated: 0, kept: [] });
    assert(!await exists(join(start, "state.json")));
    assertEquals((await repo.list(ws)).length, 1);
  });
});

Deno.test("migrateLegacy: a TASK.md swamp didn't write is left alone", async () => {
  await withTempDir(async (ws) => {
    const repo = new StartSessionFileRepository();
    await writeLegacyState(join(startDir(ws), "state.json"), launchedTask(ws));
    await Deno.writeTextFile(join(ws, "TASK.md"), "my own notes");
    assertEquals((await repo.migrateLegacy(ws)).migrated, 1);
    assertEquals(await Deno.readTextFile(join(ws, "TASK.md")), "my own notes");
    const [task] = await repo.list(ws);
    // No brief was taken over: it gets one at its next launch.
    assertEquals(task.briefFile, undefined);
    assertEquals(task.step, "launched");
  });
});

Deno.test("migrateLegacy: unreadable old files are kept, never deleted", async () => {
  await withTempDir(async (ws) => {
    const repo = new StartSessionFileRepository();
    const start = startDir(ws);
    await Deno.mkdir(join(start, "history", "abc"), { recursive: true });
    await Deno.writeTextFile(join(start, "state.json"), "{ damaged");
    await Deno.writeTextFile(
      join(start, "history", "abc", "state.json"),
      "nope",
    );
    const result = await repo.migrateLegacy(ws);
    assertEquals(result.migrated, 0);
    assertEquals(result.kept.length, 2);
    assert(result.kept[0].includes("state.json.unreadable-"));
    assertEquals(await Deno.readTextFile(result.kept[0]), "{ damaged");
    assertEquals(
      await Deno.readTextFile(join(start, "history", "abc", "state.json")),
      "nope",
    );
    assertEquals(await repo.list(ws), []);
  });
});
