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
import { parse as parseYaml } from "@std/yaml";
import {
  removeHostedWorkspaceStatus,
  writeHostedWorkspaceStatus,
} from "./hosted_workspace_status_file.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

Deno.test("writeHostedWorkspaceStatus: writes the state, restarts and reason beside the folder", async () => {
  await withTempDir(async (dir) => {
    const status = {
      state: "failed",
      wanted: "active",
      restarts: 3,
      reason: "line one\nline two",
      updatedAt: "2026-11-17T10:00:00.000Z",
    } as const;
    await writeHostedWorkspaceStatus(dir, "edge-dns", status);
    assertEquals(
      parseYaml(await Deno.readTextFile(join(dir, "edge-dns.status.yaml"))),
      status,
    );
    await removeHostedWorkspaceStatus(dir, "edge-dns");
    await removeHostedWorkspaceStatus(dir, "edge-dns");
    assertEquals([...Deno.readDirSync(dir)], []);
  });
});
