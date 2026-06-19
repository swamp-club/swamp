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
import { ensureDir } from "@std/fs";
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

async function writeKiroHook(repo: string, swampPath: string): Promise<void> {
  const path = join(repo, ".kiro/hooks/swamp-audit.kiro.hook");
  await ensureDir(join(path, ".."));
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      name: "Swamp Audit",
      version: "1",
      when: { type: "postToolUse", toolTypes: ["*"] },
      then: {
        type: "runCommand",
        command: `"${swampPath}" audit record --from-hook --tool kiro`,
        timeout: 5,
      },
    }),
  );
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

Deno.test("swampBinaryOnPath: passes for non-kiro when PATH resolves", async () => {
  const check = makeSwampBinaryOnPathCheck({
    resolveBinary: () => Promise.resolve("/usr/local/bin/swamp"),
  });
  await withTempRepo(async (repo) => {
    for (const tool of ["claude", "cursor", "opencode", "copilot"] as const) {
      const result = await check.run(makeCtx(repo, tool));
      assertEquals(result.status, "pass", `failed for tool ${tool}`);
    }
  });
});

Deno.test("swampBinaryOnPath: kiro passes when baked path exists", async () => {
  const check = makeSwampBinaryOnPathCheck({
    resolveBinary: () => Promise.resolve("/usr/local/bin/swamp"),
  });
  await withTempRepo(async (repo) => {
    const fakeBinary = await Deno.makeTempFile({ prefix: "fake-swamp-" });
    try {
      await writeKiroHook(repo, fakeBinary);
      const result = await check.run(makeCtx(repo, "kiro"));
      assertEquals(result.status, "pass");
      assertStringIncludes(result.message, fakeBinary);
    } finally {
      await Deno.remove(fakeBinary);
    }
  });
});

Deno.test("swampBinaryOnPath: kiro fails when baked path is stale", async () => {
  const check = makeSwampBinaryOnPathCheck({
    resolveBinary: () => Promise.resolve("/usr/local/bin/swamp"),
  });
  await withTempRepo(async (repo) => {
    await writeKiroHook(repo, "/nonexistent/swamp");
    const result = await check.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "/nonexistent/swamp");
    assertStringIncludes(result.hint ?? "", "re-bake");
  });
});

Deno.test("swampBinaryOnPath: kiro fails when hook file is missing", async () => {
  const check = makeSwampBinaryOnPathCheck({
    resolveBinary: () => Promise.resolve("/usr/local/bin/swamp"),
  });
  await withTempRepo(async (repo) => {
    const result = await check.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "missing");
  });
});
