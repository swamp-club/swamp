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
import { LockfileRepository } from "./extension_pull.ts";
import {
  readUpstreamExtensions,
  type UpstreamExtensionEntry,
} from "../../infrastructure/persistence/upstream_extensions.ts";

Deno.test("LockfileRepository.removeEntry removes entry and preserves others", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repoFirst = await LockfileRepository.create(lockfilePath);
    await repoFirst.writeEntry("@test/first", "1.0.0", ["a.yaml"]);
    const repoSecond = await LockfileRepository.create(lockfilePath);
    await repoSecond.writeEntry("@test/second", "2.0.0", ["b.yaml"]);

    // Remove the first one via a fresh instance.
    const repoRm = await LockfileRepository.create(lockfilePath);
    await repoRm.removeEntry("@test/first");

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/first"], undefined);
    assertEquals(data["@test/second"].version, "2.0.0");
    assertEquals(data["@test/second"].files, ["b.yaml"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("LockfileRepository.removeEntry handles non-existent extension gracefully", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(lockfilePath);
    await repo.writeEntry("@test/first", "1.0.0", ["a.yaml"]);

    // Removing a non-existent entry should not throw.
    await repo.removeEntry("@test/nonexistent");

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/first"].version, "1.0.0");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("LockfileRepository.removeEntry handles missing JSON file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(lockfilePath);
    // Should not throw even when file doesn't exist.
    await repo.removeEntry("@test/nonexistent");

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(Object.keys(data).length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readUpstreamExtensions reads existing entries", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(lockfilePath);
    await repo.writeEntry("@test/ext", "1.0.0", [
      "extensions/models/foo.yaml",
    ]);

    const data = await readUpstreamExtensions(lockfilePath);

    assertEquals(data["@test/ext"].version, "1.0.0");
    assertEquals(data["@test/ext"].files, ["extensions/models/foo.yaml"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readUpstreamExtensions returns empty map when file missing", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const data = await readUpstreamExtensions(lockfilePath);
    assertEquals(Object.keys(data).length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
