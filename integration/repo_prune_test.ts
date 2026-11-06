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
import { join, relative, SEPARATOR } from "@std/path";
import { walk } from "@std/fs";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { atomicWriteTextFile } from "../src/infrastructure/persistence/atomic_write.ts";
import { ToolSettingsPruner } from "../src/domain/repo/tool_settings_pruner.ts";
import { BUILT_IN_TOOL_NAMES } from "../src/domain/repo/custom_tool.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { createRepoPruneDeps } from "../src/libswamp/repo/prune.ts";
import { createRepoUpgradeDeps } from "../src/libswamp/repo/init.ts";

const TOOLS = BUILT_IN_TOOL_NAMES.filter((t) => t !== "none");
const MANAGED_MARKER = "This is a managed file";

async function withRepo(
  fn: (dir: string, service: RepoService) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-repo-prune-" });
  try {
    const homeDir = join(dir, ".test-home");
    await fn(
      dir,
      new RepoService("0.1.0", {
        homeDir,
        configDir: join(homeDir, ".config", "swamp"),
      }),
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

// skills/ and the test home quote the hook command in documentation, not settings
async function swampWiring(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (
    const entry of walk(dir, {
      includeDirs: false,
      exts: [".json", ".ts", ".hook"],
      skip: [/[\\/]\.swamp[\\/]/, /[\\/]\.test-home[\\/]/, /[\\/]skills[\\/]/],
    })
  ) {
    const text = await Deno.readTextFile(entry.path);
    const rel = relative(dir, entry.path).split(SEPARATOR).join("/");
    if (
      text.includes("audit record --from-hook") ||
      text.includes(MANAGED_MARKER) ||
      text.includes('"chat.defaultAgent": "swamp"') ||
      rel === ".kiro/agents/swamp.json"
    ) {
      found.push(rel);
    }
  }
  return found.sort();
}

for (const tool of TOOLS) {
  Deno.test(`repo prune: removes every swamp setting for a dropped ${tool}`, () =>
    withRepo(async (dir, service) => {
      const repoPath = RepoPath.create(dir);
      await service.init(repoPath, { tools: [tool] });
      const before = await swampWiring(dir);
      // codex is the one built-in tool swamp writes no settings for
      assertEquals(before.length === 0, tool === "codex", before.join(", "));
      await service.upgrade(repoPath, { tools: [] });
      assertEquals(
        await swampWiring(dir),
        before,
        "upgrade must not delete a dropped tool's settings",
      );

      const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
      const plan = await pruner.find([]);
      assertEquals(plan.skipped, []);
      await pruner.apply(plan);

      assertEquals(await swampWiring(dir), []);
      assertEquals((await pruner.find([])).actions, []);
    }));
}

Deno.test("repo prune: keeps a user hook beside swamp's in a dropped claude's settings", () =>
  withRepo(async (dir, service) => {
    const repoPath = RepoPath.create(dir);
    await service.init(repoPath, { tools: ["claude"] });
    const path = join(dir, ".claude", "settings.local.json");
    const settings = JSON.parse(await Deno.readTextFile(path));
    settings.hooks.PostToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: "./lint.sh" }],
    });
    await Deno.writeTextFile(path, JSON.stringify(settings, null, 2));
    await service.upgrade(repoPath, { tools: ["codex"] });

    const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
    await pruner.apply(await pruner.find(["codex"]));

    const after = JSON.parse(await Deno.readTextFile(path));
    assertEquals(after.permissions, settings.permissions);
    assertEquals(after.hooks, {
      PostToolUse: [{
        matcher: "Bash",
        hooks: [{ type: "command", command: "./lint.sh" }],
      }],
    });
  }));

Deno.test("repo prune: finds nothing to remove while every tool is enrolled", () =>
  withRepo(async (dir, service) => {
    await service.init(RepoPath.create(dir), { tools: [...TOOLS] });
    const plan = await new ToolSettingsPruner(dir, atomicWriteTextFile).find([
      ...TOOLS,
    ]);
    assertEquals(plan, { actions: [], skipped: [] });
  }));

Deno.test("repo prune: a marker without tools keeps its claude hooks through a plain upgrade", () =>
  withRepo(async (dir, service) => {
    const repoPath = RepoPath.create(dir);
    await service.init(repoPath, { tools: ["claude"] });
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    delete marker!.tools;
    await markerRepo.write(repoPath, marker!);
    const hooksBefore = await swampWiring(dir);

    await service.upgrade(repoPath, {});

    assertEquals((await markerRepo.read(repoPath))!.tools, undefined);
    assertEquals(
      await createRepoUpgradeDeps("0.1.0").findPrunableSettings!(dir),
      [],
    );
    const pruneDeps = createRepoPruneDeps();
    const enrolled = await pruneDeps.readEnrolledTools(repoPath);
    assertEquals(enrolled, ["claude"]);
    assertEquals((await pruneDeps.find(dir, enrolled!)).actions, []);
    assertEquals(await swampWiring(dir), hooksBefore);
  }));

Deno.test("repo prune: an upgrade that passes --tool still writes the tool list to a marker without one", () =>
  withRepo(async (dir, service) => {
    const repoPath = RepoPath.create(dir);
    await service.init(repoPath, { tools: ["claude"] });
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    delete marker!.tools;
    await markerRepo.write(repoPath, marker!);

    await service.upgrade(repoPath, { tools: ["codex"] });

    assertEquals((await markerRepo.read(repoPath))!.tools, ["codex"]);
  }));
