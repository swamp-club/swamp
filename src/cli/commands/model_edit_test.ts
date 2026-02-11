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

import { assertEquals, assertNotEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("modelEditCommand module loads", async () => {
  const { modelEditCommand } = await import("./model_edit.ts");
  assertEquals(modelEditCommand.getName(), "edit");
});

Deno.test("modelEditCommand has correct description", async () => {
  const { modelEditCommand } = await import("./model_edit.ts");
  assertEquals(
    modelEditCommand.getDescription(),
    "Edit a model definition file",
  );
});

Deno.test("modelEditCommand is registered as subcommand of modelCommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const editCmd = commands.find((c) => c.getName() === "edit");
  assertEquals(editCmd !== undefined, true);
});

Deno.test("resolveModelSymlink resolves existing symlink", async () => {
  const { resolveModelSymlink } = await import("./model_edit.ts");
  const tempDir = await Deno.makeTempDir();
  try {
    // Resolve the temp dir to its real path (macOS /var -> /private/var)
    const realTempDir = await Deno.realPath(tempDir);

    // Create a target file
    const targetDir = join(realTempDir, ".swamp", "definitions", "test");
    await ensureDir(targetDir);
    const targetFile = join(targetDir, "abc123.yaml");
    await Deno.writeTextFile(targetFile, "name: test-model\n");

    // Create the symlink structure
    const modelDir = join(realTempDir, "models", "my-model");
    await ensureDir(modelDir);
    await Deno.symlink(targetFile, join(modelDir, "definition.yaml"));

    const result = await resolveModelSymlink(realTempDir, "my-model");
    assertNotEquals(result, null);
    assertEquals(result, targetFile);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveModelSymlink returns null for nonexistent symlink", async () => {
  const { resolveModelSymlink } = await import("./model_edit.ts");
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await resolveModelSymlink(tempDir, "nonexistent-model");
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
