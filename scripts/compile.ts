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

export const VERSION_FILE = "src/infrastructure/runtime/build_info.ts";

const VERSION_PATTERN = /export const VERSION = "[^"]+";/;
const GIT_SHA_PATTERN = /export const GIT_SHA = "[^"]*";/;

function replaceConstant(
  content: string,
  name: string,
  pattern: RegExp,
  value: string,
): string {
  if (!pattern.test(content)) {
    throw new Error(`${VERSION_FILE} has no ${name} constant to stamp`);
  }
  return content.replace(pattern, `export const ${name} = "${value}";`);
}

// pure so a failed match throws before anything is written
export function stampBuildInfo(
  content: string,
  stamp: { version?: string; sha?: string },
): string {
  let stamped = content;
  if (stamp.sha) {
    stamped = replaceConstant(stamped, "GIT_SHA", GIT_SHA_PATTERN, stamp.sha);
  }
  if (stamp.version) {
    stamped = replaceConstant(
      stamped,
      "VERSION",
      VERSION_PATTERN,
      stamp.version,
    );
  }
  return stamped;
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

export interface StampedBuildSteps {
  stamp: () => Promise<void>;
  build: () => Promise<boolean>;
  restore: () => Promise<void>;
}

export async function runStampedBuild(
  steps: StampedBuildSteps,
): Promise<boolean> {
  try {
    await steps.stamp();
    return await steps.build();
  } finally {
    await steps.restore();
  }
}

// undefined content means nothing was stamped, so the file is left alone
export async function restoreBuildState(
  versionFile: string,
  originalContent: string | undefined,
  denoResourcesDir: string,
): Promise<void> {
  try {
    if (originalContent !== undefined) {
      await Deno.writeTextFile(versionFile, originalContent);
    }
  } finally {
    try {
      await Deno.remove(denoResourcesDir, { recursive: true });
      console.log("Cleaned up resources/deno/");
    } catch {
      // Directory may not exist — that's fine
    }
  }
}

async function main(): Promise<boolean> {
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

  // stamp the version only when given (CI passes --version); dev builds keep
  // the source default, so the original is saved to restore after compile
  const originalContent = await Deno.readTextFile(VERSION_FILE);
  const sha = await getGitSha();
  const stamped = stampBuildInfo(originalContent, {
    version: options.version,
    sha,
  });
  if (sha) {
    console.log(`Git SHA: ${sha}`);
  }
  if (options.version) {
    console.log(`Version: ${options.version}`);
  } else {
    console.log(
      "No --version provided; using source-default version (dev build)",
    );
  }
  const wroteStamp = stamped !== originalContent;

  return await runStampedBuild({
    stamp: async () => {
      if (wroteStamp) {
        await Deno.writeTextFile(VERSION_FILE, stamped);
      }
    },
    build: () => compile(options),
    restore: () =>
      restoreBuildState(
        VERSION_FILE,
        wroteStamp ? originalContent : undefined,
        join(import.meta.dirname ?? ".", "..", "resources", "deno"),
      ),
  });
}

async function compile(options: CompileOptions): Promise<boolean> {
  await downloadDeno(options.target);

  // individual flags, not --allow-all, to avoid auto-granting future
  // permission categories; Deno.open on device nodes then fails, so
  // extensions use Deno.Command for hardware I/O
  const dashboardDistExists = await Deno.stat("packages/dashboard/dist")
    .then(() => true).catch(() => false);
  const baseCommand = [
    "deno",
    "compile",
    "--unstable-bundle",
    // Deno marks listening with SO_REUSEPORT unstable; serve --reuse-port needs it
    "--unstable-net",
    // the dashboard's build packages stay in the workspace but never ship
    "--exclude-unused-npm",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    "--allow-sys",
    "--allow-net",
    // ffi is for libc/libproc calls: raising the fd limit, the auth gate's
    // ancestry check, and /proc and sysctl reads for writer liveness.
    "--allow-ffi",
    "--include",
    ".claude/skills",
    "--include",
    "resources/deno",
    // included only when pre-built; CI builds it before compile
    ...(dashboardDistExists ? ["--include", "packages/dashboard/dist"] : []),
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
    ".claude/skills/issue-lifecycle",
    "--exclude",
    ".claude/skills/skill-creator",
    "--exclude",
    ".claude/skills/terminal-output",
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
    "verification",
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
  return success;
}

if (import.meta.main) {
  if (!(await main())) {
    Deno.exit(1);
  }
}
