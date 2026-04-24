// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { defaultAgentSetCheck } from "./default_agent_set.ts";

async function withTempRepo<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const repo = await Deno.makeTempDir({ prefix: "doctor-agent-test-" });
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

Deno.test("defaultAgentSet: passes when chat.defaultAgent === 'swamp'", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".kiro/settings/cli.json");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(
      path,
      JSON.stringify({ "chat.defaultAgent": "swamp" }),
    );
    const result = await defaultAgentSetCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "pass");
  });
});

Deno.test("defaultAgentSet: fails when chat.defaultAgent is unset", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".kiro/settings/cli.json");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(path, JSON.stringify({}));
    const result = await defaultAgentSetCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "unset");
  });
});

Deno.test("defaultAgentSet: fails when chat.defaultAgent points elsewhere", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".kiro/settings/cli.json");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(
      path,
      JSON.stringify({ "chat.defaultAgent": "kiro_default" }),
    );
    const result = await defaultAgentSetCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "kiro_default");
  });
});

Deno.test("defaultAgentSet: fails when the file is missing", async () => {
  await withTempRepo(async (repo) => {
    const result = await defaultAgentSetCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "missing");
  });
});

Deno.test("defaultAgentSet: appliesTo only returns true for kiro", () => {
  assertEquals(defaultAgentSetCheck.appliesTo("kiro"), true);
  assertEquals(defaultAgentSetCheck.appliesTo("claude"), false);
  assertEquals(defaultAgentSetCheck.appliesTo("cursor"), false);
  assertEquals(defaultAgentSetCheck.appliesTo("opencode"), false);
});
