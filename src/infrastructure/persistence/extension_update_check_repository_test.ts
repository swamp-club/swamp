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
import { FileExtensionUpdateCheckRepository } from "./extension_update_check_repository.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-ext-update-check-test-",
  });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("FileExtensionUpdateCheckRepository: read returns empty map when file missing", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileExtensionUpdateCheckRepository(dir);
    const data = await repo.read();
    assertEquals(data, {});
  });
});

Deno.test("FileExtensionUpdateCheckRepository: write and read roundtrip", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileExtensionUpdateCheckRepository(dir);
    const entry = {
      "@swamp/s3-datastore": {
        checkedAt: "2026-03-30T12:00:00.000Z",
        latestVersion: "2026.03.30.1",
      },
    };
    await repo.write(entry);
    const data = await repo.read();
    assertEquals(data, entry);
  });
});

Deno.test("FileExtensionUpdateCheckRepository: read returns empty map for corrupt JSON", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/extension-update-checks.json`,
      "not json",
    );
    const repo = new FileExtensionUpdateCheckRepository(dir);
    const data = await repo.read();
    assertEquals(data, {});
  });
});

Deno.test("FileExtensionUpdateCheckRepository: write is atomic (no partial-write visibility)", async () => {
  await withTempDir(async (dir) => {
    const repo = new FileExtensionUpdateCheckRepository(dir);
    const initial = {
      "@swamp/initial": {
        checkedAt: "2026-03-30T12:00:00.000Z",
        latestVersion: "2026.03.30.1",
      },
    };
    await repo.write(initial);

    // Concurrent writers must not corrupt the file: reads always see
    // a consistent committed map (either the initial value or one of
    // the writers' values), never a partial JSON document.
    const writers = Array.from({ length: 8 }, (_, i) => ({
      [`@swamp/writer-${i}`]: {
        checkedAt: "2026-04-01T00:00:00.000Z",
        latestVersion: `2026.04.01.${i}`,
      },
    }));
    await Promise.all(writers.map((data) => repo.write(data)));

    // Final read must succeed (atomic rename guarantees a complete file).
    const final = await repo.read();
    // One of the writers' maps wins (last-writer-wins on the whole map);
    // the file is never garbage.
    assertEquals(typeof final, "object");
    assertEquals(Object.keys(final).length, 1);
  });
});
