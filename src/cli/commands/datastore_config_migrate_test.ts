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
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { ensureManagedConfig } from "./datastore_config_migrate.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-config-migrate-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function baseMarker(managedConfig?: boolean): RepoMarkerData {
  return {
    swampVersion: "1.0.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    datastore: {
      type: "filesystem",
      path: "/shared/datastore",
      directories: ["auto-definitions"],
      ...(managedConfig === undefined ? {} : { managedConfig }),
    },
  };
}

Deno.test("ensureManagedConfig: sets managedConfig and keeps other datastore fields when absent", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);
    const marker = baseMarker();
    await repo.write(repoPath, marker);

    const written = await ensureManagedConfig(repo, repoPath, marker);

    assertEquals(written, true);
    const reread = await repo.read(repoPath);
    assertEquals(reread?.datastore, {
      type: "filesystem",
      path: "/shared/datastore",
      directories: ["auto-definitions"],
      managedConfig: true,
    });
  });
});

Deno.test("ensureManagedConfig: leaves the marker untouched when managedConfig is already true", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);
    const marker = baseMarker(true);
    await repo.write(repoPath, marker);
    const markerPath = repo.getMarkerPath(repoPath);
    const before = await Deno.readTextFile(markerPath);

    const written = await ensureManagedConfig(repo, repoPath, marker);

    assertEquals(written, false);
    assertEquals(await Deno.readTextFile(markerPath), before);
  });
});

Deno.test("ensureManagedConfig: returns false without writing when no datastore is configured", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);
    const marker: RepoMarkerData = {
      swampVersion: "1.0.0",
      initializedAt: "2026-01-01T00:00:00.000Z",
    };

    const written = await ensureManagedConfig(repo, repoPath, marker);

    assertEquals(written, false);
    assertEquals(await repo.exists(repoPath), false);
  });
});
