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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  MAX_STATUS_FILE_BYTES,
  readHostedWorkspaceStatus,
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

Deno.test("readHostedWorkspaceStatus: reads back what the host wrote", async () => {
  await withTempDir(async (dir) => {
    const status = {
      state: "backoff",
      wanted: "active",
      restarts: 2,
      reason: "exited with code 1",
      updatedAt: "2026-11-17T10:00:00.000Z",
    } as const;
    await writeHostedWorkspaceStatus(dir, "edge-dns", status);
    assertEquals(await readHostedWorkspaceStatus(dir, "edge-dns"), {
      kind: "found",
      status,
    });
  });
});

Deno.test("readHostedWorkspaceStatus: a workspace with no status file is absent", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await readHostedWorkspaceStatus(dir, "edge-dns"), {
      kind: "absent",
    });
  });
});

Deno.test("readHostedWorkspaceStatus: reports a file it cannot read instead of throwing", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "edge-dns.status.yaml");
    const cases: [string, string][] = [
      ["state: [unclosed", "not valid YAML"],
      [
        "state: asleep\nwanted: active\nrestarts: 0\nreason: null\nupdatedAt: x",
        "state",
      ],
      [
        "state: ready\nwanted: active\nrestarts: 0\nreason: null\nupdatedAt: x\nextra: 1",
        "extra",
      ],
      ["x".repeat(MAX_STATUS_FILE_BYTES + 1), "larger than"],
    ];
    for (const [text, expected] of cases) {
      await Deno.writeTextFile(path, text);
      const read = await readHostedWorkspaceStatus(dir, "edge-dns");
      assert(read.kind === "unreadable", text.slice(0, 40));
      assertStringIncludes(read.reason, expected);
    }
    await Deno.remove(path);
    await Deno.mkdir(path);
    const read = await readHostedWorkspaceStatus(dir, "edge-dns");
    assert(read.kind === "unreadable");
    assertStringIncludes(read.reason, "not a regular file");
  });
});
