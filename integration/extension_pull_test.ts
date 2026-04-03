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

Deno.test("extension pull --help shows usage", async () => {
  const { stdout } = await runCli(["extension", "pull", "--help"]);
  assertStringIncludes(stdout, "pull");
  assertStringIncludes(stdout, "extension");
});

Deno.test("extension --help shows pull subcommand", async () => {
  const { stdout } = await runCli(["extension", "--help"]);
  assertStringIncludes(stdout, "pull");
});

Deno.test("extension pull with invalid name (no @ prefix) gives clear error", async () => {
  const tmpDir = await initTempRepo();
  try {
    const { stderr, code } = await runCli([
      "extension",
      "pull",
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

Deno.test("extension pull requires initialized repo", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { stderr, code } = await runCli([
      "extension",
      "pull",
      "@test/ext",
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
  env?: Record<string, string>,
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

Deno.test("extension pull persists files in upstream_extensions.json", async () => {
  const tmpDir = await initTempRepo();
  try {
    const { code, stderr } = await runCliWithNet([
      "extension",
      "pull",
      "@keeb/ssh",
      "--force",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0, `Pull failed: ${stderr}`);

    // Read upstream_extensions.json and verify files array
    const jsonPath = `${tmpDir}/extensions/models/upstream_extensions.json`;
    const content = await Deno.readTextFile(jsonPath);
    const data = JSON.parse(content) as Record<
      string,
      { version: string; pulledAt: string; files?: string[] }
    >;

    const entry = data["@keeb/ssh"];
    assertEquals(typeof entry, "object", "Entry for @keeb/ssh should exist");
    assertEquals(
      Array.isArray(entry.files),
      true,
      "files should be an array",
    );
    assertEquals(
      (entry.files as string[]).length > 0,
      true,
      "files array should be non-empty",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension pull and load works for @stack72/letsencrypt-certificate", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Pull the extension
    const { code, stderr } = await runCliWithNet([
      "extension",
      "pull",
      "@stack72/letsencrypt-certificate@2026.03.04.1",
      "--force",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0, `Pull failed: ${stderr}`);

    // Verify the bundle was extracted into a namespaced subdirectory.
    // The namespace hash is based on the pulled models directory.
    const bundlesDir = `${tmpDir}/.swamp/bundles`;
    let foundBundle = false;
    for await (const entry of Deno.readDir(bundlesDir)) {
      if (entry.isDirectory) {
        try {
          const stat = await Deno.stat(
            `${bundlesDir}/${entry.name}/letsencrypt_certificate.js`,
          );
          if (stat.isFile) {
            foundBundle = true;
            break;
          }
        } catch {
          // Not in this namespace dir
        }
      }
    }
    assertEquals(
      foundBundle,
      true,
      "Bundle should be extracted into namespaced subdirectory",
    );

    // Verify the model loads at runtime by searching for it.
    // model type search uses cwd to find the repo, so run from tmpDir.
    const searchCmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--unstable-bundle",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-net",
        "--allow-sys",
        `${PROJECT_ROOT}/main.ts`,
        "model",
        "type",
        "search",
        "letsencrypt",
        "--json",
      ],
      stdout: "piped",
      stderr: "piped",
      cwd: tmpDir,
      env: {
        ...Deno.env.toObject(),
        SWAMP_NO_TELEMETRY: "1",
      },
    });
    const searchOutput = await searchCmd.output();
    const searchStdout = new TextDecoder().decode(searchOutput.stdout);
    const searchStderr = new TextDecoder().decode(searchOutput.stderr);
    assertEquals(
      searchOutput.code,
      0,
      `Search failed: ${searchStderr}`,
    );
    assertStringIncludes(
      searchStdout,
      "@stack72/letsencrypt-certificate",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension pull does not require authentication", async () => {
  const tmpDir = await initTempRepo();
  try {
    // Point to a non-existent server so the request fails at the network level,
    // not at authentication
    const { stderr, code } = await runCli(
      [
        "extension",
        "pull",
        "@test/ext",
        "--repo-dir",
        tmpDir,
        "--no-color",
      ],
      {
        SWAMP_CLUB_URL: "http://localhost:1",
      },
    );
    assertEquals(code === 0, false);
    // Should fail with a connection error, not an auth error
    assertStringIncludes(stderr, "Could not connect");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
