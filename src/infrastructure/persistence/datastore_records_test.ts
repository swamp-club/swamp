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
import {
  checkoutRecordSubdirs,
  hasDatastoreRecords,
  subdirsHoldingRecords,
} from "./datastore_records.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-records-" });
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

async function plant(dir: string, ...segments: string[]): Promise<void> {
  await Deno.mkdir(join(dir, ...segments.slice(0, -1)), { recursive: true });
  await Deno.writeTextFile(join(dir, ...segments), "x");
}

Deno.test("checkoutRecordSubdirs: leaves out the always-local and repo-local stream subdirectories", () => {
  const subdirs = checkoutRecordSubdirs();
  for (const local of ["secrets", "bundles", "logs", "telemetry", "audit"]) {
    assertEquals(subdirs.includes(local), false, local);
  }
  for (const record of ["data", "outputs", "workflow-runs"]) {
    assertEquals(subdirs.includes(record), true, record);
  }
});

Deno.test("hasDatastoreRecords: finds a file under a subdir, skipping skipped paths and missing subdirs", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await hasDatastoreRecords(dir, ["data"], []), false);
    await plant(dir, "data", "_catalog.db");
    assertEquals(
      await hasDatastoreRecords(dir, ["data"], [join("data", "_catalog.db")]),
      false,
    );
    await plant(dir, "logs", "a.log");
    assertEquals(await hasDatastoreRecords(dir, ["data", "outputs"], []), true);
    assertEquals(await hasDatastoreRecords(dir, ["outputs"], []), false);
  });
});

Deno.test("subdirsHoldingRecords: names every subdir holding a file, in order", async () => {
  await withTempDir(async (dir) => {
    await plant(dir, "outputs", "m", "out.yaml");
    await plant(dir, "data", "m", "log", "1", "raw");
    await Deno.mkdir(join(dir, "workflow-runs"));
    assertEquals(
      await subdirsHoldingRecords(
        dir,
        ["data", "outputs", "workflow-runs"],
        [],
      ),
      ["data", "outputs"],
    );
  });
});
