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

import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { UserError } from "../../domain/errors.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-datastore-compact-" });
  try {
    const homeDir = join(dir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function compact(dir: string, args: string[]): Promise<unknown> {
  const { datastoreCompactCommand } = await import("./datastore_compact.ts");
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => printed.push(parts.join(" "));
  try {
    await new Command()
      .globalOption("--json", "JSON output")
      .command("compact", datastoreCompactCommand)
      .parse(["compact", "--repo-dir", dir, ...args, "--json"]);
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(printed.join("\n"));
}

Deno.test("datastore compact: the description still starts with the catalog compaction it always did", async () => {
  const { datastoreCompactCommand } = await import("./datastore_compact.ts");
  assertMatch(datastoreCompactCommand.getDescription(), /^Checkpoint the WAL/i);
});

Deno.test({
  name: "datastore compact: without --history, the json output keeps its keys",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (dir) => {
      const output = await compact(dir, []) as Record<string, unknown>;
      assertEquals(Object.keys(output), [
        "walPagesTotal",
        "walPagesCheckpointed",
        "dbBytesReclaimed",
        "vacuumSkipped",
      ]);
    });
  },
});

Deno.test({
  name:
    "datastore compact: --server or --token without --history is refused, never sent anywhere",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (dir) => {
      for (
        const flags of [
          ["--server", "http://127.0.0.1:1"],
          ["--token", "secret"],
        ]
      ) {
        await assertRejects(
          () => compact(dir, flags),
          UserError,
          "apply only with --history",
        );
      }
    });
  },
});

Deno.test({
  name: "datastore compact --history: a v2 datastore has no history to compact",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (dir) => {
      assertEquals(await compact(dir, ["--history"]), { applies: false });
    });
  },
});
