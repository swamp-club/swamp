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

// Initialize logging for tests
await initializeLogging({});

Deno.test("workflowEditCommand module loads", async () => {
  const { workflowEditCommand } = await import("./workflow_edit.ts");
  assertEquals(workflowEditCommand.getName(), "edit");
});

Deno.test("workflowEditCommand has correct description", async () => {
  const { workflowEditCommand } = await import("./workflow_edit.ts");
  assertEquals(
    workflowEditCommand.getDescription(),
    "Edit a workflow file",
  );
});

Deno.test("workflowEditCommand is registered as subcommand of workflowCommand", async () => {
  const { workflowCommand } = await import("./workflow.ts");
  const commands = workflowCommand.getCommands();
  const editCmd = commands.find((c) => c.getName() === "edit");
  assertEquals(editCmd !== undefined, true);
});

Deno.test("resolveWorkflowSymlink resolves existing symlink", async () => {
  const { resolveWorkflowSymlink } = await import("./workflow_edit.ts");
  const tempDir = await Deno.makeTempDir();
  try {
    // Resolve the temp dir to its real path (macOS /var -> /private/var)
    const realTempDir = await Deno.realPath(tempDir);

    // Create a target file
    const targetDir = join(realTempDir, ".swamp", "workflows");
    await ensureDir(targetDir);
    const targetFile = join(targetDir, "workflow-abc123.yaml");
    await Deno.writeTextFile(targetFile, "name: test-workflow\n");

    // Create the symlink structure
    const workflowDir = join(realTempDir, "workflows", "my-workflow");
    await ensureDir(workflowDir);
    await Deno.symlink(targetFile, join(workflowDir, "workflow.yaml"));

    const result = await resolveWorkflowSymlink(realTempDir, "my-workflow");
    assertNotEquals(result, null);
    assertEquals(result, targetFile);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkflowSymlink returns null for nonexistent symlink", async () => {
  const { resolveWorkflowSymlink } = await import("./workflow_edit.ts");
  const tempDir = await Deno.makeTempDir();
  try {
    const result = await resolveWorkflowSymlink(
      tempDir,
      "nonexistent-workflow",
    );
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
