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
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { containedLogFileReader } from "./log_file_containment.ts";

Deno.test("containedLogFileReader: reads a run's log, and answers a path outside the run-log directories as empty, unread", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-log-contain-" });
  try {
    const read: string[] = [];
    const reader = containedLogFileReader(repoDir, (path: string) => {
      read.push(path);
      return Promise.resolve({ lines: ["hello"], path });
    });
    const inside = join(
      swampPath(repoDir, "workflow-runs"),
      "wf",
      "workflow-run-1.log",
    );
    await Deno.mkdir(join(swampPath(repoDir, "workflow-runs"), "wf"), {
      recursive: true,
    });
    await Deno.writeTextFile(inside, "hello\n");
    assertEquals((await reader(inside)).lines, ["hello"]);
    for (const outside of ["/etc/passwd", swampPath(repoDir, "serve.yaml")]) {
      assertEquals((await reader(outside)).lines, []);
    }
    assertEquals(read, [inside]);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
