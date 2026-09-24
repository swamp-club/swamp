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
import { createExtensionInstallDeps } from "./create_extension_install_deps.ts";
import { ManagedConfigUnresolvedError } from "./repo_context.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { assertPathEquals } from "../infrastructure/persistence/path_test_helpers.ts";

const logger = getLogger(["swamp", "test"]);

async function withRepo(
  marker: Omit<RepoMarkerData, "swampVersion" | "initializedAt">,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_install_deps_" });
  try {
    await new RepoMarkerRepository().write(RepoPath.create(dir), {
      swampVersion: "0.1.0",
      initializedAt: "2026-01-01T00:00:00.000Z",
      tools: [],
      ...marker,
    });
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("createExtensionInstallDeps: uses the models-dir lockfile in an unmanaged repo", async () => {
  await withRepo({}, async (dir) => {
    const deps = await createExtensionInstallDeps(dir, logger);
    assertPathEquals(
      deps.lockfilePath,
      join(dir, "extensions", "models", "upstream_extensions.json"),
    );
  });
});

Deno.test("createExtensionInstallDeps: refuses an unresolved extension-backed managed config base", async () => {
  const type = `@t${crypto.randomUUID().slice(0, 8)}/ds`;
  await withRepo(
    { datastore: { type, managedConfig: true } },
    async (dir) => {
      await assertRejects(
        () => createExtensionInstallDeps(dir, logger),
        ManagedConfigUnresolvedError,
      );
    },
  );
});

Deno.test("createExtensionInstallDeps: an explicit lockfile path skips resolution and the guard", async () => {
  const type = `@t${crypto.randomUUID().slice(0, 8)}/ds`;
  await withRepo(
    { datastore: { type, managedConfig: true } },
    async (dir) => {
      const lockfilePath = join(dir, "cache", "upstream_extensions.json");
      const deps = await createExtensionInstallDeps(dir, logger, {
        lockfilePath,
      });
      assertEquals(deps.lockfilePath, lockfilePath);
    },
  );
});
