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
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { REPO_MARKER_FILE } from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import { watchWorkspaces, type WorkspaceChange } from "./workspace_folder.ts";

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

Deno.test("watchWorkspaces: onRescan sees every rescan, even with nothing changed", async () => {
  await withTempDir(async (dir) => {
    let rescans = 0;
    const watcher = watchWorkspaces({
      dir,
      initial: [],
      rescanMs: 20,
      onChange: () => {},
      onRescan: () => {
        rescans++;
      },
    });
    try {
      await waitFor(() => rescans >= 2, "two rescans");
    } finally {
      await watcher.stop();
    }
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

Deno.test("watchWorkspaces: with a served filter, changes follow what is served, not the folders listed", async () => {
  await withTempDir(async (dir) => {
    await makeRepo(dir, "edge-dns");
    await makeRepo(dir, "being-deleted");
    const hidden = new Set(["being-deleted"]);
    const changes: WorkspaceChange[] = [];
    const watcher = watchWorkspaces({
      dir,
      initial: ["edge-dns"],
      onChange: (change) => {
        changes.push(change);
      },
      served: (scan) => scan.workspaces.filter((name) => !hidden.has(name)),
      rescanMs: 20,
      debounceMs: 5,
    });
    try {
      await makeRepo(dir, "later");
      await waitFor(
        () => changes.some((c) => c.added.includes("later")),
        "a served folder to be reported",
      );
      hidden.add("edge-dns");
      await waitFor(
        () => changes.some((c) => c.removed.includes("edge-dns")),
        "a listed folder no longer served to be reported removed",
      );
      assert((await Deno.stat(join(dir, "edge-dns"))).isDirectory);
      await Deno.remove(join(dir, "being-deleted"), { recursive: true });
      await makeRepo(dir, "last");
      await waitFor(
        () => changes.some((c) => c.added.includes("last")),
        "a later folder to be reported",
      );
      assertEquals(
        changes.flatMap((c) => [...c.added, ...c.removed])
          .filter((name) => name === "being-deleted"),
        [],
        "a folder never served is never reported",
      );
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

Deno.test("watchWorkspaces: a change whose handler throws is logged and reported again", async () => {
  await withTempDir(async (dir) => {
    const seen: string[] = [];
    const watcher = watchWorkspaces({
      dir,
      initial: [],
      onChange: (change) => {
        seen.push(...change.added);
        if (seen.filter((n) => n === "first").length < 2) {
          throw new Error("handler failed");
        }
      },
      rescanMs: 10,
      debounceMs: 5,
    });
    try {
      await makeRepo(dir, "first");
      await waitFor(
        () => seen.filter((n) => n === "first").length >= 2,
        "the failed change to be reported again",
      );
      await makeRepo(dir, "second");
      await waitFor(() => seen.includes("second"), "the next change");
      const firstReports = seen.filter((n) => n === "first").length;
      assertEquals(firstReports, 2, "reported again only until it succeeds");
    } finally {
      await watcher.stop();
    }
  });
});
