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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { join } from "@std/path";
import { RepoService } from "./repo_service.ts";
import { RepoPath } from "./repo_path.ts";

const USER_AGENTS_MD = "# Repo rules\n\nUse tabs.\n";
const USER_CLAUDE_MD = "# My Claude rules\n";
const LEGACY_AGENTS_MD =
  "# Project\n\nThis repository is managed with [swamp](https://github.com/swamp-club/swamp).\n";
const SWAMP_SIGNATURE = "This repository is managed with [swamp]";

const arbShape = fc.record({
  agentsMd: fc.constantFrom("none", "user", "legacy"),
  claudeMd: fc.constantFrom("none", "user", "symlink"),
  tools: fc.shuffledSubarray(["claude", "codex", "cursor"], { minLength: 1 })
    .filter((tools) => tools.includes("claude")),
  addAgentsMdAfterInit: fc.boolean(),
});

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function service(version: string, dir: string): RepoService {
  const homeDir = join(dir, "test-home");
  return new RepoService(version, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  });
}

Deno.test("RepoService property: claude instructions land in one target and a second upgrade changes nothing", async () => {
  await fc.assert(
    fc.asyncProperty(arbShape, async (shape) => {
      // Creating symlinks on Windows needs a privilege CI runners lack.
      if (shape.claudeMd === "symlink" && Deno.build.os === "windows") return;
      const dir = await Deno.makeTempDir({ prefix: "swamp_repo_prop_" });
      try {
        const agentsPath = join(dir, "AGENTS.md");
        const claudePath = join(dir, "CLAUDE.md");
        if (shape.agentsMd === "user") {
          await Deno.writeTextFile(agentsPath, USER_AGENTS_MD);
        } else if (shape.agentsMd === "legacy") {
          await Deno.writeTextFile(agentsPath, LEGACY_AGENTS_MD);
        }
        if (shape.claudeMd === "user") {
          await Deno.writeTextFile(claudePath, USER_CLAUDE_MD);
        } else if (shape.claudeMd === "symlink") {
          await Deno.symlink("AGENTS.md", claudePath, { type: "file" });
        }
        const repoPath = RepoPath.create(dir);

        await service("0.1.0", dir).init(repoPath, { tools: shape.tools });
        const addedAgentsMd = shape.addAgentsMdAfterInit &&
          shape.agentsMd === "none";
        if (addedAgentsMd) {
          await Deno.writeTextFile(agentsPath, USER_AGENTS_MD);
        }
        await service("0.2.0", dir).upgrade(repoPath);

        const snapshot = async () => ({
          agents: await readIfExists(agentsPath),
          claude: await readIfExists(claudePath),
          rules: await readIfExists(join(dir, ".claude", "rules", "swamp.md")),
        });
        const before = await snapshot();
        const again = await service("0.2.0", dir).upgrade(repoPath);
        assertEquals(await snapshot(), before);
        assertEquals(again.instructionsUpdated, false);

        // Swamp's Claude rules live in exactly one Claude-owned target.
        const claudeIsLink = shape.claudeMd === "symlink";
        const inClaudeMd = !claudeIsLink &&
          (before.claude?.includes(SWAMP_SIGNATURE) ?? false);
        const inRules = before.rules?.includes(SWAMP_SIGNATURE) ?? false;
        assert(inClaudeMd !== inRules, JSON.stringify({ shape, before }));

        // A repo's own AGENTS.md text is never removed, and a symlinked
        // CLAUDE.md stays a symlink.
        if (shape.agentsMd === "user" || addedAgentsMd) {
          assert(before.agents?.includes(USER_AGENTS_MD));
        }
        if (claudeIsLink) {
          assert((await Deno.lstat(claudePath)).isSymlink);
        }

        // Claude Code sees the repo's own AGENTS.md wherever swamp decides:
        // natively when there is no CLAUDE.md, through the symlink, or
        // through the import. A user's own CLAUDE.md is the exception.
        const agentsHasUserText = before.agents?.includes(USER_AGENTS_MD) ??
          false;
        if (agentsHasUserText && shape.claudeMd !== "user") {
          assert(
            before.claude === null || claudeIsLink ||
              before.claude.includes("\n@AGENTS.md\n"),
            JSON.stringify({ shape, before }),
          );
        }
      } finally {
        if (Deno.build.os === "windows") {
          // Best-effort: EBUSY can fire when V8 hasn't GC'd native
          // handles yet. Temp dir is ephemeral, OS reclaims.
          await Deno.remove(dir, { recursive: true }).catch(() => {});
        } else {
          await Deno.remove(dir, { recursive: true });
        }
      }
    }),
    { numRuns: 40 },
  );
});
