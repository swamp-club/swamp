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
import { AutoupdateLogFileRepository } from "./autoupdate_log_file_repository.ts";
import type { AutoupdateLogEntry } from "../../domain/update/autoupdate_log.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function makeEntry(
  overrides?: Partial<AutoupdateLogEntry>,
): AutoupdateLogEntry {
  return {
    timestamp: new Date().toISOString(),
    versionBefore: "20260501.120000.0-sha.abc123",
    versionAfter: null,
    outcome: "up_to_date",
    ...overrides,
  };
}

Deno.test("AutoupdateLogFileRepository: readAll returns empty for missing file", async () => {
  await withTempDir(async (dir) => {
    const repo = new AutoupdateLogFileRepository(
      join(dir, "nonexistent.log"),
    );
    const entries = await repo.readAll();
    assertEquals(entries, []);
  });
});

Deno.test("AutoupdateLogFileRepository: append and readAll round-trip", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "log", "autoupdate.log");
    const repo = new AutoupdateLogFileRepository(filePath);

    const entry1 = makeEntry({ outcome: "up_to_date" });
    const entry2 = makeEntry({
      outcome: "updated",
      versionAfter: "20260502.120000.0-sha.def456",
    });

    await repo.append(entry1);
    await repo.append(entry2);

    const entries = await repo.readAll();
    assertEquals(entries.length, 2);
    assertEquals(entries[0].outcome, "up_to_date");
    assertEquals(entries[1].outcome, "updated");
    assertEquals(entries[1].versionAfter, "20260502.120000.0-sha.def456");
  });
});

Deno.test("AutoupdateLogFileRepository: readAll skips malformed lines", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "autoupdate.log");
    const validEntry = makeEntry();
    await Deno.writeTextFile(
      filePath,
      `${JSON.stringify(validEntry)}\nnot json\n${
        JSON.stringify(validEntry)
      }\n`,
    );

    const repo = new AutoupdateLogFileRepository(filePath);
    const entries = await repo.readAll();
    assertEquals(entries.length, 2);
  });
});

Deno.test("AutoupdateLogFileRepository: prune removes old entries", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "autoupdate.log");
    const repo = new AutoupdateLogFileRepository(filePath);

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);

    const oldEntry = makeEntry({ timestamp: oldDate.toISOString() });
    const recentEntry = makeEntry({ timestamp: new Date().toISOString() });

    await repo.append(oldEntry);
    await repo.append(recentEntry);

    await repo.prune(30);

    const entries = await repo.readAll();
    assertEquals(entries.length, 1);
    assertEquals(entries[0].timestamp, recentEntry.timestamp);
  });
});

Deno.test("AutoupdateLogFileRepository: prune keeps all entries within retention", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "autoupdate.log");
    const repo = new AutoupdateLogFileRepository(filePath);

    const entry1 = makeEntry();
    const entry2 = makeEntry();

    await repo.append(entry1);
    await repo.append(entry2);

    await repo.prune(30);

    const entries = await repo.readAll();
    assertEquals(entries.length, 2);
  });
});

Deno.test("AutoupdateLogFileRepository: append creates parent directories", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "nested", "dirs", "autoupdate.log");
    const repo = new AutoupdateLogFileRepository(filePath);

    await repo.append(makeEntry());
    const entries = await repo.readAll();
    assertEquals(entries.length, 1);
  });
});
