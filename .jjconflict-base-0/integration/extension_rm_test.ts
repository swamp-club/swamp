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

import { assertStringIncludes } from "@std/assert/string-includes";
import { assertEquals } from "@std/assert";

const PROJECT_ROOT = Deno.cwd();

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: PROJECT_ROOT,
    env: {
      ...Deno.env.toObject(),
      SWAMP_NO_TELEMETRY: "1",
      ...env,
    },
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

/** Initialize a swamp repo in a temp directory. */
async function initTempRepo(): Promise<string> {
  const tmpDir = await Deno.makeTempDir();
  await runCli(["init", tmpDir]);
  return tmpDir;
}

Deno.test("extension rm --help shows usage", async () => {
  const { stdout } = await runCli(["extension", "rm", "--help"]);
  assertStringIncludes(stdout, "rm");
  assertStringIncludes(stdout, "Remove");
});

Deno.test("extension --help shows rm subcommand", async () => {
  const { stdout } = await runCli(["extension", "--help"]);
  assertStringIncludes(stdout, "rm");
});

Deno.test("extension rm with invalid name gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const { stderr, code } = await runCli([
      "extension",
      "rm",
      "invalid-name",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "must start with");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension rm of non-installed extension gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const { stderr, code } = await runCli([
      "extension",
      "rm",
      "@test/nonexistent",
      "--force",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "is not installed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension rm requires initialized repo", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { stderr, code } = await runCli([
      "extension",
      "rm",
      "@test/ext",
      "--force",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code === 0, false);
    assertStringIncludes(stderr, "Not a swamp repository");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

/** Runs the CLI with --allow-net (needed for tests that pull from the registry). */
async function runCliWithNet(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-net",
      "--allow-sys",
      "main.ts",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
    cwd: PROJECT_ROOT,
    env: {
      ...Deno.env.toObject(),
      SWAMP_NO_TELEMETRY: "1",
    },
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test("extension pull then rm removes files and JSON entry", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Pull the extension first
    const pullResult = await runCliWithNet([
      "extension",
      "pull",
      "@keeb/ssh",
      "--force",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(pullResult.code, 0, `Pull failed: ${pullResult.stderr}`);

    // Read upstream_extensions.json to get the file list
    const jsonPath = `${tmpDir}/extensions/models/upstream_extensions.json`;
    const beforeContent = await Deno.readTextFile(jsonPath);
    const beforeData = JSON.parse(beforeContent) as Record<
      string,
      { version: string; files?: string[] }
    >;
    const files = beforeData["@keeb/ssh"].files;
    assertEquals(
      Array.isArray(files),
      true,
      "files should be an array before rm",
    );

    // Verify files exist on disk before removal
    for (const file of files!) {
      const stat = await Deno.stat(`${tmpDir}/${file}`);
      assertEquals(stat.isFile, true, `File should exist before rm: ${file}`);
    }

    // Remove the extension
    const rmResult = await runCli([
      "extension",
      "rm",
      "@keeb/ssh",
      "--force",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(rmResult.code, 0, `Rm failed: ${rmResult.stderr}`);

    // Verify files no longer exist on disk
    for (const file of files!) {
      let exists = true;
      try {
        await Deno.stat(`${tmpDir}/${file}`);
      } catch {
        exists = false;
      }
      assertEquals(exists, false, `File should not exist after rm: ${file}`);
    }

    // Verify entry removed from upstream_extensions.json
    const afterContent = await Deno.readTextFile(jsonPath);
    const afterData = JSON.parse(afterContent) as Record<string, unknown>;
    assertEquals(
      afterData["@keeb/ssh"],
      undefined,
      "Entry should be removed from upstream_extensions.json",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
