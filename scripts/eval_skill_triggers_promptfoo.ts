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
 * Runs skill trigger evaluations using promptfoo. This replaces the previous
 * approach that spawned hundreds of `claude -p` subprocesses with lightweight
 * API calls via promptfoo's tool-call evaluation.
 *
 * The promptfoo config is regenerated at eval time from
 * .claude/skills/<skill>/evals/trigger_evals.json using evals/promptfoo/generate_config.ts.
 *
 * Usage: deno run eval-skill-triggers [--model <alias>] [--concurrency <n>] [--threshold <0.0-1.0>]
 *
 * Supported models: sonnet (default), opus, gpt-5.4, gemini-2.5-pro
 *
 * Environment:
 *   ANTHROPIC_API_KEY - Required for sonnet/opus models.
 *   OPENAI_API_KEY    - Required for gpt-5.4 model.
 *   GOOGLE_API_KEY    - Required for gemini-2.5-pro model.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";

const API_KEY_ENV: Record<string, string> = {
  "sonnet": "ANTHROPIC_API_KEY",
  "opus": "ANTHROPIC_API_KEY",
  "gpt-5.4": "OPENAI_API_KEY",
  "gemini-2.5-pro": "GOOGLE_API_KEY",
};

// Maps model aliases to the API model ID used for preflight checks.
const PREFLIGHT_MODEL_ID: Record<string, string> = {
  "sonnet": "claude-sonnet-4-5",
  "opus": "claude-opus-4-6",
  "gpt-5.4": "gpt-5.4",
  "gemini-2.5-pro": "gemini-2.5-pro",
};

interface PreflightConfig {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function buildPreflightRequest(
  model: string,
  apiKey: string,
): PreflightConfig {
  const modelId = PREFLIGHT_MODEL_ID[model];
  if (model === "sonnet" || model === "opus") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    };
  } else if (model === "gpt-5.4") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_completion_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    };
  } else {
    return {
      url:
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    };
  }
}

async function preflightCheck(model: string): Promise<void> {
  const apiKey = Deno.env.get(API_KEY_ENV[model])!;
  const config = buildPreflightRequest(model, apiKey);

  console.log(`Preflight: verifying ${model} API access…`);
  const signal = AbortSignal.timeout(15_000);
  const resp = await fetch(config.url, {
    method: "POST",
    headers: config.headers,
    body: config.body,
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(
      `Preflight failed for ${model} (HTTP ${resp.status}): ${body.slice(0, 300)}`,
    );
    if (resp.status === 429) {
      console.error(
        "Hint: a 429 before any eval calls usually means insufficient credits or a billing issue, not a rate limit.",
      );
    }
    Deno.exit(1);
  }

  // Drain the response body
  await resp.text();
  console.log(`Preflight: ${model} API access verified.`);
}

// Per-million-token pricing for cost estimation
const TOKEN_PRICING: Record<string, { prompt: number; completion: number }> = {
  "sonnet": { prompt: 3.0, completion: 15.0 },
  "opus": { prompt: 15.0, completion: 75.0 },
  "gpt-5.4": { prompt: 2.0, completion: 8.0 },
  "gemini-2.5-pro": { prompt: 1.25, completion: 10.0 },
};

const VALID_MODELS = Object.keys(API_KEY_ENV);

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

async function regenerateConfig(
  projectRoot: string,
  model: string,
): Promise<void> {
  const generatorPath = join(
    projectRoot,
    "evals",
    "promptfoo",
    "generate_config.ts",
  );
  const promptfooConfigPath = join(
    projectRoot,
    "evals",
    "promptfoo",
    "promptfooconfig.yaml",
  );

  // Explicitly point at the root deno.json so Deno doesn't auto-discover
  // evals/promptfoo/package.json (which is not a workspace member).
  const denoConfigPath = join(projectRoot, "deno.json");
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "--config",
      denoConfigPath,
      "--allow-read",
      generatorPath,
      "--model",
      model,
    ],
    cwd: projectRoot,
    stdout: "piped",
    stderr: "inherit",
  });

  const { code, stdout } = await command.output();
  if (code !== 0) {
    console.error(`Failed to regenerate promptfoo config for model ${model}`);
    Deno.exit(1);
  }

  await Deno.writeFile(promptfooConfigPath, stdout);
  console.log(`Regenerated promptfoo config for model: ${model}`);
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["model", "concurrency", "threshold"],
    default: { model: "sonnet", concurrency: "20", threshold: "0.9" },
  });

  const model = args.model;
  if (!VALID_MODELS.includes(model)) {
    console.error(
      `Error: unknown model "${model}". Valid models: ${VALID_MODELS.join(", ")}`,
    );
    Deno.exit(1);
  }

  const concurrency = parseInt(args.concurrency);
  const passThreshold = parseFloat(args.threshold);
  const projectRoot = findProjectRoot();
  const configDir = join(projectRoot, "evals", "promptfoo");
  const resultsPath = join(configDir, "results.json");

  // Check for required API key — gracefully skip if missing
  const requiredKeyEnv = API_KEY_ENV[model];
  if (!Deno.env.get(requiredKeyEnv)) {
    const message =
      `Skipping ${model} eval: ${requiredKeyEnv} environment variable is not set.`;
    console.warn(message);

    // Write skip status to GitHub Actions summary
    const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
    if (summaryFile) {
      let md = `## Skill Trigger Eval Results (${model})\n\n`;
      md += `**Skipped** — \`${requiredKeyEnv}\` not configured.\n`;
      await Deno.writeTextFile(summaryFile, md, { append: true });
    }

    // Exit 0 — missing key is not a failure
    return;
  }

  // Preflight: make a single API call to verify the key works before
  // launching 202 eval calls. Catches billing/credit issues immediately
  // instead of retrying for hours.
  await preflightCheck(model);

  // Regenerate config for the selected model
  await regenerateConfig(projectRoot, model);

  console.log(
    `Running skill trigger evals for ${model} (concurrency=${concurrency}, threshold=${passThreshold})…`,
  );

  // Install promptfoo dependencies from lockfile. We use `npm install` rather
  // than `npm ci` because the lockfile is generated on one platform (e.g. macOS)
  // and CI runs on another (Linux). `npm ci` fails when platform-specific
  // optional deps (like @img/sharp-linux-*) are missing from the lockfile.
  // `npm install` respects the lockfile for version resolution while allowing
  // native addons (like better-sqlite3) to compile for the current platform.
  console.log("Installing promptfoo dependencies…");
  const installCmd = new Deno.Command("npm", {
    args: ["install", "--package-lock=false"],
    cwd: configDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const installResult = await installCmd.output();
  if (installResult.code !== 0) {
    console.error("npm install failed with exit code", installResult.code);
    Deno.exit(1);
  }

  // Run promptfoo eval
  const command = new Deno.Command("npx", {
    args: [
      "promptfoo",
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
  // promptfoo exits with code 100 when any assertions fail, which is expected.
  // We handle pass/fail via our own threshold check below. Only treat other
  // non-zero codes as hard failures (e.g., missing API key, config errors).
  if (code !== 0 && code !== 100) {
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
  // Calculate cost from aggregate token usage and model pricing.
  // promptfoo does not populate per-result cost for Anthropic providers,
  // so we compute it from the token counts directly.
  const pricing = TOKEN_PRICING[model];
  const totalCost = pricing
    ? (stats.tokenUsage.prompt / 1_000_000) * pricing.prompt +
      (stats.tokenUsage.completion / 1_000_000) * pricing.completion
    : 0;

  console.log(
    `\nResults (${model}): ${stats.successes}/${total} passed (${(rate * 100).toFixed(1)}%)`,
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
      const rawOutput = f.response?.output ?? "";
      const output = (typeof rawOutput === "string"
        ? rawOutput
        : JSON.stringify(rawOutput)).slice(0, 100);
      console.log(`  FAIL: ${desc}`);
      console.log(`    → ${output}`);
    }
  }

  // Write GitHub Actions summary
  const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summaryFile) {
    let md = `## Skill Trigger Eval Results (${model})\n\n`;
    md += "| Metric | Value |\n|---|---|\n";
    md += `| Model | ${model} |\n`;
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
        const rawOut = f.response?.output ?? "";
        const output = (typeof rawOut === "string"
          ? rawOut
          : JSON.stringify(rawOut)).slice(0, 80).replace(
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
      `\nFAIL (${model}): Pass rate ${(rate * 100).toFixed(1)}% is below ${(passThreshold * 100).toFixed(0)}% threshold`,
    );
    Deno.exit(1);
  }

  console.log(`\nAll skills passed trigger evals for ${model}.`);
}

await main();
