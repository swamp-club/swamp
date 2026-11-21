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
import { waitFor } from "@swamp-club/swamp-testing";
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
      served: () => [],
    });
    try {
      await waitFor(() => rescans >= 2, "two rescans");
    } finally {
      await watcher.stop();
    }
  });
});

Deno.test("watchWorkspaces: changes follow what is served, each reported once", async () => {
  await withTempDir(async (dir) => {
    const served = new Set(["edge-dns"]);
    const changes: WorkspaceChange[] = [];
    const watcher = watchWorkspaces({
      dir,
      initial: ["edge-dns"],
      onChange: (change) => {
        changes.push(change);
      },
      served: () => [...served].sort(),
      rescanMs: 20,
      debounceMs: 5,
    });
    try {
      served.add("cost-reports");
      await waitFor(
        () => changes.some((c) => c.added.includes("cost-reports")),
        "a workspace newly served to be reported",
      );
      served.delete("edge-dns");
      await waitFor(
        () => changes.some((c) => c.removed.includes("edge-dns")),
        "a workspace no longer served to be reported removed",
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
    const served = new Set<string>();
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
      served: () => [...served],
      rescanMs: 10,
      debounceMs: 5,
    });
    served.add("edge-dns");
    await waitFor(() => entered, "a change to be reported");
    let stopped = false;
    const stopping = watcher.stop().then(() => stopped = true);
    await Promise.resolve();
    assertEquals(stopped, false, "stop waits for the rescan in flight");
    release();
    await stopping;
    served.add("cost-reports");
    assertEquals(changes.length, 1);
  });
});

Deno.test("watchWorkspaces: a change whose handler throws is logged and reported again", async () => {
  await withTempDir(async (dir) => {
    const served = new Set<string>();
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
      served: () => [...served].sort(),
      rescanMs: 10,
      debounceMs: 5,
    });
    try {
      served.add("first");
      await waitFor(
        () => seen.filter((n) => n === "first").length >= 2,
        "the failed change to be reported again",
      );
      served.add("second");
      await waitFor(() => seen.includes("second"), "the next change");
      const firstReports = seen.filter((n) => n === "first").length;
      assertEquals(firstReports, 2, "reported again only until it succeeds");
    } finally {
      await watcher.stop();
    }
  });
});
