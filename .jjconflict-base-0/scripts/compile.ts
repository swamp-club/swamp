#!/usr/bin/env -S deno run -A

import { parseArgs } from "@std/cli/parse-args";
import { exists } from "@std/fs/exists";

interface CompileOptions {
  includeExperiment: string[];
  output: string;
  target?: string;
  version?: string;
}

const VERSION_FILE = "src/cli/commands/version.ts";

async function getCalVer(): Promise<string> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");

  // Get short commit hash
  let commitHash = "0000000";
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short=8", "HEAD"],
      stdout: "piped",
    });
    const { stdout } = await cmd.output();
    commitHash = new TextDecoder().decode(stdout).trim();
  } catch {
    // Ignore git errors
  }

  // Format: YYYYMMDD.HHMMSS.0-sha.COMMITSHA (matches SI convention)
  return `${year}${month}${day}.${hours}${minutes}${seconds}.0-sha.${commitHash}`;
}

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

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["include-experiment", "output", "target", "version"],
    collect: ["include-experiment"],
    alias: {
      "include-experiment": "includeExperiment",
      "o": "output",
      "t": "target",
      "v": "version",
    },
    default: {
      "output": "swamp",
    },
  });

  const options: CompileOptions = {
    includeExperiment: args.includeExperiment || [],
    output: args.output || "swamp",
    target: args.target,
    version: args.version,
  };

  // Determine version to use
  const version = options.version || await getCalVer();
  console.log(`Version: ${version}`);

  // Stamp version into source file
  const originalContent = await stampVersion(version);

  try {
    const baseCommand = [
      "deno",
      "compile",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      "--allow-net",
      "--include",
      ".claude/skills",
    ];

    for (const experiment of options.includeExperiment) {
      if (experiment === "web") {
        const webDistPath = "experiments/webapp/frontend/dist";
        if (await exists(webDistPath)) {
          console.log(`Including web experiment from ${webDistPath}`);
          baseCommand.push("--include", webDistPath);
        } else {
          console.error(
            `Error: Web experiment not built. Run 'deno run webapp:build' first.`,
          );
          Deno.exit(1);
        }
      } else {
        console.error(`Error: Unknown experiment '${experiment}'`);
        Deno.exit(1);
      }
    }

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
    // Restore original version file
    await Deno.writeTextFile(VERSION_FILE, originalContent);
  }
}

if (import.meta.main) {
  await main();
}
