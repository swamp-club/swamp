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
import {
  deletingFolderName,
  deletingFolderOwner,
  isDeletingFolderName,
  REPO_MARKER_FILE,
  scanWorkspaces,
} from "./hosted_workspace_folder_scan.ts";

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

Deno.test("scanWorkspaces: passes over wanted and status files, and finds wanted files without a folder and leftover removals", async () => {
  await withTempDir(async (dir) => {
    await makeRepo(dir, "edge-dns");
    await Deno.writeTextFile(join(dir, "edge-dns.wanted.yaml"), "");
    await Deno.writeTextFile(join(dir, "edge-dns.status.yaml"), "");
    await Deno.writeTextFile(join(dir, "gone.wanted.yaml"), "");
    await Deno.writeTextFile(join(dir, "Bad.wanted.yaml"), "");
    const leftover = deletingFolderName("old");
    await Deno.mkdir(join(dir, leftover));
    const leftoverFile = deletingFolderName("was-a-link");
    await Deno.writeTextFile(join(dir, leftoverFile), "");
    await Deno.writeTextFile(join(dir, ".old.deleting-not-a-uuid"), "");

    const scan = await scanWorkspaces(dir);
    assertEquals(scan.workspaces, ["edge-dns"]);
    assertEquals(scan.wantedFiles, ["edge-dns", "gone"]);
    assertEquals(scan.leftovers, [leftover, leftoverFile].sort());
    assertEquals(scan.skipped.map((s) => s.name), ["Bad.wanted.yaml"]);
  });
});

Deno.test("deletingFolderOwner: names the workspace a hidden removal folder belonged to", () => {
  assertEquals(deletingFolderOwner(deletingFolderName("edge-dns")), "edge-dns");
  assertEquals(deletingFolderOwner("edge-dns"), null);
  assertEquals(deletingFolderOwner(".edge-dns.deleting-x"), null);
});

Deno.test("isDeletingFolderName: matches only a hidden valid name with a uuid", () => {
  assertEquals(isDeletingFolderName(deletingFolderName("edge-dns")), true);
  assertEquals(isDeletingFolderName("edge-dns"), false);
  assertEquals(isDeletingFolderName(".edge-dns.deleting-x"), false);
  assertEquals(
    isDeletingFolderName(`.Edge.deleting-${crypto.randomUUID()}`),
    false,
  );
  assertEquals(
    isDeletingFolderName(`.a/b.deleting-${crypto.randomUUID()}`),
    false,
  );
});

Deno.test("scanWorkspaces: a missing folder holds no workspaces", async () => {
  await withTempDir(async (dir) => {
    const { startedAt: _, ...scan } = await scanWorkspaces(
      join(dir, "missing"),
    );
    assertEquals(scan, {
      workspaces: [],
      skipped: [],
      wantedFiles: [],
      leftovers: [],
    });
  });
});

Deno.test("scanWorkspaces: a state folder with repos off reads only its wanted files", async () => {
  await withTempDir(async (dir) => {
    await makeRepo(dir, "edge-dns");
    await Deno.mkdir(join(dir, "not-a-repo"));
    await Deno.writeTextFile(
      join(dir, "billing.wanted.yaml"),
      "wanted: active\n",
    );
    await Deno.writeTextFile(join(dir, "billing.status.json"), "{}");
    await Deno.mkdir(join(dir, deletingFolderName("edge-dns")));
    await Deno.writeTextFile(join(dir, ".host-lock"), "");

    const scan = await scanWorkspaces(dir, { repos: false });
    assertEquals(scan.workspaces, []);
    assertEquals(scan.skipped, []);
    assertEquals(scan.leftovers, []);
    assertEquals(scan.wantedFiles, ["billing"]);
  });
});
