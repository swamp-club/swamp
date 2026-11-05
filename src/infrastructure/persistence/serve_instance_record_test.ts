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
import {
  listServeInstances,
  removeServeInstanceRecord,
  type ServeInstanceRecord,
  writeServeInstanceRecord,
} from "./serve_instance_record.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-instance-" });
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

function record(pid: number, startedAt: string): ServeInstanceRecord {
  return {
    pid,
    host: "127.0.0.1",
    port: 9190,
    url: "http://127.0.0.1:9190",
    authMode: "none",
    dashboard: true,
    startedAt,
    version: "dev",
  };
}

Deno.test("listServeInstances: lists live serves oldest first and prunes dead ones", async () => {
  await withTempDir(async (repo) => {
    await writeServeInstanceRecord(repo, record(20, "2026-11-05T12:00:00Z"));
    await writeServeInstanceRecord(repo, record(10, "2026-11-05T11:00:00Z"));
    await writeServeInstanceRecord(repo, record(30, "2026-11-05T13:00:00Z"));
    const alive = new Set([10, 20]);
    const listed = await listServeInstances(repo, (pid) => alive.has(pid));
    assertEquals(listed.map((r) => r.pid), [10, 20]);
    const remaining = await Array.fromAsync(
      Deno.readDir(join(repo, ".swamp", "serve-instances")),
    );
    assertEquals(remaining.map((e) => e.name).sort(), ["10.json", "20.json"]);
  });
});

Deno.test("listServeInstances: ignores a missing folder, malformed records and misnamed files", async () => {
  await withTempDir(async (repo) => {
    assertEquals(await listServeInstances(repo, () => true), []);
    await writeServeInstanceRecord(repo, record(10, "2026-11-05T11:00:00Z"));
    const dir = join(repo, ".swamp", "serve-instances");
    await Deno.writeTextFile(join(dir, "11.json"), "{not json");
    await Deno.writeTextFile(
      join(dir, "99.json"),
      JSON.stringify(record(12, "2026-11-05T11:00:00Z")),
    );
    assertEquals(
      (await listServeInstances(repo, () => true)).map((r) => r.pid),
      [10],
    );
  });
});

Deno.test("removeServeInstanceRecord: removes its own record and tolerates a missing one", async () => {
  await withTempDir(async (repo) => {
    await writeServeInstanceRecord(repo, record(10, "2026-11-05T11:00:00Z"));
    await removeServeInstanceRecord(repo, 10);
    await removeServeInstanceRecord(repo, 10);
    assertEquals(await listServeInstances(repo, () => true), []);
  });
});

Deno.test({
  name: "writeServeInstanceRecord: refuses a planted symlink for its folder",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repo) => {
      const elsewhere = join(repo, "elsewhere");
      await Deno.mkdir(elsewhere);
      await Deno.mkdir(join(repo, ".swamp"));
      await Deno.symlink(elsewhere, join(repo, ".swamp", "serve-instances"), {
        type: "dir",
      });
      await assertRejects(() =>
        writeServeInstanceRecord(repo, record(10, "2026-11-05T11:00:00Z"))
      );
      assertEquals(await listServeInstances(repo, () => true), []);
    });
  },
});
