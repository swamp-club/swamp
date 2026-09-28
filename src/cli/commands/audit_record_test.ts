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
import { dirname, join, resolve } from "@std/path";
import { recordHookEntry, resolveAuditRepoDir } from "./audit.ts";
import { createBashCommandEntry } from "../../domain/audit/audit_command_entry.ts";
import { auditFilePathForTimestamp } from "../../domain/audit/audit_path.ts";
import {
  SWAMP_MARKER_FILE,
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-audit-record-" });
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

/**
 * Ancestor lookup bounded to `root`, standing in for `findAncestorRepoDir`
 * so tests never shell out to git or escape the temp directory.
 */
function findRepoWithin(root: string): (startDir: string) => string | null {
  return (startDir) => {
    let dir = resolve(startDir);
    while (true) {
      try {
        if (Deno.statSync(join(dir, SWAMP_MARKER_FILE)).isFile) return dir;
      } catch {
        // No marker at this level — continue up
      }
      if (dir === resolve(root)) return null;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };
}

async function makeRepo(dir: string): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, SWAMP_MARKER_FILE), "swampVersion: 1");
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("resolveAuditRepoDir: resolves a hook cwd in a subdirectory to the repo root", async () => {
  await withTempDir(async (root) => {
    const repo = await makeRepo(join(root, "repo"));
    const sub = join(repo, "src", "nested");
    await Deno.mkdir(sub, { recursive: true });

    const result = resolveAuditRepoDir({
      hookCwd: sub,
      processCwd: root,
      findRepo: findRepoWithin(root),
    });

    assertPathEquals(result!, repo);
  });
});

Deno.test("resolveAuditRepoDir: falls back to SWAMP_REPO_DIR when the hook cwd is not in a repo", async () => {
  await withTempDir(async (root) => {
    const repo = await makeRepo(join(root, "repo"));
    const worktree = join(root, "worktree");
    await Deno.mkdir(worktree);

    const result = resolveAuditRepoDir({
      hookCwd: worktree,
      envRepoDir: repo,
      processCwd: worktree,
      findRepo: findRepoWithin(root),
    });

    assertPathEquals(result!, repo);
  });
});

Deno.test("resolveAuditRepoDir: returns null when no initialized repo is found", async () => {
  await withTempDir(async (root) => {
    const worktree = join(root, "worktree");
    await Deno.mkdir(worktree);

    const result = resolveAuditRepoDir({
      hookCwd: worktree,
      processCwd: worktree,
      findRepo: findRepoWithin(root),
    });

    assertEquals(result, null);
  });
});

Deno.test("resolveAuditRepoDir: ignores SWAMP_REPO_DIR without a marker", async () => {
  await withTempDir(async (root) => {
    const notRepo = join(root, "not-repo");
    await Deno.mkdir(notRepo);

    const result = resolveAuditRepoDir({
      envRepoDir: notRepo,
      processCwd: notRepo,
      findRepo: findRepoWithin(root),
    });

    assertEquals(result, null);
  });
});

Deno.test("resolveAuditRepoDir: returns null for an explicit repo dir without a marker", async () => {
  await withTempDir(async (root) => {
    const repo = await makeRepo(join(root, "repo"));
    const notRepo = join(root, "not-repo");
    await Deno.mkdir(notRepo);

    const result = resolveAuditRepoDir({
      explicitRepoDir: notRepo,
      hookCwd: repo,
      processCwd: root,
      findRepo: findRepoWithin(root),
    });

    assertEquals(result, null);
  });
});

Deno.test("resolveAuditRepoDir: an explicit repo dir with a marker wins over the hook cwd", async () => {
  await withTempDir(async (root) => {
    const explicit = await makeRepo(join(root, "explicit"));
    const other = await makeRepo(join(root, "other"));

    const result = resolveAuditRepoDir({
      explicitRepoDir: explicit,
      hookCwd: other,
      processCwd: root,
      findRepo: findRepoWithin(root),
    });

    assertPathEquals(result!, explicit);
  });
});

Deno.test("resolveAuditRepoDir: a relative hook cwd falls through to the process cwd", async () => {
  await withTempDir(async (root) => {
    const repo = await makeRepo(join(root, "repo"));
    const sub = join(repo, "sub");
    await Deno.mkdir(sub);

    const result = resolveAuditRepoDir({
      hookCwd: ".",
      processCwd: sub,
      findRepo: findRepoWithin(root),
    });

    assertPathEquals(result!, repo);
  });
});

Deno.test("recordHookEntry: writes nothing outside an initialized repo", async () => {
  await withTempDir(async (root) => {
    const worktree = join(root, "worktree");
    await Deno.mkdir(worktree);
    const entry = createBashCommandEntry("session-1", "ls", worktree);

    const recorded = await recordHookEntry(entry, {
      hookCwd: worktree,
      processCwd: worktree,
      findRepo: findRepoWithin(root),
    }, { cleanup: false });

    assertEquals(recorded, false);
    assertEquals(await exists(join(worktree, ".swamp")), false);
  });
});

Deno.test("recordHookEntry: records a subdirectory command in the repo root's audit log", async () => {
  await withTempDir(async (root) => {
    const repo = await makeRepo(join(root, "repo"));
    const sub = join(repo, "src");
    await Deno.mkdir(sub);
    const entry = createBashCommandEntry("session-1", "ls", sub);

    const recorded = await recordHookEntry(entry, {
      hookCwd: sub,
      processCwd: root,
      findRepo: findRepoWithin(root),
    }, { cleanup: false });

    assertEquals(recorded, true);
    const logPath = auditFilePathForTimestamp(
      swampPath(repo, SWAMP_SUBDIRS.audit),
      entry.timestamp,
    );
    const lines = (await Deno.readTextFile(logPath)).trim().split("\n");
    assertEquals(lines.length, 1);
    assertEquals(JSON.parse(lines[0]).command, "ls");
    assertEquals(await exists(join(sub, ".swamp")), false);
  });
});

Deno.test("resolveAuditRepoDir: uses a hook cwd holding a marker without walking up", async () => {
  await withTempDir(async (root) => {
    const repo = await makeRepo(join(root, "repo"));
    let walked = false;

    const result = resolveAuditRepoDir({
      hookCwd: repo,
      processCwd: root,
      findRepo: () => {
        walked = true;
        return null;
      },
    });

    assertPathEquals(result!, repo);
    assertEquals(walked, false);
  });
});
