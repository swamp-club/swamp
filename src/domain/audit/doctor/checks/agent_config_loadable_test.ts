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
      hooks: {
        postToolUse: [{
          command: "swamp audit record --from-hook --tool kiro",
        }],
      },
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "pass");
  });
});

Deno.test("agentConfigLoadable: kiro passes for an object-form hook with an absolute swamp path", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".kiro/agents/swamp.json"), {
      name: "swamp",
      tools: ["read", "write", "shell"],
      hooks: {
        postToolUse: [{
          command:
            '"/usr/local/bin/swamp" audit record --from-hook --tool kiro',
        }],
      },
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "pass");
  });
});

Deno.test("agentConfigLoadable: kiro fails when object-form hooks lack the audit hook", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".kiro/agents/swamp.json"), {
      name: "swamp",
      tools: ["read", "write", "shell"],
      hooks: { postToolUse: [{ command: "npm run lint" }] },
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "postToolUse");
  });
});

Deno.test("agentConfigLoadable: kiro passes for the universal array-form hooks", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".kiro/agents/swamp.json"), {
      name: "swamp",
      tools: ["read", "shell", "write"],
      hooks: [{
        name: "swamp-audit",
        trigger: "postToolUse",
        action: {
          type: "command",
          command: "swamp audit record --from-hook --tool kiro",
        },
        timeout: 10,
      }],
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "pass");
  });
});

Deno.test("agentConfigLoadable: kiro fails when array-form hooks lack the audit hook", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".kiro/agents/swamp.json"), {
      name: "swamp",
      tools: ["read", "shell", "write"],
      hooks: [{
        name: "lint",
        trigger: "postToolUse",
        action: { type: "command", command: "npm run lint" },
      }],
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "postToolUse");
  });
});

Deno.test("agentConfigLoadable: kiro fails when no hooks are configured", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".kiro/agents/swamp.json"), {
      name: "swamp",
      tools: ["read", "shell", "write"],
    });
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "kiro"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "postToolUse");
  });
});

Deno.test(`agentConfigLoadable: kiro fails when tools contains "*"`, async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".kiro/agents/swamp.json"), {
      name: "swamp",
      tools: ["*"],
      hooks: {
        postToolUse: [{
          command: "swamp audit record --from-hook --tool kiro",
        }],
      },
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
      `Bun.spawn(["swamp", "audit", "record", "--from-hook", "--tool", "opencode"], ...)
export default { id: "swamp.audit", server: SwampAudit, async setup(ctx) {} };`,
    );
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "opencode"),
    );
    assertEquals(result.status, "pass");
  });
});

Deno.test("agentConfigLoadable: opencode fails on a plugin written before OpenCode 2 support", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".opencode/plugins/swamp-audit.ts");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(
      path,
      `export const SwampAudit = async ({ directory }) => ({});
Bun.spawn(["swamp", "audit", "record", "--from-hook", "--tool", "opencode"], ...)`,
    );
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "opencode"),
    );
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "predates OpenCode 2");
    assertStringIncludes(result.hint ?? "", "OpenCode 1.3.4");
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

Deno.test("agentConfigLoadable: copilot passes for a well-formed config", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".github/hooks/swamp-audit.json"), {
      version: 1,
      hooks: {
        postToolUse: [
          {
            type: "command",
            command: "swamp audit record --from-hook --tool copilot",
          },
        ],
        postToolUseFailure: [
          {
            type: "command",
            command: "swamp audit record --from-hook --tool copilot",
          },
        ],
      },
    });
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "copilot"),
    );
    assertEquals(result.status, "pass");
  });
});

Deno.test("agentConfigLoadable: copilot fails when file is missing", async () => {
  await withTempRepo(async (repo) => {
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "copilot"),
    );
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "missing");
  });
});

Deno.test("agentConfigLoadable: copilot fails on malformed JSON", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".github/hooks/swamp-audit.json");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(path, "{ not json");
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "copilot"),
    );
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "could not be parsed");
  });
});

Deno.test("agentConfigLoadable: copilot fails when hooks are missing", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".github/hooks/swamp-audit.json"), {
      version: 1,
      hooks: {},
    });
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "copilot"),
    );
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "postToolUse/postToolUseFailure");
  });
});

Deno.test("agentConfigLoadable: copilot fails when hooks do not reference swamp audit record", async () => {
  await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".github/hooks/swamp-audit.json"), {
      version: 1,
      hooks: {
        postToolUse: [{ type: "command", command: "echo hello" }],
        postToolUseFailure: [{ type: "command", command: "echo fail" }],
      },
    });
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "copilot"),
    );
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "swamp audit record");
  });
});

Deno.test("agentConfigLoadable: pi passes when extension file references swamp", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".pi/extensions/swamp-audit.ts");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(
      path,
      `spawn("swamp", ["audit", "record", "--from-hook", "--tool", "pi"], ...)`,
    );
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "pi"));
    assertEquals(result.status, "pass");
  });
});

Deno.test("agentConfigLoadable: pi fails when extension file is missing", async () => {
  await withTempRepo(async (repo) => {
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "pi"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "missing");
  });
});

Deno.test("agentConfigLoadable: pi fails when extension does not reference swamp", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".pi/extensions/swamp-audit.ts");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(path, "// nothing");
    const result = await agentConfigLoadableCheck.run(makeCtx(repo, "pi"));
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "swamp audit record");
  });
});

Deno.test("agentConfigLoadable: antigravity passes when hooks.json references swamp audit record", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".agents/hooks.json");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        "swamp-audit": {
          enabled: true,
          PostToolUse: [{
            matcher: "run_command",
            hooks: [{
              type: "command",
              command: "swamp audit record --from-hook --tool antigravity",
            }],
          }],
        },
      }),
    );
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "antigravity"),
    );
    assertEquals(result.status, "pass");
  });
});

Deno.test("agentConfigLoadable: antigravity fails when hooks.json is missing", async () => {
  await withTempRepo(async (repo) => {
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "antigravity"),
    );
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "missing");
  });
});

Deno.test("agentConfigLoadable: antigravity fails when hooks.json does not reference swamp", async () => {
  await withTempRepo(async (repo) => {
    const path = join(repo, ".agents/hooks.json");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(path, JSON.stringify({ other: {} }));
    const result = await agentConfigLoadableCheck.run(
      makeCtx(repo, "antigravity"),
    );
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "swamp audit record");
  });
});

// duplicate audit hooks: each copy records every tool call

const CLAUDE_AUDIT = "swamp audit record --from-hook";
const BACKGROUNDED_AUDIT =
  "payload=$(cat); (printf '%s' \"$payload\" | swamp audit record --from-hook >/dev/null 2>&1 &)";

function claudeEntry(command: string, matcher = "Bash") {
  return { matcher, hooks: [{ type: "command", command }] };
}

async function claudeResult(hooks: unknown) {
  return await withTempRepo(async (repo) => {
    await writeJson(join(repo, ".claude/settings.local.json"), { hooks });
    return await agentConfigLoadableCheck.run(makeCtx(repo, "claude"));
  });
}

Deno.test("agentConfigLoadable: claude fails when PostToolUse runs the audit hook twice", async () => {
  const result = await claudeResult({
    PostToolUse: [claudeEntry(BACKGROUNDED_AUDIT), claudeEntry(CLAUDE_AUDIT)],
    PostToolUseFailure: [
      claudeEntry(BACKGROUNDED_AUDIT),
      claudeEntry(CLAUDE_AUDIT),
    ],
  });
  assertEquals(result.status, "fail");
  assertStringIncludes(result.message, "PostToolUse runs");
  assertEquals(result.details, { event: "PostToolUse", auditHooks: 2 });
});

Deno.test("agentConfigLoadable: claude fails when only PostToolUseFailure runs the audit hook twice", async () => {
  const result = await claudeResult({
    PostToolUse: [claudeEntry(CLAUDE_AUDIT)],
    PostToolUseFailure: [
      claudeEntry(CLAUDE_AUDIT),
      claudeEntry(BACKGROUNDED_AUDIT, "*"),
    ],
  });
  assertEquals(result.status, "fail");
  assertEquals(result.details, { event: "PostToolUseFailure", auditHooks: 2 });
});

Deno.test("agentConfigLoadable: claude counts an audit hook under a matcher list", async () => {
  const result = await claudeResult({
    PostToolUse: [
      claudeEntry(CLAUDE_AUDIT),
      claudeEntry(BACKGROUNDED_AUDIT, "Edit, Bash"),
    ],
    PostToolUseFailure: [claudeEntry(CLAUDE_AUDIT)],
  });
  assertEquals(result.status, "fail");
  assertEquals(result.details, { event: "PostToolUse", auditHooks: 2 });
});

Deno.test("agentConfigLoadable: claude passes for a single backgrounded audit hook", async () => {
  const result = await claudeResult({
    PostToolUse: [claudeEntry(BACKGROUNDED_AUDIT)],
    PostToolUseFailure: [claudeEntry(BACKGROUNDED_AUDIT)],
  });
  assertEquals(result.status, "pass");
});

Deno.test("agentConfigLoadable: claude still passes when the audit hook is under a non-Bash matcher", async () => {
  const result = await claudeResult({
    PostToolUse: [claudeEntry(CLAUDE_AUDIT, "Edit")],
    PostToolUseFailure: [claudeEntry(CLAUDE_AUDIT, "Edit")],
  });
  assertEquals(result.status, "pass");
});

Deno.test("agentConfigLoadable: claude passes with malformed entries beside one audit hook", async () => {
  const result = await claudeResult({
    PostToolUse: [
      "junk",
      null,
      { matcher: "Bash", hooks: "x" },
      claudeEntry(CLAUDE_AUDIT),
    ],
    PostToolUseFailure: [{ matcher: 7 }, claudeEntry(CLAUDE_AUDIT)],
  });
  assertEquals(result.status, "pass");
});

for (
  const { tool, file, entry } of [
    {
      tool: "cursor" as const,
      file: ".cursor/hooks.json",
      entry: { command: "swamp audit record --from-hook --tool cursor" },
    },
    {
      tool: "copilot" as const,
      file: ".github/hooks/swamp-audit.json",
      entry: {
        type: "command",
        command: "swamp audit record --from-hook --tool copilot",
      },
    },
  ]
) {
  const variant = { ...entry, timeout: 5 };
  const result = (hooks: unknown) =>
    withTempRepo(async (repo) => {
      await writeJson(join(repo, file), { version: 1, hooks });
      return await agentConfigLoadableCheck.run(makeCtx(repo, tool));
    });

  Deno.test(`agentConfigLoadable: ${tool} fails when postToolUse runs the audit hook twice`, async () => {
    const r = await result({
      postToolUse: [variant, entry],
      postToolUseFailure: [entry],
    });
    assertEquals(r.status, "fail");
    assertEquals(r.details, { event: "postToolUse", auditHooks: 2 });
  });

  Deno.test(`agentConfigLoadable: ${tool} fails when only postToolUseFailure runs the audit hook twice`, async () => {
    const r = await result({
      postToolUse: [entry],
      postToolUseFailure: [entry, variant],
    });
    assertEquals(r.status, "fail");
    assertEquals(r.details, { event: "postToolUseFailure", auditHooks: 2 });
  });

  Deno.test(`agentConfigLoadable: ${tool} passes for a single audit hook variant`, async () => {
    const r = await result({
      postToolUse: [variant],
      postToolUseFailure: [variant],
    });
    assertEquals(r.status, "pass");
  });

  Deno.test(`agentConfigLoadable: ${tool} passes with malformed entries beside one audit hook`, async () => {
    const r = await result({
      postToolUse: ["junk", null, { command: 3 }, entry],
      postToolUseFailure: [entry],
    });
    assertEquals(r.status, "pass");
  });
}

const SWAMP_CLAUDE_ENTRY = {
  matcher: "Bash|PowerShell",
  hooks: [{ type: "command", command: "swamp audit record --from-hook" }],
};
const SWAMP_CLAUDE_HOOKS = {
  PostToolUse: [SWAMP_CLAUDE_ENTRY],
  PostToolUseFailure: [SWAMP_CLAUDE_ENTRY],
};

async function withClaudeLayout<T>(
  fn: (dirs: { root: string; repo: string; home: string }) => Promise<T>,
): Promise<T> {
  return await withTempRepo(async (root) => {
    const repo = join(root, "swamp", "app");
    const home = join(root, "home");
    await ensureDir(repo);
    await ensureDir(home);
    return await fn({ root, repo, home });
  });
}

function claudeCtx(
  repo: string,
  home: string,
  gitRoot: string | null,
): CheckContext {
  return {
    ...makeCtx(repo, "claude"),
    homeDir: home,
    claudeConfigDir: join(home, ".claude"),
    findGitRoot: () => gitRoot,
  };
}

Deno.test("agentConfigLoadable: claude warns when the repo is below its git root", async () => {
  await withClaudeLayout(async ({ root, repo, home }) => {
    await writeJson(join(repo, ".claude/settings.local.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    const result = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(result.status, "pass");
    assertStringIncludes(result.warning ?? "", `below the git root ${root}`);
    assertStringIncludes(result.hint ?? "", "swamp audit install --user");
    assertEquals(result.details, { gitRoot: root });
  });
});

Deno.test("agentConfigLoadable: claude does not warn for a repo at its git root, outside git or under a home-dir git root", async () => {
  await withClaudeLayout(async ({ repo, home }) => {
    await writeJson(join(repo, ".claude/settings.local.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    for (const gitRoot of [repo, null, home]) {
      const result = await agentConfigLoadableCheck.run(
        claudeCtx(repo, home, gitRoot),
      );
      assertEquals(result.status, "pass");
      assertEquals(result.warning, undefined);
    }
  });
});

Deno.test("agentConfigLoadable: claude does not warn when the user settings run the hook", async () => {
  await withClaudeLayout(async ({ root, repo, home }) => {
    await writeJson(join(repo, ".claude/settings.local.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    await writeJson(join(home, ".claude/settings.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    const result = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(result.status, "pass");
    assertEquals(result.warning, undefined);
    assertStringIncludes(result.message, "which Claude Code runs once");
  });
});

Deno.test("agentConfigLoadable: claude passes on the user hook alone when the repo file has none", async () => {
  await withClaudeLayout(async ({ root, repo, home }) => {
    await writeJson(join(home, ".claude/settings.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    const missing = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(missing.status, "pass");
    assertStringIncludes(
      missing.message,
      "runs the audit hook for calls inside any swamp repo",
    );

    await writeJson(join(repo, ".claude/settings.local.json"), {
      permissions: { allow: [] },
    });
    const noHooks = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(noHooks.status, "pass");
  });
});

Deno.test("agentConfigLoadable: claude still fails a corrupt repo file or a duplicate hook with a user hook", async () => {
  await withClaudeLayout(async ({ root, repo, home }) => {
    await writeJson(join(home, ".claude/settings.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    const path = join(repo, ".claude/settings.local.json");
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(path, "{ not json");
    const corrupt = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(corrupt.status, "fail");

    await writeJson(path, {
      hooks: {
        PostToolUse: [SWAMP_CLAUDE_ENTRY, SWAMP_CLAUDE_ENTRY],
        PostToolUseFailure: [SWAMP_CLAUDE_ENTRY],
      },
    });
    const duplicate = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(duplicate.status, "fail");
  });
});

Deno.test("agentConfigLoadable: claude without a user or repo hook still fails", async () => {
  await withClaudeLayout(async ({ root, repo, home }) => {
    const result = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "is missing");
  });
});

Deno.test("agentConfigLoadable: claude does not warn when the git root's settings run the audit hook", async () => {
  await withClaudeLayout(async ({ root, repo, home }) => {
    await writeJson(join(repo, ".claude/settings.local.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    await writeJson(join(root, ".claude/settings.local.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    const result = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(result.status, "pass");
    assertEquals(result.warning, undefined);
  });
});

Deno.test("agentConfigLoadable: claude warns when repo and user settings run different audit hooks", async () => {
  await withClaudeLayout(async ({ root, repo, home }) => {
    const wrapped = {
      matcher: "Bash",
      hooks: [{
        type: "command",
        command: "timeout 5 swamp audit record --from-hook",
      }],
    };
    await writeJson(join(repo, ".claude/settings.local.json"), {
      hooks: { PostToolUse: [wrapped], PostToolUseFailure: [wrapped] },
    });
    await writeJson(join(home, ".claude/settings.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    const result = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(result.status, "pass");
    assertStringIncludes(result.warning ?? "", "records each call twice");
    assertEquals(result.details?.event, "PostToolUse");
  });
});

Deno.test("agentConfigLoadable: claude does not warn for swamp's old Bash-only repo hook beside the user hook", async () => {
  await withClaudeLayout(async ({ root, repo, home }) => {
    const legacy = { ...SWAMP_CLAUDE_ENTRY, matcher: "Bash" };
    await writeJson(join(repo, ".claude/settings.local.json"), {
      hooks: { PostToolUse: [legacy], PostToolUseFailure: [legacy] },
    });
    await writeJson(join(home, ".claude/settings.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    const result = await agentConfigLoadableCheck.run(
      claudeCtx(repo, home, root),
    );
    assertEquals(result.warning, undefined);
  });
});

Deno.test("agentConfigLoadable: claude reads user hooks from the Claude config dir it is given", async () => {
  await withClaudeLayout(async ({ root, repo, home }) => {
    await writeJson(join(repo, ".claude/settings.local.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    await writeJson(join(home, ".claude/settings.json"), {
      hooks: SWAMP_CLAUDE_HOOKS,
    });
    const elsewhere = await agentConfigLoadableCheck.run({
      ...claudeCtx(repo, home, root),
      claudeConfigDir: join(home, "cfg"),
    });
    assertStringIncludes(elsewhere.warning ?? "", "below the git root");
  });
});
