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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  detectLegacyExtensionLayout,
  requireCurrentExtensionLayout,
} from "./layout.ts";
import { UserError } from "../../domain/errors.ts";

Deno.test("detectLegacyExtensionLayout: returns empty for new layout", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [
            ".swamp/pulled-extensions/models/ext.ts",
            ".swamp/bundles/ext.js",
          ],
        },
      }),
    );

    const legacyFiles = await detectLegacyExtensionLayout(lockfilePath);
    assertEquals(legacyFiles, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("detectLegacyExtensionLayout: detects old layout files", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [
            "extensions/models/ext.ts",
            ".swamp/bundles/ext.js",
          ],
        },
      }),
    );

    const legacyFiles = await detectLegacyExtensionLayout(lockfilePath);
    assertEquals(legacyFiles, ["extensions/models/ext.ts"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("detectLegacyExtensionLayout: returns empty when no lockfile", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const legacyFiles = await detectLegacyExtensionLayout(lockfilePath);
    assertEquals(legacyFiles, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("requireCurrentExtensionLayout: throws on legacy layout", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: ["extensions/models/ext.ts"],
        },
      }),
    );

    await assertRejects(
      () => requireCurrentExtensionLayout(lockfilePath),
      UserError,
      "old layout",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("requireCurrentExtensionLayout: passes on current layout", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/models/ext.ts"],
        },
      }),
    );

    // Should not throw
    await requireCurrentExtensionLayout(lockfilePath);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
