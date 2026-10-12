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
import { join } from "@std/path";
import {
  readStartServerRecords,
  removeStartServerRecord,
  type StartServerRecord,
  writeStartServerRecord,
} from "./start_server_record.ts";
import { startDir } from "./start_session_file_repository.ts";
import { UserError } from "../../domain/errors.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-start-record-" });
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

const record = (pid: number): StartServerRecord => ({
  pid,
  port: 40000 + pid,
  token: `token-${pid}`,
  startedAt: "2026-10-11T10:00:00.000Z",
});

Deno.test("readStartServerRecords: none when no swamp start has the workspace open", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await readStartServerRecords(dir), []);
  });
});

Deno.test("writeStartServerRecord: one record per process, read back together", async () => {
  await withTempDir(async (dir) => {
    await writeStartServerRecord(dir, record(101));
    await writeStartServerRecord(dir, record(202));
    const pids = (await readStartServerRecords(dir)).map((r) => r.pid).sort();
    assertEquals(pids, [101, 202]);
    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(
        join(startDir(dir), "servers", "101.json"),
      )).mode!;
      assertEquals(mode & 0o777, 0o600);
    }
  });
});

Deno.test("removeStartServerRecord: removes only that process's record, and tolerates a missing one", async () => {
  await withTempDir(async (dir) => {
    await writeStartServerRecord(dir, record(101));
    await writeStartServerRecord(dir, record(202));
    await removeStartServerRecord(dir, 101);
    await removeStartServerRecord(dir, 999);
    assertEquals((await readStartServerRecords(dir)).map((r) => r.pid), [202]);
  });
});

Deno.test("readStartServerRecords: skips unreadable records", async () => {
  await withTempDir(async (dir) => {
    await writeStartServerRecord(dir, record(101));
    await Deno.writeTextFile(join(startDir(dir), "servers", "7.json"), "{bad");
    const records = await readStartServerRecords(dir);
    assert(records.length === 1 && records[0].pid === 101);
  });
});

Deno.test({
  name:
    "start server records: never written, read or removed through a symlinked folder",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const ws = join(dir, "ws");
      const outside = join(dir, "outside");
      await Deno.mkdir(startDir(ws), { recursive: true });
      await Deno.mkdir(outside);
      await Deno.writeTextFile(
        join(outside, "7.json"),
        JSON.stringify(record(7)),
      );
      await Deno.symlink(outside, join(startDir(ws), "servers"), {
        type: "dir",
      });
      const error = await assertRejects(
        () => writeStartServerRecord(ws, record(101)),
        UserError,
      );
      assertEquals(error.code, "unsafe_path");
      assertEquals(await readStartServerRecords(ws), []);
      await assertRejects(() => removeStartServerRecord(ws, 7), UserError);
      assertEquals(
        [...Deno.readDirSync(outside)].map((e) => e.name),
        ["7.json"],
      );
    });
  },
});

Deno.test("readStartServerRecords: skips a record whose file name isn't its pid", async () => {
  await withTempDir(async (dir) => {
    await writeStartServerRecord(dir, record(101));
    const folder = join(startDir(dir), "servers");
    // A record that claims pid 101 under another name, as an imported repo
    // could carry: never read, so pruning by pid can't reach this file.
    await Deno.writeTextFile(
      join(folder, "999.json"),
      JSON.stringify(record(101)),
    );
    const read = await readStartServerRecords(dir);
    assertEquals(read.map((r) => r.pid), [101]);
    await removeStartServerRecord(dir, 101);
    assertEquals(
      [...Deno.readDirSync(folder)].map((e) => e.name),
      ["999.json"],
    );
  });
});
