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

/**
 * Runs skill trigger evaluations using promptfoo. This replaces the previous
 * approach that spawned hundreds of `claude -p` subprocesses with lightweight
 * Anthropic API calls via promptfoo's tool-call evaluation.
 *
 * The promptfoo config at evals/promptfoo/promptfooconfig.yaml defines all
 * skill tools and test cases (generated from .claude/skills/<skill>/evals/trigger_evals.json).
 *
 * Usage: deno run eval-skill-triggers [--concurrency <n>] [--threshold <0.0-1.0>]
 *
 * Environment:
 *   ANTHROPIC_API_KEY - Required. Anthropic API key for running evals.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";

interface EvalStats {
  successes: number;
  failures: number;
  tokenUsage: {
    total: number;
    prompt: number;
    completion: number;
    cached: number;
  };
}

interface EvalResult {
  success: boolean;
  cost?: number;
  testCase?: {
    description?: string;
    vars?: Record<string, string>;
  };
  response?: {
    output?: string;
  };
}

interface PromptfooOutput {
  results: {
    stats: EvalStats;
    results: EvalResult[];
  };
}

function findProjectRoot(): string {
  let current = Deno.cwd();
  while (true) {
    try {
      Deno.statSync(join(current, ".claude"));
      return current;
    } catch {
      const parent = join(current, "..");
      if (parent === current) return Deno.cwd();
      current = parent;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["concurrency", "threshold"],
    default: { concurrency: "20", threshold: "0.9" },
  });

  const concurrency = parseInt(args.concurrency);
  const passThreshold = parseFloat(args.threshold);
  const projectRoot = findProjectRoot();
  const configDir = join(projectRoot, "evals", "promptfoo");
  const resultsPath = join(configDir, "results.json");

  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.error(
      "Error: ANTHROPIC_API_KEY environment variable is required.",
    );
    console.error("  export ANTHROPIC_API_KEY=sk-ant-...");
    Deno.exit(1);
  }

  console.log(
    `Running skill trigger evals (concurrency=${concurrency}, threshold=${passThreshold})…`,
  );

  // Run promptfoo eval
  const command = new Deno.Command("npx", {
    args: [
      "-y",
      "promptfoo@latest",
      "eval",
      "-j",
      String(concurrency),
      "--no-cache",
      "-o",
      resultsPath,
    ],
    cwd: configDir,
    stdout: "inherit",
    stderr: "inherit",
  });

  const { code } = await command.output();
  if (code !== 0) {
    console.error("promptfoo eval failed with exit code", code);
    Deno.exit(1);
  }

  // Parse results
  const data: PromptfooOutput = JSON.parse(
    await Deno.readTextFile(resultsPath),
  );
  const { stats } = data.results;
  const total = stats.successes + stats.failures;
  const rate = stats.successes / total;
  const totalCost = data.results.results.reduce(
    (sum, r) => sum + (r.cost ?? 0),
    0,
  );

  console.log(
    `\nResults: ${stats.successes}/${total} passed (${(rate * 100).toFixed(1)}%)`,
  );
  console.log(
    `Tokens: ${stats.tokenUsage.total} (${stats.tokenUsage.prompt} prompt, ${stats.tokenUsage.completion} completion)`,
  );
  console.log(`Estimated cost: $${totalCost.toFixed(2)}`);

  // Report failures
  const failures = data.results.results.filter((r) => !r.success);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) {
      const desc = f.testCase?.description ?? f.testCase?.vars?.query ??
        "unknown";
      const output = (f.response?.output ?? "").slice(0, 100);
      console.log(`  FAIL: ${desc}`);
      console.log(`    → ${output}`);
    }
  }

  // Write GitHub Actions summary
  const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summaryFile) {
    let md = "## Skill Trigger Eval Results\n\n";
    md += "| Metric | Value |\n|---|---|\n";
    md += `| Total tests | ${total} |\n`;
    md += `| Passed | ${stats.successes} |\n`;
    md += `| Failed | ${stats.failures} |\n`;
    md += `| Pass rate | ${(rate * 100).toFixed(1)}% |\n`;
    md += `| Estimated cost | $${totalCost.toFixed(2)} |\n`;
    md += `| Tokens | ${stats.tokenUsage.total.toLocaleString()} |\n\n`;

    if (failures.length > 0) {
      md += "### Failed Tests\n\n";
      md += "| Test | Output |\n|---|---|\n";
      for (const f of failures) {
        const desc = (f.testCase?.description ?? f.testCase?.vars?.query ??
          "unknown").replace(/\|/g, "\\|");
        const output = (f.response?.output ?? "").slice(0, 80).replace(
          /\|/g,
          "\\|",
        ).replace(/\n/g, " ");
        md += `| ${desc} | ${output} |\n`;
      }
    }
    await Deno.writeTextFile(summaryFile, md, { append: true });
  }

  // Check threshold
  if (rate < passThreshold) {
    console.error(
      `\nFAIL: Pass rate ${(rate * 100).toFixed(1)}% is below ${(passThreshold * 100).toFixed(0)}% threshold`,
    );
    Deno.exit(1);
  }

  console.log("\nAll skills passed trigger evals.");
}

main();
