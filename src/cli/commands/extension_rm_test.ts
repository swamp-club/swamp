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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  removeUpstreamExtension,
  updateUpstreamExtensions,
} from "./extension_pull.ts";
import {
  readUpstreamExtensions,
  type UpstreamExtensionEntry,
} from "../../infrastructure/persistence/upstream_extensions.ts";

Deno.test("removeUpstreamExtension removes entry and preserves others", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    // Set up two extensions
    await updateUpstreamExtensions(lockfilePath, "@test/first", "1.0.0", [
      "a.yaml",
    ]);
    await updateUpstreamExtensions(lockfilePath, "@test/second", "2.0.0", [
      "b.yaml",
    ]);

    // Remove the first one
    await removeUpstreamExtension(lockfilePath, "@test/first");

    const content = await Deno.readTextFile(
      join(tmpDir, "upstream_extensions.json"),
    );
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/first"], undefined);
    assertEquals(data["@test/second"].version, "2.0.0");
    assertEquals(data["@test/second"].files, ["b.yaml"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("removeUpstreamExtension handles non-existent extension gracefully", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await updateUpstreamExtensions(lockfilePath, "@test/first", "1.0.0", [
      "a.yaml",
    ]);

    // Removing a non-existent entry should not throw
    await removeUpstreamExtension(lockfilePath, "@test/nonexistent");

    const content = await Deno.readTextFile(
      join(tmpDir, "upstream_extensions.json"),
    );
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/first"].version, "1.0.0");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("removeUpstreamExtension handles missing JSON file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    // Should not throw even when file doesn't exist
    await removeUpstreamExtension(lockfilePath, "@test/nonexistent");

    const content = await Deno.readTextFile(
      join(tmpDir, "upstream_extensions.json"),
    );
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
    await updateUpstreamExtensions(lockfilePath, "@test/ext", "1.0.0", [
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
