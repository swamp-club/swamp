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
import { agentConfigLoadableCheck } from "./agent_config_loadable.ts";

async function withTempRepo<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const repo = await Deno.makeTempDir({ prefix: "doctor-cfg-test-" });
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(join(path, ".."));
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}

Deno.test("agentConfigLoadable: kiro passes for a well-formed config", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".kiro/agents/swamp.json"), {
      name: "swamp",
      tools: ["read", "write", "shell"],
      hooks: { postToolUse: [{ command: "swamp audit record --from-hook" }] },
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "pass");
  });
});

Deno.test(`agentConfigLoadable: kiro fails when tools contains "*"`, async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".kiro/agents/swamp.json"), {
      name: "swamp",
      tools: ["*"],
      hooks: { postToolUse: [{ command: "swamp audit record --from-hook" }] },
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, `"*"`);
    assertStringIncludes(result.hint ?? "", "swamp init --tool kiro --force");
  });
});

Deno.test("agentConfigLoadable: kiro fails when file is missing", async () => {
  await withTempRepo(async (repo) => {
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "missing");
  });
});

Deno.test("agentConfigLoadable: kiro fails on malformed JSON", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".kiro/agents/swamp.json");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(path, "{ not json");
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "could not be parsed");
  });
});

Deno.test("agentConfigLoadable: claude passes for a well-formed config", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".claude/settings.local.json"), {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "swamp audit record --from-hook" },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "swamp audit record --from-hook" },
            ],
          },
        ],
      },
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "claude"));
    assertEquals(result.status, "pass");
  });
});

Deno.test(
  "agentConfigLoadable: claude fails when PostToolUseFailure is missing",
  async () => {
    await withTempRepo(async (repo) => {
      await writeJson(join(repo, ".claude/settings.local.json"), {
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "swamp audit record --from-hook" },
              ],
            },
          ],
        },
      });
      const result = await agentConfigLoadableCheck.run(
        makeCtx(repo, "claude"),
      );
      assertEquals(result.status, "fail");
    });
  },
);

Deno.test("agentConfigLoadable: cursor passes for a well-formed config", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".cursor/hooks.json"), {
      version: 1,
      hooks: {
        postToolUse: [
          { command: "swamp audit record --from-hook --tool cursor" },
        ],
        postToolUseFailure: [
          { command: "swamp audit record --from-hook --tool cursor" },
        ],
      },
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "cursor"));
    assertEquals(result.status, "pass");
  });
});

Deno.test("agentConfigLoadable: opencode passes when plugin file references swamp", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".opencode/plugins/swamp-audit.ts");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(
      path,
      `Bun.spawn(["swamp", "audit", "record", "--from-hook", "--tool", "opencode"], ...)`,
    );
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "opencode"),
    );
    assertEquals(result.status, "pass");
  });
});

Deno.test("agentConfigLoadable: opencode fails when plugin does not reference swamp", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".opencode/plugins/swamp-audit.ts");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(path, "// nothing");
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "opencode"),
    );
    assertEquals(result.status, "fail");
  });
});
