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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { AiTool } from "../../../repo/repo_service.ts";
import type { CheckContext } from "../check.ts";
import { makeSwampBinaryOnPathCheck } from "./swamp_binary_on_path.ts";

async function withTempRepo<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const repo = await Deno.makeTempDir({ prefix: "doctor-swamp-bin-test-" });
  try {
    return await fn(repo);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
}

function makeCtx(repoPath: string, tool: AiTool): CheckContext {
  return {
    repoPath,
    auditDir: join(repoPath, ".swamp", "audit"),
    tool,
    abortSignal: new AbortController().signal,
    spawnSwamp: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

Deno.test("swampBinaryOnPath: fails when swamp is not on PATH", async () => {
  const check = makeSwampBinaryOnPathCheck({
    resolveBinary: () => Promise.resolve(null),
  });
  await withTempRepo(async (repo) => {
    const result = await check.run(makeCtx(repo, "claude"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "not on PATH");
  });
});

Deno.test("swampBinaryOnPath: passes for all tools when PATH resolves", async () => {
  const check = makeSwampBinaryOnPathCheck({
    resolveBinary: () => Promise.resolve("/usr/local/bin/swamp"),
  });
  await withTempRepo(async (repo) => {
    for (
      const tool of [
        "claude",
        "cursor",
        "kiro",
        "opencode",
        "copilot",
        "pi",
        "antigravity",
      ] as const
    ) {
      const result = await check.run(makeCtx(repo, tool));
      assertEquals(result.status, "pass", `failed for tool ${tool}`);
      assertStringIncludes(result.message, "/usr/local/bin/swamp");
    }
  });
});
