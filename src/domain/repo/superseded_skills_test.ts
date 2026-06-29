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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  detectSupersededSkills,
  removeSupersededSkills,
  SUPERSEDED_SKILLS,
} from "./superseded_skills.ts";

await initializeLogging({});

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp_superseded_test_" });
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

Deno.test("removeSupersededSkills: removes matching directories", async () => {
  await withTempDir(async (tempDir) => {
    await Deno.mkdir(join(tempDir, "swamp-extension-model"));
    await Deno.mkdir(join(tempDir, "swamp-data-query"));
    await Deno.mkdir(join(tempDir, "swamp"));

    await removeSupersededSkills(tempDir);

    const remaining = [];
    for await (const entry of Deno.readDir(tempDir)) {
      remaining.push(entry.name);
    }
    assertEquals(remaining, ["swamp"]);
  });
});

Deno.test("removeSupersededSkills: no-ops when directory has no superseded skills", async () => {
  await withTempDir(async (tempDir) => {
    await Deno.mkdir(join(tempDir, "swamp"));
    await Deno.mkdir(join(tempDir, "my-custom-skill"));

    await removeSupersededSkills(tempDir);

    const remaining = [];
    for await (const entry of Deno.readDir(tempDir)) {
      remaining.push(entry.name);
    }
    assertEquals(remaining.sort(), ["my-custom-skill", "swamp"]);
  });
});

Deno.test("removeSupersededSkills: handles nonexistent directory gracefully", async () => {
  await removeSupersededSkills("/tmp/nonexistent-dir-superseded-test");
});

Deno.test("detectSupersededSkills: returns empty when no superseded dirs exist", async () => {
  await withTempDir(async (tempDir) => {
    const result = await detectSupersededSkills(tempDir);
    assertEquals(result, []);
  });
});

Deno.test("detectSupersededSkills: detects superseded skill directories", async () => {
  await withTempDir(async (tempDir) => {
    await Deno.mkdir(join(tempDir, "swamp-extension-model"));
    await Deno.mkdir(join(tempDir, "swamp-data-query"));
    await Deno.mkdir(join(tempDir, "swamp"));

    const result = await detectSupersededSkills(tempDir);
    assertEquals(result.sort(), ["swamp-data-query", "swamp-extension-model"]);
  });
});

Deno.test("SUPERSEDED_SKILLS: contains expected entries", () => {
  assertEquals(SUPERSEDED_SKILLS.includes("swamp-extension-model"), true);
  assertEquals(SUPERSEDED_SKILLS.includes("swamp-data-query"), true);
  assertEquals(SUPERSEDED_SKILLS.includes("swamp"), false);
});
