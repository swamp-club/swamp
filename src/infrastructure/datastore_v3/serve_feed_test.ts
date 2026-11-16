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
import { v3FollowerWalBytes } from "./serve_feed.ts";
import { v3CommitsDbPath } from "./v3_datastore.ts";

Deno.test("v3FollowerWalBytes: the copy's WAL size, and 0 with no WAL", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-follower-wal-" });
  try {
    const datastorePath = join(dir, "store");
    const repoDir = join(dir, "repo");
    await Deno.mkdir(datastorePath, { recursive: true });
    await Deno.mkdir(repoDir, { recursive: true });
    const config = { type: "filesystem", path: datastorePath } as const;
    assertEquals(await v3FollowerWalBytes(repoDir, config), 0);
    const wal = `${v3CommitsDbPath(datastorePath, repoDir)}-wal`;
    await Deno.writeFile(wal, new Uint8Array(4096));
    assertEquals(await v3FollowerWalBytes(repoDir, config), 4096);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
