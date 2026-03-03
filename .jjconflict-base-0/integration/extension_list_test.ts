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
import { join } from "@std/path";

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

/** Write a fake upstream_extensions.json into the models dir of a repo. */
async function writeUpstreamExtensions(
  repoDir: string,
  data: Record<string, unknown>,
): Promise<void> {
  const modelsDir = join(repoDir, "extensions", "models");
  await Deno.mkdir(modelsDir, { recursive: true });
  await Deno.writeTextFile(
    join(modelsDir, "upstream_extensions.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

Deno.test("extension list --help shows usage", async () => {
  const { stdout } = await runCli(["extension", "list", "--help"]);
  assertStringIncludes(stdout, "list");
  assertStringIncludes(stdout, "List");
});

Deno.test("extension --help shows list subcommand", async () => {
  const { stdout } = await runCli(["extension", "--help"]);
  assertStringIncludes(stdout, "list");
});

Deno.test("extension list requires initialized repo", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const { stderr, code } = await runCli([
      "extension",
      "list",
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

Deno.test("extension list with no extensions shows empty message", async () => {
  const tmpDir = await initTempRepo();
  try {
    const { stdout, code } = await runCli([
      "extension",
      "list",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0);
    assertStringIncludes(stdout, "No upstream extensions installed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension list --json with no extensions returns empty array", async () => {
  const tmpDir = await initTempRepo();
  try {
    const { stdout, code } = await runCli([
      "extension",
      "list",
      "--json",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0);
    const parsed = JSON.parse(stdout);
    assertEquals(parsed.extensions, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension list shows installed extensions", async () => {
  const tmpDir = await initTempRepo();
  try {
    await writeUpstreamExtensions(tmpDir, {
      "@test/beta": {
        version: "2026.01.01.1",
        pulledAt: "2026-01-01T00:00:00.000Z",
        files: ["extensions/models/beta/model.yaml"],
      },
      "@test/alpha": {
        version: "2026.02.01.1",
        pulledAt: "2026-02-01T00:00:00.000Z",
        files: [
          "extensions/models/alpha/model.yaml",
          "extensions/models/alpha/handler.ts",
        ],
      },
    });

    const { stdout, code } = await runCli([
      "extension",
      "list",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0);
    // Should be sorted alphabetically — alpha before beta
    const alphaIdx = stdout.indexOf("@test/alpha");
    const betaIdx = stdout.indexOf("@test/beta");
    assertEquals(alphaIdx < betaIdx, true, "alpha should appear before beta");
    assertStringIncludes(stdout, "v2026.02.01.1");
    assertStringIncludes(stdout, "v2026.01.01.1");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension list --json shows installed extensions", async () => {
  const tmpDir = await initTempRepo();
  try {
    await writeUpstreamExtensions(tmpDir, {
      "@test/one": {
        version: "2026.01.15.1",
        pulledAt: "2026-01-15T12:00:00.000Z",
        files: ["extensions/models/one/model.yaml"],
      },
    });

    const { stdout, code } = await runCli([
      "extension",
      "list",
      "--json",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0);
    const parsed = JSON.parse(stdout);
    assertEquals(parsed.extensions.length, 1);
    assertEquals(parsed.extensions[0].name, "@test/one");
    assertEquals(parsed.extensions[0].version, "2026.01.15.1");
    assertEquals(parsed.extensions[0].files.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension list --verbose shows individual files", async () => {
  const tmpDir = await initTempRepo();
  try {
    await writeUpstreamExtensions(tmpDir, {
      "@test/verbose-ext": {
        version: "2026.01.01.1",
        pulledAt: "2026-01-01T00:00:00.000Z",
        files: [
          "extensions/models/verbose-ext/model.yaml",
          "extensions/models/verbose-ext/handler.ts",
        ],
      },
    });

    const { stdout, code } = await runCli([
      "extension",
      "list",
      "--verbose",
      "--repo-dir",
      tmpDir,
      "--no-color",
    ]);
    assertEquals(code, 0);
    assertStringIncludes(stdout, "model.yaml");
    assertStringIncludes(stdout, "handler.ts");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extension ls alias works", async () => {
  const { stdout } = await runCli(["extension", "ls", "--help"]);
  assertStringIncludes(stdout, "List");
});
