#!/usr/bin/env -S deno run -A

import { parseArgs } from "@std/cli/parse-args";
import { exists } from "@std/fs/exists";

interface CompileOptions {
  includeExperiment: string[];
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["include-experiment"],
    collect: ["include-experiment"],
    alias: {
      "include-experiment": "includeExperiment",
    },
  });

  const options: CompileOptions = {
    includeExperiment: args.includeExperiment || [],
  };

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

  baseCommand.push("--output", "swamp", "main.ts");

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
}

if (import.meta.main) {
  await main();
}
