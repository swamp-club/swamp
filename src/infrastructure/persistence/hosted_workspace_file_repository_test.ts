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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
import {
  hostedWorkspaceFileOf,
  HostedWorkspaceFileRepository,
  MAX_WANTED_FILE_BYTES,
  statusFileName,
  wantedFileName,
} from "./hosted_workspace_file_repository.ts";

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

async function unreadableReason(
  repo: HostedWorkspaceFileRepository,
  name: string,
): Promise<string> {
  const read = await repo.findByName(name);
  assert(read.kind === "unreadable", `expected unreadable, got ${read.kind}`);
  return read.reason;
}

Deno.test("HostedWorkspaceFileRepository: a saved workspace reads back the same", async () => {
  await withTempDir(async (dir) => {
    const repo = new HostedWorkspaceFileRepository(dir);
    const workspace = HostedWorkspace.create(
      "edge-dns",
      "alice",
      new Date("2026-11-17T10:00:00.000Z"),
    ).suspend(new Date("2026-11-17T11:00:00.000Z"));
    await repo.save(workspace);
    const read = await repo.findByName("edge-dns");
    assert(read.kind === "found");
    assert(read.workspace.equals(workspace));
    assertEquals(
      parseYaml(await Deno.readTextFile(join(dir, "edge-dns.wanted.yaml"))),
      {
        wanted: "suspended",
        creator: "alice",
        changedAt: "2026-11-17T11:00:00.000Z",
      },
    );
    const leftovers = [...Deno.readDirSync(dir)].map((e) => e.name);
    assertEquals(leftovers, ["edge-dns.wanted.yaml"], "no temp file is left");
  });
});

Deno.test("HostedWorkspaceFileRepository: a file an operator wrote with only the wanted line is read", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "edge-dns.wanted.yaml"),
      "wanted: suspended\n",
    );
    const read = await new HostedWorkspaceFileRepository(dir).findByName(
      "edge-dns",
    );
    assert(read.kind === "found");
    assertEquals(read.workspace.toRecord(), {
      name: "edge-dns",
      creator: null,
      wanted: "suspended",
      changedAt: null,
    });
  });
});

Deno.test("HostedWorkspaceFileRepository: an unquoted time an operator typed is read as the same time", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "edge-dns.wanted.yaml"),
      "wanted: active\nchangedAt: 2026-11-17T12:00:00Z\n",
    );
    const read = await new HostedWorkspaceFileRepository(dir).findByName(
      "edge-dns",
    );
    assert(read.kind === "found");
    assertEquals(read.workspace.changedAt, "2026-11-17T12:00:00.000Z");
  });
});

Deno.test("HostedWorkspaceFileRepository: a missing file is absent and removing it again is fine", async () => {
  await withTempDir(async (dir) => {
    const repo = new HostedWorkspaceFileRepository(dir);
    assertEquals(await repo.findByName("edge-dns"), { kind: "absent" });
    await repo.save(HostedWorkspace.active("edge-dns"));
    await repo.remove("edge-dns");
    await repo.remove("edge-dns");
    assertEquals(await repo.findByName("edge-dns"), { kind: "absent" });
  });
});

Deno.test("HostedWorkspaceFileRepository: a file that cannot be used is unreadable with the reason, never a default", async () => {
  await withTempDir(async (dir) => {
    const repo = new HostedWorkspaceFileRepository(dir);
    const path = join(dir, "edge-dns.wanted.yaml");

    await Deno.writeTextFile(path, "wanted: [active\n");
    assertStringIncludes(
      await unreadableReason(repo, "edge-dns"),
      "not valid YAML",
    );

    await Deno.writeTextFile(path, "wanted: paused\n");
    const reason = await unreadableReason(repo, "edge-dns");
    assertStringIncludes(reason, path);
    assertStringIncludes(reason, "wanted:");

    await Deno.writeTextFile(path, "wanted: active\nwnated: suspended\n");
    await unreadableReason(repo, "edge-dns");

    await Deno.writeTextFile(path, "");
    await unreadableReason(repo, "edge-dns");

    await Deno.writeFile(path, new Uint8Array([0xff, 0xfe, 0x00]));
    await unreadableReason(repo, "edge-dns");

    await Deno.writeTextFile(
      path,
      `wanted: active\ncreator: ${"a".repeat(MAX_WANTED_FILE_BYTES)}\n`,
    );
    assertStringIncludes(
      await unreadableReason(repo, "edge-dns"),
      `larger than ${MAX_WANTED_FILE_BYTES} bytes`,
    );

    await Deno.remove(path);
    await Deno.mkdir(path);
    assertStringIncludes(
      await unreadableReason(repo, "edge-dns"),
      "not a regular file",
    );
  });
});

Deno.test("hostedWorkspaceFileOf: names the workspace of a wanted or status file and nothing else", () => {
  assertEquals(hostedWorkspaceFileOf(wantedFileName("edge-dns")), {
    name: "edge-dns",
    kind: "wanted",
  });
  assertEquals(hostedWorkspaceFileOf(statusFileName("edge-dns")), {
    name: "edge-dns",
    kind: "status",
  });
  assertEquals(hostedWorkspaceFileOf("edge-dns"), null);
  assertEquals(hostedWorkspaceFileOf("Edge.wanted.yaml"), null);
  assertEquals(hostedWorkspaceFileOf(".wanted.yaml"), null);
  assertEquals(hostedWorkspaceFileOf("edge-dns.wanted.yml"), null);
});
