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
