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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { APP_SOURCE_DIR } from "../../domain/apps/app_descriptor.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";
import { localAppDeps } from "./app_deps.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

const logger = getLogger(["test", "app-deps"]);

async function withRepo(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const homeDir = join(dir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    await body(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("localAppDeps: lists the repository's own apps", async () => {
  await withRepo(async (dir) => {
    const app = join(dir, APP_SOURCE_DIR, "cost");
    await Deno.mkdir(app, { recursive: true });
    await Deno.writeTextFile(
      join(app, "app.yaml"),
      `name: "@acme/cost"\ntitle: Cost\nbridge: 1\n`,
    );
    const { deps } = await localAppDeps(dir, "json", logger);
    const { apps } = await deps.catalog.list();
    assertEquals(
      apps.map((entry) => [entry.descriptor.name, entry.origin]),
      [["@acme/cost", "local"]],
    );
  });
});

Deno.test("localAppDeps: an approval is kept where the next command reads it", async () => {
  await withRepo(async (dir) => {
    const approval = {
      name: "@acme/cost",
      capabilityKey: "k",
      approvedBy: "adam",
      approvedAt: "2026-01-01T00:00:00.000Z",
    };
    await (await localAppDeps(dir, "json", logger)).deps.approvals.save(
      approval,
    );
    const { deps } = await localAppDeps(dir, "json", logger);
    assertEquals(await deps.approvals.get("@acme/cost"), approval);
  });
});

Deno.test("localAppDeps: refuses a folder that is not a repository", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(() => localAppDeps(dir, "json", logger), UserError);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
