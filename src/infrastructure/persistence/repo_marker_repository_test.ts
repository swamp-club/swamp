// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { RepoMarkerRepository } from "./repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { SwampVersion } from "../../domain/repo/swamp_version.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-marker-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("RepoMarkerRepository.getMarkerPath returns correct path", () => {
  const repo = new RepoMarkerRepository();
  const repoPath = RepoPath.create("/some/repo");

  const markerPath = repo.getMarkerPath(repoPath);

  assertEquals(markerPath, "/some/repo/.swamp.yaml");
});

Deno.test("RepoMarkerRepository.exists returns false when marker does not exist", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);

    const result = await repo.exists(repoPath);

    assertEquals(result, false);
  });
});

Deno.test("RepoMarkerRepository.exists returns true when marker exists", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);

    // Create marker file manually
    const markerPath = join(dir, ".swamp.yaml");
    await Deno.writeTextFile(markerPath, "swampVersion: 0.1.0\n");

    const result = await repo.exists(repoPath);

    assertEquals(result, true);
  });
});

Deno.test("RepoMarkerRepository.exists returns false for directory at marker path", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);

    // Create a directory instead of a file
    await Deno.mkdir(join(dir, ".swamp.yaml"));

    const result = await repo.exists(repoPath);

    assertEquals(result, false);
  });
});

Deno.test("RepoMarkerRepository.read returns null when marker does not exist", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);

    const result = await repo.read(repoPath);

    assertEquals(result, null);
  });
});

Deno.test("RepoMarkerRepository.read parses YAML correctly", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);

    // Create marker file with known content
    const markerPath = join(dir, ".swamp.yaml");
    const content = `swampVersion: "1.2.3"
initializedAt: "2024-01-15T10:30:00.000Z"
`;
    await Deno.writeTextFile(markerPath, content);

    const result = await repo.read(repoPath);

    assertEquals(result !== null, true);
    assertEquals(result!.swampVersion, "1.2.3");
    assertEquals(result!.initializedAt, "2024-01-15T10:30:00.000Z");
    assertEquals(result!.upgradedAt, undefined);
  });
});

Deno.test("RepoMarkerRepository.read parses YAML with upgradedAt", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);

    const markerPath = join(dir, ".swamp.yaml");
    const content = `swampVersion: "2.0.0"
initializedAt: "2024-01-15T10:30:00.000Z"
upgradedAt: "2024-02-20T14:00:00.000Z"
`;
    await Deno.writeTextFile(markerPath, content);

    const result = await repo.read(repoPath);

    assertEquals(result !== null, true);
    assertEquals(result!.swampVersion, "2.0.0");
    assertEquals(result!.initializedAt, "2024-01-15T10:30:00.000Z");
    assertEquals(result!.upgradedAt, "2024-02-20T14:00:00.000Z");
  });
});

Deno.test("RepoMarkerRepository.write creates valid YAML", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);

    const data = {
      swampVersion: "1.0.0",
      initializedAt: "2024-01-15T10:30:00.000Z",
    };

    await repo.write(repoPath, data);

    const markerPath = join(dir, ".swamp.yaml");
    const content = await Deno.readTextFile(markerPath);
    assertStringIncludes(content, "swampVersion:");
    assertStringIncludes(content, "1.0.0");
    assertStringIncludes(content, "initializedAt:");
    assertStringIncludes(content, "2024-01-15T10:30:00.000Z");
  });
});

Deno.test("RepoMarkerRepository.write creates valid YAML with upgradedAt", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);

    const data = {
      swampVersion: "2.0.0",
      initializedAt: "2024-01-15T10:30:00.000Z",
      upgradedAt: "2024-02-20T14:00:00.000Z",
    };

    await repo.write(repoPath, data);

    const markerPath = join(dir, ".swamp.yaml");
    const content = await Deno.readTextFile(markerPath);
    assertStringIncludes(content, "upgradedAt:");
    assertStringIncludes(content, "2024-02-20T14:00:00.000Z");
  });
});

Deno.test("RepoMarkerRepository.write and read roundtrip", async () => {
  await withTempDir(async (dir) => {
    const repo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(dir);

    const original = {
      swampVersion: "1.2.3",
      initializedAt: "2024-01-15T10:30:00.000Z",
      upgradedAt: "2024-02-20T14:00:00.000Z",
    };

    await repo.write(repoPath, original);
    const result = await repo.read(repoPath);

    assertEquals(result, original);
  });
});

Deno.test("RepoMarkerRepository.createInitMarker creates correct data", () => {
  const repo = new RepoMarkerRepository();
  const version = SwampVersion.create("1.0.0");

  const marker = repo.createInitMarker(version);

  assertEquals(marker.swampVersion, "1.0.0");
  assertEquals(typeof marker.initializedAt, "string");
  // Verify it's a valid ISO date
  const date = new Date(marker.initializedAt);
  assertEquals(isNaN(date.getTime()), false);
  assertEquals(marker.upgradedAt, undefined);
});

Deno.test("RepoMarkerRepository.createUpgradeMarker preserves existing data", () => {
  const repo = new RepoMarkerRepository();
  const existing = {
    swampVersion: "1.0.0",
    initializedAt: "2024-01-15T10:30:00.000Z",
  };
  const newVersion = SwampVersion.create("2.0.0");

  const marker = repo.createUpgradeMarker(existing, newVersion);

  assertEquals(marker.swampVersion, "2.0.0");
  assertEquals(marker.initializedAt, "2024-01-15T10:30:00.000Z");
  assertEquals(typeof marker.upgradedAt, "string");
  // Verify upgradedAt is a valid ISO date
  const date = new Date(marker.upgradedAt!);
  assertEquals(isNaN(date.getTime()), false);
});

Deno.test("RepoMarkerRepository.createUpgradeMarker always sets upgradedAt", () => {
  const repo = new RepoMarkerRepository();
  const existing = {
    swampVersion: "1.0.0",
    initializedAt: "2024-01-15T10:30:00.000Z",
    upgradedAt: "2024-02-01T00:00:00.000Z",
  };
  const newVersion = SwampVersion.create("3.0.0");

  const marker = repo.createUpgradeMarker(existing, newVersion);

  assertEquals(marker.upgradedAt !== undefined, true);
  // The new upgradedAt should be different from the old one
  assertEquals(marker.upgradedAt !== existing.upgradedAt, true);
});
