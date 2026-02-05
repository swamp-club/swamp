/**
 * Shared test helpers for integration tests.
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";

/**
 * Initializes a test repository with the required marker file and directory structure.
 * Call this before running any CLI commands that require an initialized repo.
 */
export async function initializeTestRepo(repoDir: string): Promise<void> {
  // Create the .swamp directory structure
  const subdirs = [
    ".swamp/definitions",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/workflows",
    ".swamp/workflow-runs",
    ".swamp/vault",
    ".swamp/secrets",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(repoDir, subdir));
  }

  // Create the .swamp.yaml marker file
  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(markerData as Record<string, unknown>),
  );
}

/**
 * Runs a CLI command via `deno task dev`.
 */
export async function runCliCommand(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}
