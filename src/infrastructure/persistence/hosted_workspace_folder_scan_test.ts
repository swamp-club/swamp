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
  creatingFolderName,
  creatingFolderOwner,
  deletingFolderName,
  deletingFolderOwner,
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

Deno.test("deletingFolderOwner: names the workspace a hidden removal folder belonged to", () => {
  assertEquals(deletingFolderOwner(deletingFolderName("edge-dns")), "edge-dns");
  assertEquals(deletingFolderOwner("edge-dns"), null);
  assertEquals(deletingFolderOwner(".edge-dns.deleting-x"), null);
  assertEquals(
    deletingFolderOwner(`.Edge.deleting-${crypto.randomUUID()}`),
    null,
  );
  assertEquals(
    deletingFolderOwner(`.a/b.deleting-${crypto.randomUUID()}`),
    null,
  );
});

Deno.test("scanWorkspaces: a missing folder holds no workspaces", async () => {
  await withTempDir(async (dir) => {
    const { startedAt: _, ...scan } = await scanWorkspaces(
      join(dir, "missing"),
    );
    assertEquals(scan, { wantedFiles: [] });
  });
});

Deno.test("scanWorkspaces: reads only the wanted files of valid names, passing over folders, status files and hidden entries", async () => {
  await withTempDir(async (dir) => {
    await makeRepo(dir, "edge-dns");
    await Deno.mkdir(join(dir, "not-a-repo"));
    await Deno.writeTextFile(
      join(dir, "billing.wanted.yaml"),
      "wanted: active\n",
    );
    await Deno.writeTextFile(join(dir, "billing.status.json"), "{}");
    await Deno.writeTextFile(join(dir, "gone.wanted.yaml"), "");
    await Deno.writeTextFile(join(dir, "Bad.wanted.yaml"), "");
    await Deno.mkdir(join(dir, deletingFolderName("edge-dns")));
    await Deno.writeTextFile(join(dir, ".host-lock"), "");

    const scan = await scanWorkspaces(dir);
    assertEquals(scan.wantedFiles, ["billing", "gone"]);
  });
});

Deno.test("creatingFolderOwner: names the workspace a hidden set-up folder belongs to, and nothing else", () => {
  assertEquals(creatingFolderOwner(creatingFolderName("edge-dns")), "edge-dns");
  for (
    const entry of [
      "edge-dns",
      ".edge-dns.creating-",
      ".edge-dns.creating-not-a-uuid",
      deletingFolderName("edge-dns"),
      `.Edge.creating-${crypto.randomUUID()}`,
    ]
  ) {
    assertEquals(creatingFolderOwner(entry), null, entry);
  }
});
