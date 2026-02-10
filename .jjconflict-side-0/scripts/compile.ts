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

  // Only stamp version when explicitly provided (CI passes --version).
  // Local dev builds keep the source-default VERSION (with empty sha).
  let originalContent: string | null = null;
  if (options.version) {
    console.log(`Version: ${options.version}`);
    originalContent = await stampVersion(options.version);
  } else {
    console.log(
      "No --version provided; using source-default version (dev build)",
    );
  }

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
      // Exclude development-only directories from the binary
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
      "integration",
      "--exclude",
      "scripts",
      "--exclude",
      "workflows",
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
    // Restore original version file if we stamped it
    if (originalContent !== null) {
      await Deno.writeTextFile(VERSION_FILE, originalContent);
    }
  }
}

if (import.meta.main) {
  await main();
}
