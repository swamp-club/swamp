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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { VERSION } from "../src/cli/commands/version.ts";
import { CLI_ARGS } from "./test_helpers.ts";

// Integration tests run the CLI as a subprocess to test end-to-end behavior

async function runCliCommand(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: cwd ?? Deno.cwd(),
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cli-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("CLI with no args shows help", async () => {
  const { stdout } = await runCliCommand([]);
  assertStringIncludes(stdout, "swamp");
  assertStringIncludes(stdout, "Usage:");
});

Deno.test("CLI with --help shows help", async () => {
  const { stdout } = await runCliCommand(["--help"]);
  assertStringIncludes(stdout, "swamp");
  assertStringIncludes(stdout, "Usage:");
  assertStringIncludes(stdout, "--json");
  assertStringIncludes(stdout, "--quiet");
  assertStringIncludes(stdout, "--verbose");
});

Deno.test("CLI with --version shows version", async () => {
  const { stdout } = await runCliCommand(["--version"]);
  assertStringIncludes(stdout, VERSION);
});

Deno.test("CLI version command outputs version string in log mode", async () => {
  const { stdout } = await runCliCommand(["version"]);
  // In non-TTY environment, version command outputs plain text
  assertStringIncludes(stdout, "swamp");
  assertStringIncludes(stdout, VERSION);
});

Deno.test("CLI version command with --json outputs JSON", async () => {
  const { stdout } = await runCliCommand(["--json", "version"]);
  // Should be valid JSON with version field
  const parsed = JSON.parse(stdout);
  assertStringIncludes(parsed.version, VERSION);
});

// --- Multi-tool repo init/upgrade ---

Deno.test("repo init writes scaffolding for multiple --tool values", async () => {
  await withTempDir(async (dir) => {
    const { code, stdout, stderr } = await runCliCommand(
      ["--json", "repo", "init", "--tool", "claude", "--tool", "kiro"],
      dir,
    );
    assertEquals(code, 0, `init failed: ${stderr}`);

    const result = JSON.parse(stdout);
    assertEquals(result.tools, ["claude", "kiro"]);

    // Both tools' skills dirs should exist
    const claudeStat = await Deno.stat(join(dir, ".claude", "skills"));
    assertEquals(claudeStat.isDirectory, true);
    const kiroStat = await Deno.stat(join(dir, ".kiro", "skills"));
    assertEquals(kiroStat.isDirectory, true);

    // Marker should list both
    const marker = await Deno.readTextFile(join(dir, ".swamp.yaml"));
    assertStringIncludes(marker, "tools:");
    assertStringIncludes(marker, "claude");
    assertStringIncludes(marker, "kiro");
  });
});

Deno.test("repo upgrade with no tool flag preserves marker.tools on a multi-tool repo", async () => {
  await withTempDir(async (dir) => {
    const init = await runCliCommand(
      ["--json", "repo", "init", "--tool", "claude", "--tool", "kiro"],
      dir,
    );
    assertEquals(init.code, 0);

    const { code, stdout } = await runCliCommand(
      ["--json", "repo", "upgrade"],
      dir,
    );
    assertEquals(code, 0);

    const result = JSON.parse(stdout);
    assertEquals(result.tools, ["claude", "kiro"]);
    assertEquals(result.addedTools, []);
    assertEquals(result.removedTools, []);
  });
});

Deno.test("repo upgrade with --tool replaces the tool list and emits the diff", async () => {
  await withTempDir(async (dir) => {
    const init = await runCliCommand(
      ["--json", "repo", "init", "--tool", "claude", "--tool", "kiro"],
      dir,
    );
    assertEquals(init.code, 0);

    const { code, stdout } = await runCliCommand(
      ["--json", "repo", "upgrade", "--tool", "kiro"],
      dir,
    );
    assertEquals(code, 0);

    const result = JSON.parse(stdout);
    assertEquals(result.tools, ["kiro"]);
    assertEquals(result.removedTools, ["claude"]);
    // .claude/ should still exist on disk (no destructive deletes)
    const claudeStat = await Deno.stat(join(dir, ".claude"));
    assertEquals(claudeStat.isDirectory, true);
  });
});

Deno.test("repo upgrade adds a tool and warns about extensions to reinstall", async () => {
  await withTempDir(async (dir) => {
    const init = await runCliCommand(
      ["--json", "repo", "init", "--tool", "claude"],
      dir,
    );
    assertEquals(init.code, 0);

    // Simulate a pulled extension in the primary tool's skills dir
    const pulledDir = join(dir, ".claude", "skills", "swamp-foo");
    await Deno.mkdir(pulledDir, { recursive: true });
    await Deno.writeTextFile(
      join(pulledDir, "SKILL.md"),
      "# pulled extension",
    );

    const { code, stdout } = await runCliCommand(
      [
        "--json",
        "repo",
        "upgrade",
        "--tool",
        "claude",
        "--tool",
        "kiro",
      ],
      dir,
    );
    assertEquals(code, 0);

    const result = JSON.parse(stdout);
    assertEquals(result.addedTools, ["kiro"]);
    assertEquals(result.extensionsToReinstall, [
      { tool: "kiro", names: ["swamp-foo"] },
    ]);
  });
});

Deno.test("legacy single-tool marker upgrades cleanly to the new shape", async () => {
  await withTempDir(async (dir) => {
    // Hand-craft a legacy .swamp.yaml using the old single `tool` field
    const legacy = `swampVersion: "0.0.1"
initializedAt: "2024-01-01T00:00:00.000Z"
tool: claude
`;
    await Deno.mkdir(join(dir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(join(dir, ".swamp.yaml"), legacy);

    const { code, stdout } = await runCliCommand(
      ["--json", "repo", "upgrade"],
      dir,
    );
    assertEquals(code, 0);

    const result = JSON.parse(stdout);
    assertEquals(result.tools, ["claude"]);

    // Rewritten marker has the new shape, no legacy `tool` field
    const rewritten = await Deno.readTextFile(join(dir, ".swamp.yaml"));
    assertStringIncludes(rewritten, "tools:");
    assertStringIncludes(rewritten, "claude");
    assertEquals(rewritten.match(/^tool:/m), null);
  });
});

Deno.test("repo init rejects --tool none combined with another --tool value", async () => {
  await withTempDir(async (dir) => {
    const { code, stderr } = await runCliCommand(
      ["repo", "init", "--tool", "none", "--tool", "claude"],
      dir,
    );
    assertEquals(code !== 0, true);
    assertStringIncludes(stderr, "Cannot combine --tool none");
  });
});

Deno.test("repo init dedupes repeated --tool values", async () => {
  await withTempDir(async (dir) => {
    const { code, stdout } = await runCliCommand(
      [
        "--json",
        "repo",
        "init",
        "--tool",
        "claude",
        "--tool",
        "claude",
        "--tool",
        "kiro",
      ],
      dir,
    );
    assertEquals(code, 0);

    const result = JSON.parse(stdout);
    assertEquals(result.tools, ["claude", "kiro"]);
  });
});

Deno.test("repo init with shared-dir tools (opencode + codex) writes one .agents/ ignore line", async () => {
  await withTempDir(async (dir) => {
    const { code } = await runCliCommand(
      ["--json", "repo", "init", "--tool", "opencode", "--tool", "codex"],
      dir,
    );
    assertEquals(code, 0);

    const gitignore = await Deno.readTextFile(join(dir, ".gitignore"));
    const matches = gitignore.match(/\.agents\/skills\//g) ?? [];
    assertEquals(matches.length, 1);
  });
});

Deno.test("repo upgrade with shared-dir tool transition does not warn about extensions to reinstall", async () => {
  await withTempDir(async (dir) => {
    const init = await runCliCommand(
      ["--json", "repo", "init", "--tool", "opencode"],
      dir,
    );
    assertEquals(init.code, 0);

    // Pulled extension in the shared .agents/skills/ dir
    const pulledDir = join(dir, ".agents", "skills", "swamp-foo");
    await Deno.mkdir(pulledDir, { recursive: true });
    await Deno.writeTextFile(
      join(pulledDir, "SKILL.md"),
      "# pulled extension",
    );

    const { code, stdout } = await runCliCommand(
      [
        "--json",
        "repo",
        "upgrade",
        "--tool",
        "opencode",
        "--tool",
        "codex",
      ],
      dir,
    );
    assertEquals(code, 0);

    const result = JSON.parse(stdout);
    assertEquals(result.addedTools, ["codex"]);
    // Both tools resolve to the same skills dir — no reinstall needed.
    assertEquals(result.extensionsToReinstall, []);
  });
});

Deno.test("repo upgrade walks the OLD primary skills dir even when primary changes", async () => {
  await withTempDir(async (dir) => {
    const init = await runCliCommand(
      ["--json", "repo", "init", "--tool", "claude"],
      dir,
    );
    assertEquals(init.code, 0);

    // Pulled extension lives under .claude/skills/, the OLD primary
    const pulledDir = join(dir, ".claude", "skills", "swamp-foo");
    await Deno.mkdir(pulledDir, { recursive: true });
    await Deno.writeTextFile(
      join(pulledDir, "SKILL.md"),
      "# pulled extension",
    );

    // Replace claude entirely with kiro — primary becomes kiro after the
    // upgrade, but the walk must still hit .claude/skills/.
    const { code, stdout } = await runCliCommand(
      ["--json", "repo", "upgrade", "--tool", "kiro"],
      dir,
    );
    assertEquals(code, 0);

    const result = JSON.parse(stdout);
    assertEquals(result.addedTools, ["kiro"]);
    assertEquals(result.removedTools, ["claude"]);
    assertEquals(result.extensionsToReinstall, [
      { tool: "kiro", names: ["swamp-foo"] },
    ]);
  });
});
