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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import {
  localAppControlPlane,
  localServeControlPlane,
} from "../src/cli/repo_context.ts";
import { localAppDeps } from "../src/cli/commands/app_deps.ts";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import { UserError } from "../src/domain/errors.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { ControlPlaneAppApprovalRepository } from "../src/infrastructure/persistence/control_plane_app_store.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";

const approval = {
  name: "@acme/cost",
  capabilityKey: "key",
  approvedBy: "user:operator",
  approvedAt: "2026-11-04T00:00:00.000Z",
};

async function withRepo(
  body: (dir: string) => Promise<void>,
  datastore?: (dir: string) => Record<string, unknown>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const homeDir = join(dir, "test-home");
    const repoPath = RepoPath.create(dir);
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(repoPath, { tools: [] });
    if (datastore) {
      const markers = new RepoMarkerRepository();
      const marker = await markers.read(repoPath);
      await markers.write(repoPath, {
        ...marker!,
        datastore: datastore(dir),
      } as never);
    }
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function assertSameRecord(dir: string): Promise<void> {
  // the CLI writes through one store and the local dashboard reads the other
  await new ControlPlaneAppApprovalRepository(
    await localServeControlPlane(dir),
  ).save(approval);
  assertEquals(
    await new ControlPlaneAppApprovalRepository(
      await localAppControlPlane(dir),
    ).get("@acme/cost"),
    approval,
  );
}

Deno.test("localAppControlPlane: reads what the CLI wrote on a filesystem datastore", async () => {
  await withRepo(assertSameRecord);
});

Deno.test("localAppControlPlane: reads what the CLI wrote on a v3 datastore", async () => {
  await withRepo(async (dir) => {
    await initializeV3Datastore(join(dir, "v3-store"), "test");
    await assertSameRecord(dir);
  }, (dir) => ({
    type: "filesystem",
    path: join(dir, "v3-store"),
    format: 3,
  }));
});

Deno.test("localAppDeps: approvals round-trip for a local repository", async () => {
  await withRepo(async (dir) => {
    const { deps } = await localAppDeps(dir, "log", getLogger(["test"]));
    await deps.approvals.save(approval);
    assertEquals(await deps.approvals.get("@acme/cost"), approval);
  });
});

Deno.test("localAppDeps: a v2 custom datastore is sent to the server", async () => {
  const type = `test-app-store-${crypto.randomUUID()}`;
  datastoreTypeRegistry.register({
    type,
    name: "Test app store",
    description: "A custom datastore for the app approval refusal",
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
        () => localAppDeps(dir, "log", getLogger(["test"])),
        UserError,
        "through the server",
      );
      assertStringIncludes(
        error.message,
        "may be kept in its shared control-plane store",
      );
    });
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});
