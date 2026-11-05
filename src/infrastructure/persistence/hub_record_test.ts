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
import { join } from "@std/path";
import { hubDir, hubRecordPath, readHubRecord } from "./hub_record.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-hub-test-" });
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

const record = {
  pid: 4242,
  port: 51234,
  adminToken: "admin",
  version: "1.0.0",
  gitSha: "go-sha",
  engine: "/usr/local/bin/swamp",
  engineVersion: "2.0.0",
  engineGitSha: "ts-sha",
  autoExit: true,
};

Deno.test("readHubRecord: none before a hub has run", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await readHubRecord(dir), null);
  });
});

Deno.test("readHubRecord: reads the record the hub wrote", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(hubDir(dir));
    await Deno.writeTextFile(hubRecordPath(dir), JSON.stringify(record));
    assertEquals(await readHubRecord(dir), record);
  });
});

Deno.test("readHubRecord: a damaged or half-written record is no record", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(hubDir(dir));
    for (const raw of ["{", JSON.stringify({ ...record, port: 0 }), "null"]) {
      await Deno.writeTextFile(hubRecordPath(dir), raw);
      assertEquals(await readHubRecord(dir), null, raw);
    }
  });
});

Deno.test("readHubRecord: a record behind a planted link is never trusted", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (dir) => {
    const elsewhere = join(dir, "elsewhere");
    await Deno.mkdir(elsewhere);
    await Deno.writeTextFile(
      join(elsewhere, "hub.json"),
      JSON.stringify(record),
    );
    await Deno.symlink(elsewhere, hubDir(dir), { type: "dir" });
    assertEquals(await readHubRecord(dir), null);
  });
});
