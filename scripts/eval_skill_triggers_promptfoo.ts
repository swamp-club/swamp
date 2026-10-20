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
 * Runs skill evaluations using promptfoo. Three phases:
 *   1. Trigger evals — does the swamp skill activate for the right queries?
 *   2. Routing evals — once activated, does it route to the correct guide?
 *   3. Sufficiency evals — is guide.md alone sufficient for common queries?
 *
 * Usage: deno run eval-skill-triggers [--model <alias>] [--route cli|api] [--concurrency <n>] [--threshold <0.0-1.0>]
 *
 * Supported models: opus (default), sonnet, fable, gpt-5.4, gemini-2.5-pro,
 * gemini-3.1-pro
 *
 * Routes: `cli` runs sonnet/opus through `claude -p`, so a claude.ai login is
 * enough and no API key is read. `api` calls the provider APIs directly. The
 * default is `api` in GitHub Actions and for every model without a CLI route,
 * and `cli` otherwise.
 *
 * Environment (api route only):
 *   ANTHROPIC_API_KEY - Required for sonnet/opus/fable models.
 *   OPENAI_API_KEY    - Required for gpt-5.4 model.
 *   GOOGLE_API_KEY    - Required for gemini models.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { installPromptfooDeps } from "./promptfoo_install.ts";
import {
  assertRouteSupports,
  defaultRoute,
  ROUTES,
  type Route,
} from "../evals/promptfoo/provider_route.ts";

const API_KEY_ENV: Record<string, string> = {
  "sonnet": "ANTHROPIC_API_KEY",
  "opus": "ANTHROPIC_API_KEY",
  "fable": "ANTHROPIC_API_KEY",
  "gpt-5.4": "OPENAI_API_KEY",
  "gemini-2.5-pro": "GOOGLE_API_KEY",
  "gemini-3.1-pro": "GOOGLE_API_KEY",
};

// Maps model aliases to the API model ID used for preflight checks.
const PREFLIGHT_MODEL_ID: Record<string, string> = {
  "sonnet": "claude-sonnet-4-5",
  "opus": "claude-opus-5-5",
  "fable": "claude-fable-5",
  "gpt-5.4": "gpt-5.4",
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
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
  if (model === "sonnet" || model === "opus" || model === "fable") {
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

/** Pings `claude -p` so a missing CLI or an expired login fails before the evals. */
async function cliPreflightCheck(model: string): Promise<void> {
  console.log(`Preflight: verifying ${model} through claude -p…`);
  const env = Deno.env.toObject();
  delete env.ANTHROPIC_API_KEY;
  let result: Deno.CommandOutput;
  try {
    result = await new Deno.Command("claude", {
      args: [
        "-p",
        "hi",
        "--model",
        model,
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--output-format",
        "json",
      ],
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
  } catch (error) {
    console.error(
      `Preflight failed for ${model}: could not run the claude CLI (${
        error instanceof Error ? error.message : error
      }). Install Claude Code and run \`claude\` once to log in.`,
    );
    Deno.exit(1);
  }
  const stdout = new TextDecoder().decode(result.stdout);
  let isError = result.code !== 0;
  try {
    isError = isError || JSON.parse(stdout).is_error === true;
  } catch {
    isError = true;
  }
  if (isError) {
    console.error(
      `Preflight failed for ${model} (exit ${result.code}): ${
        (stdout || new TextDecoder().decode(result.stderr)).slice(0, 300)
      }`,
    );
    Deno.exit(1);
  }
  console.log(`Preflight: ${model} reachable through claude -p.`);
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
  "opus": { prompt: 4.0, completion: 20.0 },
  "fable": { prompt: 10.0, completion: 50.0 },
  "gpt-5.4": { prompt: 2.0, completion: 8.0 },
  "gemini-2.5-pro": { prompt: 1.25, completion: 10.0 },
  "gemini-3.1-pro": { prompt: 1.25, completion: 10.0 },
};

const VALID_MODELS = Object.keys(API_KEY_ENV);

interface EvalStats {
  successes: number;
  failures: number;
  /** Cases whose provider call errored; promptfoo does not count them as failures. */
  errors?: number;
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
    metadata?: { resolvedModel?: string };
  };
  error?: string;
}

interface PromptfooOutput {
  results: {
    stats: EvalStats;
    results: EvalResult[];
  };
}

interface PhaseResult {
  name: string;
  total: number;
  passed: number;
  failed: number;
  rate: number;
  cost: number;
  tokens: EvalStats["tokenUsage"];
  failures: EvalResult[];
  /** Exact models the CLI route resolved its alias to. */
  resolvedModels: string[];
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
  generatorFile: string,
  model: string,
  route: Route,
): Promise<void> {
  const generatorPath = join(
    projectRoot,
    "evals",
    "promptfoo",
    generatorFile,
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
      "--allow-env=GITHUB_ACTIONS",
      generatorPath,
      "--model",
      model,
      "--route",
      route,
    ],
    cwd: projectRoot,
    stdout: "piped",
    stderr: "inherit",
  });

  const { code, stdout } = await command.output();
  if (code !== 0) {
    console.error(
      `Failed to regenerate config from ${generatorFile} for model ${model}`,
    );
    Deno.exit(1);
  }

  await Deno.writeFile(promptfooConfigPath, stdout);
}

async function runPromptfooEval(
  configDir: string,
  resultsPath: string,
  concurrency: number,
): Promise<PromptfooOutput> {
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

  return JSON.parse(await Deno.readTextFile(resultsPath));
}

function summarizePhase(
  name: string,
  data: PromptfooOutput,
  model: string,
  route: Route,
): PhaseResult {
  const { stats } = data.results;
  // An errored provider call (no valid answer from the CLI, say) is a failed
  // case. promptfoo reports it apart from `failures`, so fold it in here or
  // the pass rate would be computed over fewer cases than ran.
  const errors = stats.errors ?? 0;
  const failed = stats.failures + errors;
  const total = stats.successes + failed;
  const rate = stats.successes / total;
  const pricing = TOKEN_PRICING[model];
  // Subscription runs have no per-token price, so report no dollar figure.
  const cost = pricing && route === "api"
    ? (stats.tokenUsage.prompt / 1_000_000) * pricing.prompt +
      (stats.tokenUsage.completion / 1_000_000) * pricing.completion
    : 0;

  const failures = data.results.results.filter((r) => !r.success);
  const resolvedModels = [
    ...new Set(
      data.results.results.flatMap((r) =>
        r.response?.metadata?.resolvedModel
          ? [r.response.metadata.resolvedModel]
          : []
      ),
    ),
  ];

  console.log(
    `\n${name} (${model}): ${stats.successes}/${total} passed (${(rate * 100).toFixed(1)}%)`,
  );
  console.log(
    `Tokens: ${stats.tokenUsage.total} (${stats.tokenUsage.prompt} prompt, ${stats.tokenUsage.completion} completion)`,
  );
  if (route === "api") console.log(`Estimated cost: $${cost.toFixed(2)}`);
  if (resolvedModels.length > 0) {
    console.log(`Resolved model: ${resolvedModels.join(", ")}`);
  }

  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) {
      const desc = f.testCase?.description ?? f.testCase?.vars?.query ??
        "unknown";
      const rawOutput = f.response?.output ?? f.error ?? "";
      const output = (typeof rawOutput === "string"
        ? rawOutput
        : JSON.stringify(rawOutput)).slice(0, 100);
      console.log(`  FAIL: ${desc}`);
      console.log(`    → ${output}`);
    }
  }

  return {
    name,
    total,
    passed: stats.successes,
    failed,
    rate,
    cost,
    tokens: stats.tokenUsage,
    failures,
    resolvedModels,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["model", "route", "concurrency", "threshold"],
    default: { model: "opus", threshold: "0.9" },
  });

  const model = args.model;
  if (!VALID_MODELS.includes(model)) {
    console.error(
      `Error: unknown model "${model}". Valid models: ${VALID_MODELS.join(", ")}`,
    );
    Deno.exit(1);
  }

  const route = (args.route ?? defaultRoute(model, {
    GITHUB_ACTIONS: Deno.env.get("GITHUB_ACTIONS"),
  })) as Route;
  if (!ROUTES.includes(route)) {
    console.error(
      `Error: unknown route "${route}". Valid routes: ${ROUTES.join(", ")}`,
    );
    Deno.exit(1);
  }
  try {
    assertRouteSupports(model, route);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    Deno.exit(1);
  }

  // Every case is a `claude -p` process on the subscription login, which
  // rate-limits well below what the API tolerates.
  const concurrency = parseInt(args.concurrency ?? (route === "cli" ? "6" : "20"));
  const passThreshold = parseFloat(args.threshold);
  const projectRoot = findProjectRoot();
  const configDir = join(projectRoot, "evals", "promptfoo");

  // The API route needs the provider's key and skips without it. The CLI
  // route never reads a key: a missing CLI or login fails the preflight below
  // instead of skipping, so a green run always means the evals ran.
  const requiredKeyEnv = API_KEY_ENV[model];
  if (route === "api" && !Deno.env.get(requiredKeyEnv)) {
    const message =
      `Skipping ${model} eval: ${requiredKeyEnv} environment variable is not set.`;
    console.warn(message);

    // Write skip status to GitHub Actions summary
    const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
    if (summaryFile) {
      let md = `## Skill Eval Results (${model})\n\n`;
      md += `**Skipped** — \`${requiredKeyEnv}\` not configured.\n`;
      await Deno.writeTextFile(summaryFile, md, { append: true });
    }

    // Exit 0 — missing key is not a failure
    return;
  }

  // Preflight: make a single call to verify access works
  if (route === "cli") await cliPreflightCheck(model);
  else await preflightCheck(model);

  // Install promptfoo dependencies once
  console.log("Installing promptfoo dependencies…");
  try {
    await installPromptfooDeps(configDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }

  // Phase 1: Trigger evals
  console.log(
    `\n━━━ Phase 1: Trigger evals (${model}) ━━━`,
  );
  await regenerateConfig(projectRoot, "generate_config.ts", model, route);
  const triggerData = await runPromptfooEval(
    configDir,
    join(configDir, "results.json"),
    concurrency,
  );
  const triggerResult = summarizePhase("Trigger evals", triggerData, model, route);

  // Phase 2: Routing evals
  console.log(
    `\n━━━ Phase 2: Routing evals (${model}) ━━━`,
  );
  await regenerateConfig(projectRoot, "generate_routing_config.ts", model, route);
  const routingData = await runPromptfooEval(
    configDir,
    join(configDir, "routing_results.json"),
    concurrency,
  );
  const routingResult = summarizePhase(
    "Routing evals",
    routingData,
    model,
    route,
  );

  // Phase 3: Sufficiency evals
  console.log(
    `\n━━━ Phase 3: Sufficiency evals (${model}) ━━━`,
  );
  await regenerateConfig(projectRoot, "generate_sufficiency_config.ts", model, route);
  const sufficiencyData = await runPromptfooEval(
    configDir,
    join(configDir, "sufficiency_results.json"),
    concurrency,
  );
  const sufficiencyResult = summarizePhase(
    "Sufficiency evals",
    sufficiencyData,
    model,
    route,
  );

  // Combined summary
  const totalPassed = triggerResult.passed + routingResult.passed +
    sufficiencyResult.passed;
  const totalTests = triggerResult.total + routingResult.total +
    sufficiencyResult.total;
  const totalCost = triggerResult.cost + routingResult.cost +
    sufficiencyResult.cost;
  const combinedRate = totalPassed / totalTests;

  console.log(`\n━━━ Combined Results (${model}) ━━━`);
  console.log(
    `Overall: ${totalPassed}/${totalTests} passed (${(combinedRate * 100).toFixed(1)}%)`,
  );
  if (route === "api") console.log(`Total cost: $${totalCost.toFixed(2)}`);

  // Write GitHub Actions summary
  const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summaryFile) {
    let md = `## Skill Eval Results (${model})\n\n`;
    md += "| Phase | Passed | Total | Rate | Cost |\n|---|---|---|---|---|\n";
    for (const r of [triggerResult, routingResult, sufficiencyResult]) {
      md +=
        `| ${r.name} | ${r.passed} | ${r.total} | ${(r.rate * 100).toFixed(1)}% | ${
          route === "api" ? `$${r.cost.toFixed(2)}` : "—"
        } |\n`;
    }
    md +=
      `| **Combined** | **${totalPassed}** | **${totalTests}** | **${(combinedRate * 100).toFixed(1)}%** | **${
        route === "api" ? `$${totalCost.toFixed(2)}` : "—"
      }** |\n\n`;
    const resolved = [
      ...new Set([
        ...triggerResult.resolvedModels,
        ...routingResult.resolvedModels,
        ...sufficiencyResult.resolvedModels,
      ]),
    ];
    if (resolved.length > 0) {
      md += `Route: \`${route}\`. Resolved model: ${
        resolved.map((m) => `\`${m}\``).join(", ")
      }.\n\n`;
    }

    const allFailures = [
      ...triggerResult.failures,
      ...routingResult.failures,
      ...sufficiencyResult.failures,
    ];
    if (allFailures.length > 0) {
      md += "### Failed Tests\n\n";
      md += "| Test | Output |\n|---|---|\n";
      for (const f of allFailures) {
        const desc = (f.testCase?.description ?? f.testCase?.vars?.query ??
          "unknown").replace(/\|/g, "\\|");
        const rawOut = f.response?.output ?? f.error ?? "";
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

  // Check threshold against combined rate
  if (combinedRate < passThreshold) {
    console.error(
      `\nFAIL (${model}): Combined pass rate ${(combinedRate * 100).toFixed(1)}% is below ${(passThreshold * 100).toFixed(0)}% threshold`,
    );
    Deno.exit(1);
  }

  console.log(`\nAll skill evals passed for ${model}.`);
}

await main();
