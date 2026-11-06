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
import { ensureDir } from "@std/fs";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import { ToolSettingsPruner } from "./tool_settings_pruner.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_prune_test_" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function writeJson(root: string, path: string, value: unknown) {
  const abs = join(root, ...path.split("/"));
  await ensureDir(join(abs, ".."));
  await Deno.writeTextFile(abs, JSON.stringify(value, null, 2) + "\n");
}

async function readJson(root: string, path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(join(root, ...path.split("/"))));
}

async function exists(root: string, path: string): Promise<boolean> {
  try {
    await Deno.lstat(join(root, ...path.split("/")));
    return true;
  } catch {
    return false;
  }
}

const claudeHook = (command: string, matcher = "Bash") => ({
  matcher,
  hooks: [{ type: "command", command }],
});

const swampClaudeSettings = {
  permissions: { allow: ["Bash(swamp *)"] },
  hooks: {
    PostToolUse: [claudeHook("swamp audit record --from-hook")],
    PostToolUseFailure: [claudeHook("swamp audit record --from-hook")],
  },
};

Deno.test({
  name:
    "ToolSettingsPruner.find: removes swamp's claude hooks and keeps permissions",
  fn: () =>
    withTempDir(async (dir) => {
      await writeJson(dir, ".claude/settings.local.json", swampClaudeSettings);
      const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
      const plan = await pruner.find(["codex"]);
      assertEquals(plan.actions.length, 1);
      assertEquals(plan.actions[0].kind, "edit");
      assertEquals(plan.actions[0].path, ".claude/settings.local.json");
      assertEquals(plan.actions[0].removed.length, 2);

      await pruner.apply(plan);
      assertEquals(await readJson(dir, ".claude/settings.local.json"), {
        permissions: { allow: ["Bash(swamp *)"] },
      });
    }),
});

Deno.test("ToolSettingsPruner.find: keeps user claude hooks, wrapped commands and other matchers' siblings", () =>
  withTempDir(async (dir) => {
    await writeJson(dir, ".claude/settings.local.json", {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "swamp audit record --from-hook" },
              { type: "command", command: "./my-linter.sh" },
            ],
          },
          claudeHook("swamp audit record --from-hook && notify-send done"),
          claudeHook("/usr/local/bin/swamp audit record --from-hook", "Edit"),
        ],
        PreToolUse: [claudeHook("./guard.sh")],
      },
    });
    const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
    await pruner.apply(await pruner.find([]));
    assertEquals(await readJson(dir, ".claude/settings.local.json"), {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "./my-linter.sh" }],
          },
          claudeHook("swamp audit record --from-hook && notify-send done"),
        ],
        PreToolUse: [claudeHook("./guard.sh")],
      },
    });
  }));

Deno.test("ToolSettingsPruner.find: deletes a claude settings file left with nothing", () =>
  withTempDir(async (dir) => {
    await writeJson(dir, ".claude/settings.local.json", {
      hooks: swampClaudeSettings.hooks,
    });
    const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
    const plan = await pruner.find([]);
    assertEquals(plan.actions[0].kind, "delete");
    await pruner.apply(plan);
    assertEquals(await exists(dir, ".claude/settings.local.json"), false);
  }));

Deno.test("ToolSettingsPruner.find: never touches an enrolled tool's settings", () =>
  withTempDir(async (dir) => {
    await writeJson(dir, ".claude/settings.local.json", swampClaudeSettings);
    await writeJson(dir, ".cursor/hooks.json", {
      version: 1,
      hooks: {
        postToolUse: [{
          command: "swamp audit record --from-hook --tool cursor",
        }],
      },
    });
    const plan = await new ToolSettingsPruner(dir, atomicWriteTextFile).find([
      "claude",
      "cursor",
    ]);
    assertEquals(plan, { actions: [], skipped: [] });
  }));

Deno.test("ToolSettingsPruner.find: removes cursor and copilot entries, deleting files left with only a version", () =>
  withTempDir(async (dir) => {
    await writeJson(dir, ".cursor/hooks.json", {
      version: 1,
      hooks: {
        postToolUse: [
          { command: "swamp audit record --from-hook --tool cursor" },
          { command: "./mine.sh" },
        ],
        postToolUseFailure: [
          { command: "swamp audit record --from-hook --tool cursor" },
        ],
      },
    });
    await writeJson(dir, ".github/hooks/swamp-audit.json", {
      version: 1,
      hooks: {
        postToolUse: [{
          type: "command",
          command: "swamp audit record --from-hook --tool copilot",
        }],
      },
    });
    const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
    await pruner.apply(await pruner.find([]));
    assertEquals(await readJson(dir, ".cursor/hooks.json"), {
      version: 1,
      hooks: { postToolUse: [{ command: "./mine.sh" }] },
    });
    assertEquals(await exists(dir, ".github/hooks/swamp-audit.json"), false);
  }));

Deno.test("ToolSettingsPruner.find: removes the antigravity swamp-audit block only", () =>
  withTempDir(async (dir) => {
    await writeJson(dir, ".agents/hooks.json", {
      "swamp-audit": { enabled: true },
      "my-hook": { enabled: true },
    });
    const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
    await pruner.apply(await pruner.find([]));
    assertEquals(await readJson(dir, ".agents/hooks.json"), {
      "my-hook": { enabled: true },
    });
  }));

Deno.test("ToolSettingsPruner.find: removes kiro hooks, agent and default agent, keeping user files", () =>
  withTempDir(async (dir) => {
    const kiroHook = {
      name: "swamp-audit",
      trigger: "PostToolUse",
      action: {
        type: "command",
        command: "swamp audit record --from-hook --tool kiro",
      },
    };
    const userHook = {
      name: "lint",
      trigger: "PostToolUse",
      action: { type: "command", command: "./lint.sh" },
    };
    await writeJson(dir, ".kiro/hooks/swamp-audit.json", {
      version: "v1",
      hooks: [kiroHook],
    });
    await writeJson(dir, ".kiro/hooks/mine.json", {
      version: "v1",
      hooks: [userHook, kiroHook],
    });
    await writeJson(dir, ".kiro/hooks/described.json", {
      version: "v1",
      description: "kept",
      hooks: [kiroHook],
    });
    await Deno.writeTextFile(join(dir, ".kiro/hooks/broken.json"), "{");
    await writeJson(dir, ".kiro/agents/swamp.json", { name: "swamp" });
    await writeJson(dir, ".kiro/agents/other.json", { name: "other" });
    await writeJson(dir, ".kiro/settings/cli.json", {
      "chat.defaultAgent": "swamp",
      "chat.theme": "dark",
    });
    const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
    const plan = await pruner.find([]);
    assertEquals(plan.skipped, []);
    await pruner.apply(plan);
    assertEquals(await exists(dir, ".kiro/hooks/swamp-audit.json"), false);
    assertEquals(await readJson(dir, ".kiro/hooks/mine.json"), {
      version: "v1",
      hooks: [userHook],
    });
    assertEquals(await readJson(dir, ".kiro/hooks/described.json"), {
      version: "v1",
      description: "kept",
      hooks: [],
    });
    assertEquals(await exists(dir, ".kiro/hooks/broken.json"), true);
    assertEquals(await exists(dir, ".kiro/agents/swamp.json"), false);
    assertEquals(await exists(dir, ".kiro/agents/other.json"), true);
    assertEquals(await readJson(dir, ".kiro/settings/cli.json"), {
      "chat.theme": "dark",
    });
  }));

Deno.test("ToolSettingsPruner.find: leaves a non-swamp kiro default agent", () =>
  withTempDir(async (dir) => {
    await writeJson(dir, ".kiro/settings/cli.json", {
      "chat.defaultAgent": "mine",
    });
    const plan = await new ToolSettingsPruner(dir, atomicWriteTextFile).find(
      [],
    );
    assertEquals(plan.actions, []);
  }));

Deno.test("ToolSettingsPruner.find: deletes managed plugin files and keeps edited ones", () =>
  withTempDir(async (dir) => {
    const managed = "// Swamp audit plugin for OpenCode\n" +
      "// This is a managed file — it will be overwritten on swamp upgrade.\n" +
      "export default {};\n";
    await ensureDir(join(dir, ".opencode/plugins"));
    await Deno.writeTextFile(
      join(dir, ".opencode/plugins/swamp-audit.ts"),
      managed,
    );
    await ensureDir(join(dir, ".pi/extensions"));
    await Deno.writeTextFile(
      join(dir, ".pi/extensions/swamp-audit.ts"),
      "// my own pi extension\nexport default {};\n",
    );
    const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
    const plan = await pruner.find([]);
    assertEquals(plan.skipped.map((s) => s.path), [
      ".pi/extensions/swamp-audit.ts",
    ]);
    await pruner.apply(plan);
    assertEquals(await exists(dir, ".opencode/plugins/swamp-audit.ts"), false);
    assertEquals(await exists(dir, ".pi/extensions/swamp-audit.ts"), true);
  }));

Deno.test("ToolSettingsPruner.find: reports a settings file that is not a JSON object", () =>
  withTempDir(async (dir) => {
    await ensureDir(join(dir, ".claude"));
    await Deno.writeTextFile(join(dir, ".claude/settings.local.json"), "[1]");
    const plan = await new ToolSettingsPruner(dir, atomicWriteTextFile).find(
      [],
    );
    assertEquals(plan.actions, []);
    assertEquals(plan.skipped.length, 1);
    assertStringIncludes(plan.skipped[0].reason, "JSON object");
  }));

Deno.test({
  name: "ToolSettingsPruner.find: skips a symlinked settings file",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withTempDir(async (dir) => {
      const outside = await Deno.makeTempDir({ prefix: "swamp_prune_out_" });
      try {
        await writeJson(outside, "settings.json", swampClaudeSettings);
        await ensureDir(join(dir, ".claude"));
        await Deno.symlink(
          join(outside, "settings.json"),
          join(dir, ".claude/settings.local.json"),
          { type: "file" },
        );
        const plan = await new ToolSettingsPruner(dir, atomicWriteTextFile)
          .find([]);
        assertEquals(plan.actions, []);
        assertStringIncludes(plan.skipped[0].reason, "symbolic link");
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    }),
});

Deno.test({
  name:
    "ToolSettingsPruner.find: skips files in a tool directory that resolves outside the repo",
  ignore: Deno.build.os === "windows",
  fn: () =>
    withTempDir(async (dir) => {
      const outside = await Deno.makeTempDir({ prefix: "swamp_prune_out_" });
      try {
        await writeJson(outside, "agents/swamp.json", { name: "swamp" });
        await writeJson(outside, "hooks/swamp-audit.json", {
          version: "v1",
          hooks: [{
            trigger: "PostToolUse",
            action: { command: "swamp audit record --from-hook --tool kiro" },
          }],
        });
        await writeJson(outside, "settings/cli.json", {
          "chat.defaultAgent": "swamp",
        });
        await Deno.symlink(outside, join(dir, ".kiro"), { type: "dir" });
        const plan = await new ToolSettingsPruner(dir, atomicWriteTextFile)
          .find([]);
        assertEquals(plan.actions, []);
        assertEquals(
          plan.skipped.map((s) => [s.path, s.reason]),
          [
            [".kiro/hooks", "it resolves outside the repository"],
            [".kiro/agents/swamp.json", "it resolves outside the repository"],
            [".kiro/settings/cli.json", "it resolves outside the repository"],
          ],
        );
        assertEquals(await exists(outside, "agents/swamp.json"), true);
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    }),
});

Deno.test("ToolSettingsPruner.apply: skips a file that changed after it was found", () =>
  withTempDir(async (dir) => {
    await writeJson(dir, ".claude/settings.local.json", swampClaudeSettings);
    const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
    const plan = await pruner.find([]);
    await writeJson(dir, ".claude/settings.local.json", {
      ...swampClaudeSettings,
      model: "opus",
    });
    const outcome = await pruner.apply(plan);
    assertEquals(outcome.applied, []);
    assertEquals(outcome.skipped[0].reason, "it changed after it was found");
  }));

Deno.test("ToolSettingsPruner.find: a second run after apply finds nothing", () =>
  withTempDir(async (dir) => {
    await writeJson(dir, ".claude/settings.local.json", swampClaudeSettings);
    await writeJson(dir, ".kiro/agents/swamp.json", { name: "swamp" });
    const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
    await pruner.apply(await pruner.find([]));
    assertEquals(await pruner.find([]), { actions: [], skipped: [] });
  }));

Deno.test("ToolSettingsPruner.apply: a file that cannot be written is skipped and the rest are still applied", () =>
  withTempDir(async (dir) => {
    await writeJson(dir, ".claude/settings.local.json", swampClaudeSettings);
    await writeJson(dir, ".kiro/agents/swamp.json", { name: "swamp" });
    const pruner = new ToolSettingsPruner(
      dir,
      () => Promise.reject(new Error("read-only file system")),
    );
    const outcome = await pruner.apply(await pruner.find([]));
    assertEquals(outcome.applied.map((a) => a.path), [
      ".kiro/agents/swamp.json",
    ]);
    assertEquals(outcome.skipped, [{
      tool: "claude",
      path: ".claude/settings.local.json",
      reason: "it could not be changed: read-only file system",
    }]);
  }));
