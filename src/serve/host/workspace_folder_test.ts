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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  REPO_MARKER_FILE,
  scanWorkspaces,
  watchWorkspaces,
  type WorkspaceChange,
} from "./workspace_folder.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

async function makeRepo(dir: string, name: string): Promise<void> {
  await Deno.mkdir(join(dir, name), { recursive: true });
  await Deno.writeTextFile(join(dir, name, REPO_MARKER_FILE), "");
}

Deno.test("scanWorkspaces: lists repo folders with valid names and says why it skips the rest", async () => {
  await withTempDir(async (dir) => {
    await makeRepo(dir, "edge-dns");
    await makeRepo(dir, "cost-reports");
    await makeRepo(dir, "Bad_Name");
    await Deno.mkdir(join(dir, "not-a-repo"));
    await Deno.writeTextFile(join(dir, "a-file"), "");
    await makeRepo(dir, ".hidden");

    const scan = await scanWorkspaces(dir);
    assertEquals(scan.workspaces, ["cost-reports", "edge-dns"]);
    const reasons = new Map(scan.skipped.map((s) => [s.name, s.reason]));
    assertEquals([...reasons.keys()].sort(), [
      "Bad_Name",
      "a-file",
      "not-a-repo",
    ]);
    assertEquals(reasons.get("a-file"), "it is not a folder");
    assertEquals(reasons.get("not-a-repo")?.includes(REPO_MARKER_FILE), true);
    assertEquals(
      reasons.get("Bad_Name")?.includes("Invalid workspace name"),
      true,
    );
  });
});

Deno.test("scanWorkspaces: a missing folder holds no workspaces", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await scanWorkspaces(join(dir, "missing")), {
      workspaces: [],
      skipped: [],
    });
  });
});

Deno.test("watchWorkspaces: reports a folder added, one whose marker lands late, and one removed", async () => {
  await withTempDir(async (dir) => {
    await makeRepo(dir, "edge-dns");
    const changes: WorkspaceChange[] = [];
    const watcher = watchWorkspaces({
      dir,
      initial: ["edge-dns"],
      onChange: (change) => {
        changes.push(change);
      },
      rescanMs: 20,
      debounceMs: 5,
    });
    try {
      await makeRepo(dir, "cost-reports");
      await waitFor(
        () => changes.some((c) => c.added.includes("cost-reports")),
        "the added folder to be reported",
      );

      await Deno.mkdir(join(dir, "late"));
      await Deno.writeTextFile(join(dir, "late", REPO_MARKER_FILE), "");
      await waitFor(
        () => changes.some((c) => c.added.includes("late")),
        "the folder whose marker landed late to be reported",
      );

      await Deno.remove(join(dir, "edge-dns"), { recursive: true });
      await waitFor(
        () => changes.some((c) => c.removed.includes("edge-dns")),
        "the removed folder to be reported",
      );
      const added = changes.flatMap((c) => c.added);
      assertEquals(added.filter((n) => n === "cost-reports").length, 1);
    } finally {
      await watcher.stop();
    }
  });
});

Deno.test("watchWorkspaces: stop waits for a rescan in flight and reports nothing after", async () => {
  await withTempDir(async (dir) => {
    let entered = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => release = resolve);
    const changes: WorkspaceChange[] = [];
    const watcher = watchWorkspaces({
      dir,
      initial: [],
      onChange: async (change) => {
        entered = true;
        changes.push(change);
        await held;
      },
      rescanMs: 10,
      debounceMs: 5,
    });
    await makeRepo(dir, "edge-dns");
    await waitFor(() => entered, "a change to be reported");
    let stopped = false;
    const stopping = watcher.stop().then(() => stopped = true);
    await Promise.resolve();
    assertEquals(stopped, false, "stop waits for the rescan in flight");
    release();
    await stopping;
    await makeRepo(dir, "cost-reports");
    assertEquals(changes.length, 1);
  });
});

Deno.test("watchWorkspaces: a change handler that throws is logged and the watch goes on", async () => {
  await withTempDir(async (dir) => {
    const seen: string[] = [];
    const watcher = watchWorkspaces({
      dir,
      initial: [],
      onChange: (change) => {
        seen.push(...change.added);
        throw new Error("handler failed");
      },
      rescanMs: 10,
      debounceMs: 5,
    });
    try {
      await makeRepo(dir, "first");
      await waitFor(() => seen.includes("first"), "the first change");
      await makeRepo(dir, "second");
      await waitFor(() => seen.includes("second"), "the second change");
    } finally {
      await watcher.stop();
    }
  });
});
