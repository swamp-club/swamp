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
