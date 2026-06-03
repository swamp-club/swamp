#!/usr/bin/env -S deno run -A

// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";

interface CompileOptions {
  output: string;
  target?: string;
  version?: string;
}

const VERSION_FILE = "src/cli/commands/version.ts";

async function stampVersion(version: string): Promise<string> {
  const content = await Deno.readTextFile(VERSION_FILE);
  const original = content;
  const updated = content.replace(
    /export const VERSION = "[^"]+";/,
    `export const VERSION = "${version}";`,
  );
  await Deno.writeTextFile(VERSION_FILE, updated);
  return original;
}

async function getGitSha(): Promise<string> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      stdout: "piped",
      stderr: "null",
    });
    const { success, stdout } = await cmd.output();
    if (!success) return "";
    return new TextDecoder().decode(stdout).trim();
  } catch {
    return "";
  }
}

async function stampGitSha(): Promise<string> {
  const sha = await getGitSha();
  if (!sha) return "";
  const content = await Deno.readTextFile(VERSION_FILE);
  const updated = content.replace(
    /export const GIT_SHA = "[^"]*";/,
    `export const GIT_SHA = "${sha}";`,
  );
  await Deno.writeTextFile(VERSION_FILE, updated);
  return sha;
}

/**
 * Downloads the deno binary for the given target platform.
 * Runs scripts/download_deno.ts to fetch from GitHub releases.
 */
async function downloadDeno(target?: string): Promise<void> {
  const downloadArgs = ["run", "-A", "scripts/download_deno.ts"];
  if (target) {
    downloadArgs.push("--target", target);
  }

  console.log(`Downloading embedded deno runtime...`);
  const command = new Deno.Command("deno", {
    args: downloadArgs,
    stdout: "inherit",
    stderr: "inherit",
  });

  const { success } = await command.output();
  if (!success) {
    throw new Error("Failed to download deno binary for embedding");
  }
}

/**
 * Cleans up the resources/deno/ directory after compilation.
 * Removes platform-specific binary to avoid leaving it in the repo.
 */
async function cleanupDenoResources(): Promise<void> {
  const denoDir = join(
    import.meta.dirname ?? ".",
    "..",
    "resources",
    "deno",
  );
  try {
    await Deno.remove(denoDir, { recursive: true });
    console.log("Cleaned up resources/deno/");
  } catch {
    // Directory may not exist — that's fine
  }
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["output", "target", "version"],
    alias: {
      "o": "output",
      "t": "target",
      "v": "version",
    },
    default: {
      "output": "swamp",
    },
  });

  const options: CompileOptions = {
    output: args.output || "swamp",
    target: args.target,
    version: args.version,
  };

  // Only stamp version when explicitly provided (CI passes --version).
  // Local dev builds keep the source-default VERSION (with empty sha).
  // Save original version file content so we can restore after compile
  const preStampContent = await Deno.readTextFile(VERSION_FILE);

  // Always stamp the git sha (even dev builds)
  const sha = await stampGitSha();
  if (sha) {
    console.log(`Git SHA: ${sha}`);
  }

  let originalContent: string | null = preStampContent;
  if (options.version) {
    console.log(`Version: ${options.version}`);
    await stampVersion(options.version);
  } else {
    console.log(
      "No --version provided; using source-default version (dev build)",
    );
  }

  try {
    // Download deno binary for embedding
    await downloadDeno(options.target);

    const baseCommand = [
      "deno",
      "compile",
      "--unstable-bundle",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "--allow-net",
      "--include",
      ".claude/skills",
      "--include",
      "resources/deno",
      // Exclude development-only directories from the binary
      "--exclude",
      "agent-constraints",
      "--exclude",
      ".agents",
      "--exclude",
      ".claude/skills/ddd",
      "--exclude",
      ".claude/skills/github-pr",
      "--exclude",
      ".claude/skills/jujutsu",
      "--exclude",
      ".claude/skills/skill-creator",
      "--exclude",
      ".github",
      "--exclude",
      ".vault-test-vault",
      "--exclude",
      "design",
      "--exclude",
      "evals",
      "--exclude",
      "integration",
      "--exclude",
      "scripts",
      "--exclude",
      "workflows",
    ];

    if (options.target) {
      baseCommand.push("--target", options.target);
    }

    baseCommand.push("--output", options.output, "main.ts");

    console.log(`Running: ${baseCommand.join(" ")}`);

    const command = new Deno.Command(baseCommand[0], {
      args: baseCommand.slice(1),
      stdout: "inherit",
      stderr: "inherit",
    });

    const { success } = await command.output();

    if (!success) {
      Deno.exit(1);
    }
  } finally {
    // Restore original version file if we stamped it
    if (originalContent !== null) {
      await Deno.writeTextFile(VERSION_FILE, originalContent);
    }

    // Clean up downloaded deno binary
    await cleanupDenoResources();
  }
}

if (import.meta.main) {
  await main();
}
