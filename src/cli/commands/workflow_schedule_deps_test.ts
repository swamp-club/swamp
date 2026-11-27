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

import { assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";
import { localWorkflowScheduleDeps } from "./workflow_schedule_deps.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

const logger = getLogger(["test", "workflow-schedule-deps"]);

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

Deno.test("localWorkflowScheduleDeps: a v2 custom datastore is sent to the server", async () => {
  const type = `test-schedule-store-${crypto.randomUUID()}`;
  datastoreTypeRegistry.register({
    type,
    name: "Test schedule store",
    description: "A custom datastore for the schedule pause refusal",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: () => ({}),
      createVerifier: () => ({}),
      resolveDatastorePath: (repoDir: string) => repoDir,
    }),
  } as never);
  try {
    await withRepo(async (dir) => {
      const path = join(dir, ".swamp.yaml");
      const existing = await Deno.readTextFile(path);
      await Deno.writeTextFile(
        path,
        `${existing.trimEnd()}\ndatastore:\n  type: '${type}'\n  config:\n    bucket: b\n  managedConfig: true\n`,
      );
      const error = await assertRejects(
        () => localWorkflowScheduleDeps(dir, "log", logger),
        UserError,
        "through the server",
      );
      assertStringIncludes(
        error.message,
        `Schedule pauses of a "${type}" datastore may be kept in its shared control-plane store.`,
      );
    });
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});
