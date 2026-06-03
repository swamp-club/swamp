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

/**
 * Analyzes eval results from all models and produces a cross-model comparison.
 * Reads results.json files uploaded as artifacts by each eval job.
 *
 * Usage: deno run --allow-read --allow-env=GITHUB_STEP_SUMMARY --allow-write scripts/analyze_eval_results.ts <artifacts-dir>
 */

import { join } from "@std/path";

interface EvalResult {
  success: boolean;
  testCase?: {
    description?: string;
    vars?: Record<string, string>;
  };
  response?: {
    output?: unknown;
  };
}

interface EvalStats {
  successes: number;
  failures: number;
  errors: number;
  tokenUsage: {
    total: number;
    prompt: number;
    completion: number;
  };
  durationMs: number;
}

interface PromptfooOutput {
  results: {
    stats: EvalStats;
    results: EvalResult[];
  };
}

interface ModelSummary {
  model: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  tokens: number;
  durationMs: number;
  failures: string[];
}

function extractToolCallName(output: unknown): string | undefined {
  if (!output) return undefined;

  if (Array.isArray(output)) {
    for (const item of output) {
      // OpenAI format
      if (item?.function?.name) return item.function.name;
      // Google format
      if (item?.functionCall?.name) return item.functionCall.name;
      // Generic format
      if (item?.name) return item.name;
    }
  }

  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    if (obj.function && typeof obj.function === "object") {
      return (obj.function as Record<string, unknown>).name as string;
    }
    if (obj.functionCall && typeof obj.functionCall === "object") {
      return (obj.functionCall as Record<string, unknown>).name as string;
    }
  }

  return undefined;
}

async function loadResults(artifactsDir: string): Promise<ModelSummary[]> {
  const summaries: ModelSummary[] = [];

  for await (const entry of Deno.readDir(artifactsDir)) {
    if (!entry.isDirectory || !entry.name.startsWith("eval-results-")) {
      continue;
    }

    const model = entry.name.replace("eval-results-", "");
    const resultsPath = join(artifactsDir, entry.name, "results.json");

    let data: PromptfooOutput;
    try {
      data = JSON.parse(await Deno.readTextFile(resultsPath));
    } catch {
      console.warn(`Skipping ${model}: no results.json found`);
      continue;
    }

    const { stats, results } = data.results;
    const total = stats.successes + stats.failures;
    const failures = results
      .filter((r) => !r.success)
      .map((r) => {
        const desc = r.testCase?.description ?? "unknown";
        const calledTool = extractToolCallName(r.response?.output);
        const outputStr = typeof r.response?.output === "string"
          ? r.response.output.slice(0, 80)
          : calledTool
          ? `routed to ${calledTool}`
          : "text response (no tool call)";
        return `${desc} → ${outputStr}`;
      });

    summaries.push({
      model,
      total,
      passed: stats.successes,
      failed: stats.failures,
      errors: stats.errors,
      passRate: total > 0 ? stats.successes / total : 0,
      tokens: stats.tokenUsage.total,
      durationMs: stats.durationMs,
      failures,
    });
  }

  // Sort by pass rate descending
  summaries.sort((a, b) => b.passRate - a.passRate);
  return summaries;
}

function findCrossModelFailures(
  summaries: ModelSummary[],
): Map<string, string[]> {
  // Map test description -> list of models that failed it
  const failureMap = new Map<string, string[]>();

  for (const summary of summaries) {
    for (const failure of summary.failures) {
      // Extract just the test description (before →)
      const desc = failure.split(" → ")[0].trim();
      if (!failureMap.has(desc)) {
        failureMap.set(desc, []);
      }
      failureMap.get(desc)!.push(summary.model);
    }
  }

  return failureMap;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;
}

async function main(): Promise<void> {
  const artifactsDir = Deno.args[0];
  if (!artifactsDir) {
    console.error("Usage: analyze_eval_results.ts <artifacts-dir>");
    Deno.exit(1);
  }

  const summaries = await loadResults(artifactsDir);

  if (summaries.length === 0) {
    console.log("No eval results found.");
    return;
  }

  // Console output
  console.log("\n=== Cross-Model Skill Trigger Eval Analysis ===\n");

  console.log("Model Results:");
  for (const s of summaries) {
    const status = s.passRate >= 0.9 ? "PASS" : "FAIL";
    console.log(
      `  ${status} ${s.model}: ${s.passed}/${s.total} (${(s.passRate * 100).toFixed(1)}%) — ${s.tokens.toLocaleString()} tokens, ${formatDuration(s.durationMs)}`,
    );
  }

  // Cross-model failures
  const crossModelFailures = findCrossModelFailures(summaries);
  const multiModelFailures = [...crossModelFailures.entries()]
    .filter(([_, models]) => models.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  if (multiModelFailures.length > 0) {
    console.log("\nCross-Model Failures (same test fails on multiple models):");
    for (const [desc, models] of multiModelFailures) {
      console.log(`  [${models.length}/${summaries.length}] ${desc}`);
      console.log(`         Models: ${models.join(", ")}`);
    }
  }

  // Per-model unique failures
  const singleModelFailures = [...crossModelFailures.entries()]
    .filter(([_, models]) => models.length === 1);

  if (singleModelFailures.length > 0) {
    console.log("\nModel-Specific Failures (only one model fails):");
    for (const [desc, models] of singleModelFailures) {
      console.log(`  [${models[0]}] ${desc}`);
    }
  }

  // Detailed failure list per model
  for (const s of summaries) {
    if (s.failures.length > 0) {
      console.log(`\n${s.model} failures (${s.failures.length}):`);
      for (const f of s.failures) {
        console.log(`  ${f}`);
      }
    }
  }

  // Overall verdict
  const allPassed = summaries.every((s) => s.passRate >= 0.9);
  console.log(
    `\nVerdict: ${allPassed ? "ALL MODELS PASS" : "ACTION REQUIRED — some models below 90% threshold"}`,
  );

  // GitHub Actions summary
  const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summaryFile) {
    let md = "## Cross-Model Skill Trigger Eval Analysis\n\n";

    // Summary table
    md += "### Results\n\n";
    md += "| Model | Pass Rate | Passed | Failed | Tokens | Duration | Status |\n";
    md += "|-------|-----------|--------|--------|--------|----------|--------|\n";
    for (const s of summaries) {
      const status = s.passRate >= 0.9 ? "✅ Pass" : "❌ Fail";
      md +=
        `| ${s.model} | ${(s.passRate * 100).toFixed(1)}% | ${s.passed} | ${s.failed} | ${s.tokens.toLocaleString()} | ${formatDuration(s.durationMs)} | ${status} |\n`;
    }

    // Cross-model failures
    if (multiModelFailures.length > 0) {
      md += "\n### Cross-Model Failures\n\n";
      md +=
        "These tests fail on multiple models, suggesting skill description issues:\n\n";
      md += "| Test | Models Failing | Count |\n";
      md += "|------|---------------|-------|\n";
      for (const [desc, models] of multiModelFailures) {
        const escapedDesc = desc.replace(/\|/g, "\\|");
        md +=
          `| ${escapedDesc} | ${models.join(", ")} | ${models.length}/${summaries.length} |\n`;
      }
    }

    // Model-specific failures
    if (singleModelFailures.length > 0) {
      md += "\n### Model-Specific Failures\n\n";
      md +=
        "These tests fail on only one model, suggesting model-specific quirks:\n\n";
      md += "| Test | Model |\n";
      md += "|------|-------|\n";
      for (const [desc, models] of singleModelFailures) {
        const escapedDesc = desc.replace(/\|/g, "\\|");
        md += `| ${escapedDesc} | ${models[0]} |\n`;
      }
    }

    // Verdict
    md += "\n### Verdict\n\n";
    if (allPassed) {
      md += "✅ **All models pass** the 90% threshold.\n";
    } else {
      const failing = summaries.filter((s) => s.passRate < 0.9);
      md += "❌ **Action required** — the following models are below the 90% threshold:\n\n";
      for (const s of failing) {
        md += `- **${s.model}**: ${(s.passRate * 100).toFixed(1)}%\n`;
      }
    }

    await Deno.writeTextFile(summaryFile, md, { append: true });
  }
}

await main();
